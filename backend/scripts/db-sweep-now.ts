/**
 * One-shot DB hygiene script — safe to run against the live production DB.
 *
 * 1. Backs up parentsync.db → parentsync.db.bak
 * 2. Integrity-checks the backup
 * 3. NULLs embedding + contentHash for messages older than RETENTION_DAYS (default 30)
 * 4. Runs VACUUM to reclaim the freed space
 * 5. Prints before/after sizes
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/db-sweep-now.ts
 *   RETENTION_DAYS=60 npx ts-node -r tsconfig-paths/register scripts/db-sweep-now.ts
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DB_PATH = process.env.DATABASE_URL ||
  path.join(os.homedir(), '.config', 'parentsync', 'parentsync.db');
const BAK_PATH = DB_PATH + '.bak';
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);

function mb(bytes: number) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }
function fileSize(p: string) { try { return fs.statSync(p).size; } catch { return 0; } }

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

const beforeSize = fileSize(DB_PATH);
console.log(`\nDB path    : ${DB_PATH}`);
console.log(`Size before: ${mb(beforeSize)}`);

// Step 1 — backup
console.log(`\n[1/4] Backing up → ${BAK_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
(db.backup(BAK_PATH) as unknown as Promise<void>).then(() => {
  db.close();
  runWithBackup();
}).catch((err: Error) => {
  db.close();
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
});

function runWithBackup() {
  // Step 2 — integrity check
  console.log('[2/4] Integrity check…');
  const db2 = new Database(DB_PATH);
  const { integrity_check } = db2.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (integrity_check !== 'ok') {
    db2.close();
    console.error(`integrity_check FAILED: ${integrity_check}\nAborting — your backup is at ${BAK_PATH}`);
    process.exit(1);
  }
  console.log('       integrity_check: ok');

  // Step 3 — retention sweep
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(`[3/4] Clearing embeddings older than ${RETENTION_DAYS} days (before ${cutoff.toISOString().slice(0,10)})…`);

  const { embBefore } = db2.prepare('SELECT SUM(LENGTH(embedding)) as embBefore FROM messages WHERE embedding IS NOT NULL').get() as { embBefore: number | null };
  const { rowsBefore } = db2.prepare('SELECT COUNT(*) as rowsBefore FROM messages WHERE embedding IS NOT NULL').get() as { rowsBefore: number };

  const stmt = db2.prepare(`
    UPDATE messages SET embedding = NULL, contentHash = NULL
    WHERE timestamp < ? AND embedding IS NOT NULL
  `);
  // TypeORM stores datetime as ISO string, so compare as text
  const result = stmt.run(cutoff.toISOString());
  console.log(`       Cleared: ${result.changes} rows  (freed ~${mb((embBefore ?? 0) * result.changes / (rowsBefore || 1))})`);

  const { embAfter } = db2.prepare('SELECT SUM(LENGTH(embedding)) as embAfter FROM messages WHERE embedding IS NOT NULL').get() as { embAfter: number | null };
  const { rowsAfter } = db2.prepare('SELECT COUNT(*) as rowsAfter FROM messages WHERE embedding IS NOT NULL').get() as { rowsAfter: number };
  console.log(`       Remaining embeddings: ${rowsAfter} rows, ~${mb(embAfter ?? 0)}`);

  // Step 4 — VACUUM
  console.log('[4/4] Running VACUUM (this may take a moment)…');
  db2.exec('VACUUM');
  db2.close();

  const afterSize = fileSize(DB_PATH);
  const saved = beforeSize - afterSize;
  console.log(`\n✓ Done`);
  console.log(`  Size before : ${mb(beforeSize)}`);
  console.log(`  Size after  : ${mb(afterSize)}`);
  console.log(`  Saved       : ${mb(saved)} (${Math.round(saved / beforeSize * 100)}%)`);
  console.log(`  Backup kept : ${BAK_PATH}\n`);
}

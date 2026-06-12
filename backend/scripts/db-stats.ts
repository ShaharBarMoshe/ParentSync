/**
 * Phase 22 — DB storage stats script.
 *
 * Prints per-table row counts + byte estimates and overall file/WAL sizes.
 * No sqlite3 CLI required — uses better-sqlite3 directly.
 *
 * Usage:
 *   npm run db:stats                          # production DB (~/.config/parentsync/parentsync.db)
 *   DATABASE_URL=/path/to/custom.db npm run db:stats
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEFAULT_DB = path.join(os.homedir(), '.config', 'parentsync', 'parentsync.db');
const dbPath = process.env.DATABASE_URL || DEFAULT_DB;
const resolvedPath = path.resolve(dbPath);

if (!fs.existsSync(resolvedPath)) {
  console.error(`DB not found: ${resolvedPath}`);
  process.exit(1);
}

const db = new Database(resolvedPath, { readonly: true });

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

const fileSizeMB = (fileSize(resolvedPath) / 1024 / 1024).toFixed(2);
const walSizeMB  = (fileSize(resolvedPath + '-wal') / 1024 / 1024).toFixed(2);

const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number };
const { page_size }  = db.prepare('PRAGMA page_size').get()  as { page_size: number };
const { freelist_count } = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
const { integrity_check } = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
const { journal_mode }    = db.prepare('PRAGMA journal_mode').get()    as { journal_mode: string };
const { auto_vacuum }     = db.prepare('PRAGMA auto_vacuum').get()     as { auto_vacuum: number };

const usedPages = page_count - freelist_count;
const freeRatio = page_count > 0 ? ((freelist_count / page_count) * 100).toFixed(1) : '0.0';

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log(' ParentSync DB Stats');
console.log('═══════════════════════════════════════════════════');
console.log(` Path         : ${resolvedPath}`);
console.log(` File size    : ${fileSizeMB} MB`);
console.log(` WAL size     : ${walSizeMB} MB`);
console.log(` Page size    : ${page_size} bytes`);
console.log(` Pages total  : ${page_count} (used: ${usedPages}, free: ${freelist_count} = ${freeRatio}%)`);
console.log(` journal_mode : ${journal_mode}`);
console.log(` auto_vacuum  : ${auto_vacuum} (0=NONE 1=FULL 2=INCREMENTAL)`);
console.log(` integrity    : ${integrity_check}`);
console.log('');

const tables: { name: string }[] = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];

const COL_W = 28;
const header = `  ${'Table'.padEnd(COL_W)} ${'Rows'.padStart(8)} ${'Est. bytes'.padStart(14)} ${'Avg row'.padStart(10)}`;
console.log(header);
console.log('  ' + '─'.repeat(header.length - 2));

let grandTotalBytes = 0;
for (const { name } of tables) {
  const { cnt } = db.prepare(`SELECT COUNT(*) as cnt FROM "${name}"`).get() as { cnt: number };
  const cols: { name: string }[] = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
  const colExprs = cols.map((c) => `COALESCE(LENGTH("${c.name}"), 0)`).join(' + ');
  let totalBytes = 0;
  if (colExprs && cnt > 0) {
    const result = db.prepare(`SELECT SUM(${colExprs}) as total FROM "${name}"`).get() as { total: number | null };
    totalBytes = result?.total ?? 0;
  }
  grandTotalBytes += totalBytes;
  const avgRow = cnt > 0 ? Math.round(totalBytes / cnt) : 0;
  console.log(
    `  ${name.padEnd(COL_W)} ${String(cnt).padStart(8)} ${String(totalBytes).padStart(14)} ${String(avgRow + ' B').padStart(10)}`,
  );
}

console.log('  ' + '─'.repeat(header.length - 2));
console.log(`  ${'TOTAL'.padEnd(COL_W)} ${''.padStart(8)} ${String(grandTotalBytes).padStart(14)}`);
console.log('');

// Embedding-specific stats
const embRow = db
  .prepare('SELECT COUNT(*) as cnt, SUM(LENGTH(embedding)) as total FROM messages WHERE embedding IS NOT NULL')
  .get() as { cnt: number; total: number | null };

if (embRow) {
  const embMB = ((embRow.total ?? 0) / 1024 / 1024).toFixed(2);
  const avgEmb = embRow.cnt > 0 ? Math.round((embRow.total ?? 0) / embRow.cnt) : 0;
  console.log(` Embeddings   : ${embRow.cnt} rows, ${embMB} MB total, avg ${avgEmb} B/row`);
  console.log('');
}

db.close();

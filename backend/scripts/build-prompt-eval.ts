/**
 * Phase 24.1 — Build the eval fixture for the prompt-architecture overhaul.
 *
 * Reads `~/.config/parentsync/parentsync.db` (or `--db <path>`) read-only,
 * joins messages with calendar_events to derive ground-truth labels:
 *
 *   - parsed=true, no event row                            → label `[]` (clean negative)
 *   - parsed=true, event with approvalStatus=approved/none → label = the event (positive)
 *   - parsed=true, event with approvalStatus=rejected      → label `[]` (hallucination negative)
 *
 * Stratified sample: balanced across the three buckets and across channels.
 *
 * Writes JSONL to `backend/test/fixtures/prompt-eval.jsonl`. Each line:
 *   {
 *     messageContent: string,
 *     messageDate: string (YYYY-MM-DD, from msg timestamp),
 *     channel: string,
 *     childName?: string,
 *     bucket: 'positive' | 'hallucination' | 'clean',
 *     expected: ParsedEvent[]   // [] for negatives
 *   }
 *
 * PII: senders and message IDs are stripped. Channel + child names stay
 * because they're already user-owned data.
 *
 * Usage:
 *   npx ts-node backend/scripts/build-prompt-eval.ts [--db <path>] [--size 200]
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface MessageRow {
  id: string;
  content: string;
  timestamp: string;
  channel: string;
  childId: string | null;
  parsed: number;
}

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  date: string;
  time: string | null;
  endTime: string | null;
  location: string | null;
  childId: string | null;
  sourceId: string;
  approvalStatus: string;
}

interface ChildRow {
  id: string;
  name: string;
}

interface FixtureLine {
  messageContent: string;
  messageDate: string;
  channel: string;
  childName?: string;
  bucket: 'positive' | 'hallucination' | 'clean';
  expected: Array<{
    title: string;
    date: string;
    time?: string;
    endTime?: string;
    location?: string;
    description?: string;
  }>;
}

const DEFAULT_DB = path.join(os.homedir(), '.config', 'parentsync', 'parentsync.db');
const DEFAULT_OUT = path.join(__dirname, '..', 'test', 'fixtures', 'prompt-eval.jsonl');

function parseArgs(): { dbPath: string; outPath: string; size: number } {
  let dbPath = DEFAULT_DB;
  let outPath = DEFAULT_OUT;
  let size = 200;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outPath = argv[++i];
    } else if (argv[i] === '--size' && argv[i + 1]) {
      size = Number.parseInt(argv[++i], 10);
    }
  }
  return { dbPath, outPath, size };
}

function dateOnly(timestamp: string): string {
  // SQLite stores as "YYYY-MM-DD HH:MM:SS.SSS"
  return timestamp.split(' ')[0];
}

function toExpectedEvent(ev: EventRow): FixtureLine['expected'][number] {
  const out: FixtureLine['expected'][number] = {
    title: ev.title,
    date: ev.date,
  };
  if (ev.time) out.time = ev.time;
  if (ev.endTime) out.endTime = ev.endTime;
  if (ev.location) out.location = ev.location;
  if (ev.description) out.description = ev.description;
  return out;
}

function pickStratified<T>(items: T[], n: number, keyOf: (x: T) => string): T[] {
  // Group by stratification key, take round-robin until we have n items.
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const arr = groups.get(k) ?? [];
    arr.push(item);
    groups.set(k, arr);
  }
  // Shuffle each group for variety.
  for (const arr of groups.values()) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  const out: T[] = [];
  const keys = Array.from(groups.keys());
  let exhausted = false;
  while (out.length < n && !exhausted) {
    exhausted = true;
    for (const k of keys) {
      const arr = groups.get(k)!;
      if (arr.length > 0) {
        out.push(arr.shift()!);
        exhausted = false;
        if (out.length >= n) break;
      }
    }
  }
  return out;
}

function main() {
  const { dbPath, outPath, size } = parseArgs();

  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found at ${dbPath}`);
    process.exit(1);
  }
  console.log(`Reading: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });

  const messages = db
    .prepare(
      `SELECT id, content, timestamp, channel, childId, parsed
       FROM messages
       WHERE parsed = 1 AND content IS NOT NULL AND length(content) > 0
       ORDER BY timestamp DESC`,
    )
    .all() as MessageRow[];

  const events = db
    .prepare(
      `SELECT id, title, description, date, time, endTime, location, childId, sourceId, approvalStatus
       FROM calendar_events
       WHERE sourceId IS NOT NULL`,
    )
    .all() as EventRow[];

  const children = db.prepare('SELECT id, name FROM children').all() as ChildRow[];
  const childName = new Map(children.map((c) => [c.id, c.name]));

  db.close();

  // Index events by sourceId
  const eventsByMsg = new Map<string, EventRow[]>();
  for (const ev of events) {
    const arr = eventsByMsg.get(ev.sourceId) ?? [];
    arr.push(ev);
    eventsByMsg.set(ev.sourceId, arr);
  }

  // Bucket messages
  const positives: FixtureLine[] = [];
  const hallucinations: FixtureLine[] = [];
  const cleans: FixtureLine[] = [];

  for (const msg of messages) {
    // Strip any quoted-reply prefix and sender markers; keep just the content.
    // Production messages are already in clean form (sender field is separate).
    const channel = msg.channel || '(unknown channel)';
    const messageDate = dateOnly(msg.timestamp);
    const child = msg.childId ? childName.get(msg.childId) : undefined;

    const evs = eventsByMsg.get(msg.id) ?? [];
    if (evs.length === 0) {
      cleans.push({
        messageContent: msg.content,
        messageDate,
        channel,
        childName: child,
        bucket: 'clean',
        expected: [],
      });
      continue;
    }
    const allRejected = evs.every((e) => e.approvalStatus === 'rejected');
    if (allRejected) {
      hallucinations.push({
        messageContent: msg.content,
        messageDate,
        channel,
        childName: child,
        bucket: 'hallucination',
        expected: [],
      });
      continue;
    }
    const kept = evs.filter((e) => e.approvalStatus !== 'rejected');
    positives.push({
      messageContent: msg.content,
      messageDate,
      channel,
      childName: child,
      bucket: 'positive',
      expected: kept.map(toExpectedEvent),
    });
  }

  console.log(
    `Buckets — positives: ${positives.length}, hallucinations: ${hallucinations.length}, cleans: ${cleans.length}`,
  );

  // Target distribution: 40% positives, 20% hallucinations, 40% cleans (when available).
  const posTarget = Math.min(positives.length, Math.floor(size * 0.4));
  const halTarget = Math.min(hallucinations.length, Math.floor(size * 0.2));
  const cleanTarget = Math.min(cleans.length, size - posTarget - halTarget);

  const sampled: FixtureLine[] = [
    ...pickStratified(positives, posTarget, (x) => x.channel),
    ...pickStratified(hallucinations, halTarget, (x) => x.channel),
    ...pickStratified(cleans, cleanTarget, (x) => x.channel),
  ];

  // Shuffle final order so buckets are intermixed.
  for (let i = sampled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sampled[i], sampled[j]] = [sampled[j], sampled[i]];
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = sampled.map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(outPath, out + '\n', 'utf8');

  console.log(`Wrote ${sampled.length} lines to ${outPath}`);
  console.log(
    `Distribution — positives: ${sampled.filter((l) => l.bucket === 'positive').length}, ` +
      `hallucinations: ${sampled.filter((l) => l.bucket === 'hallucination').length}, ` +
      `cleans: ${sampled.filter((l) => l.bucket === 'clean').length}`,
  );
}

main();

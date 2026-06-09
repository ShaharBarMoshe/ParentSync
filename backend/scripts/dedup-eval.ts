/**
 * Phase 20.9.2/20.9.3 — Offline eval for the message-dedup pipeline.
 *
 * Loads `test/fixtures/dedup-pairs.jsonl`, embeds each text via Gemini's
 * `text-embedding-004`, and sweeps thresholds 0.80 → 0.99 for each of four
 * "embedding input" variants (content-only, +sender, +channel, +sender+first-line).
 *
 * Reports precision / recall / F1 per (threshold, variant), and recommends
 * the highest threshold that meets the **precision ≥ 0.98** floor — falling
 * back to "best F1" with a warning if no threshold qualifies.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx ts-node backend/scripts/dedup-eval.ts \
 *     backend/test/fixtures/dedup-pairs.jsonl
 */
import { promises as fs } from 'fs';
import { GoogleGenAI } from '@google/genai';
import { cosineSimilarity } from '../src/shared/utils/cosine-similarity';

interface Pair {
  a: string;
  b: string;
  /** Optional metadata to drive the input variants. */
  aSender?: string;
  bSender?: string;
  aChannel?: string;
  bChannel?: string;
  isDuplicate: boolean;
  category: string;
}

type InputVariant =
  | 'content'
  | 'content+sender'
  | 'content+channel'
  | 'content+sender+title';

const VARIANTS: InputVariant[] = [
  'content',
  'content+sender',
  'content+channel',
  'content+sender+title',
];

const PRECISION_FLOOR = 0.98;

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('usage: dedup-eval.ts <path/to/dedup-pairs.jsonl>');
    process.exit(1);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is required');
    process.exit(1);
  }

  const lines = (await fs.readFile(fixturePath, 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'));
  const pairs: Pair[] = lines.map((l) => JSON.parse(l));
  console.log(`Loaded ${pairs.length} pairs`);

  const client = new GoogleGenAI({ apiKey });

  for (const variant of VARIANTS) {
    console.log(`\n=== variant: ${variant} ===`);
    const sims: number[] = [];
    const labels: boolean[] = [];
    const cats: string[] = [];
    for (const pair of pairs) {
      const a = renderInput(pair, 'a', variant);
      const b = renderInput(pair, 'b', variant);
      const [eA, eB] = await embedBoth(client, a, b);
      sims.push(cosineSimilarity(eA, eB));
      labels.push(pair.isDuplicate);
      cats.push(pair.category);
    }
    reportSweep(sims, labels, cats);
  }
}

function renderInput(pair: Pair, side: 'a' | 'b', variant: InputVariant): string {
  const text = pair[side];
  const sender = pair[`${side}Sender` as 'aSender' | 'bSender'] ?? '';
  const channel = pair[`${side}Channel` as 'aChannel' | 'bChannel'] ?? '';
  const firstLine = text.split('\n')[0].slice(0, 80);
  switch (variant) {
    case 'content':
      return text;
    case 'content+sender':
      return `${sender}\n${text}`;
    case 'content+channel':
      return `${channel}\n${text}`;
    case 'content+sender+title':
      return `${sender}\n[${firstLine}]\n${text}`;
  }
}

async function embedBoth(
  client: GoogleGenAI,
  a: string,
  b: string,
): Promise<[number[], number[]]> {
  const [ra, rb] = await Promise.all([
    client.models.embedContent({ model: 'text-embedding-004', contents: a }),
    client.models.embedContent({ model: 'text-embedding-004', contents: b }),
  ]);
  return [ra.embeddings![0].values!, rb.embeddings![0].values!];
}

function reportSweep(sims: number[], labels: boolean[], cats: string[]) {
  const rows: { threshold: number; precision: number; recall: number; f1: number }[] = [];
  for (let t = 0.8; t <= 0.99; t += 0.01) {
    const threshold = +t.toFixed(2);
    let tp = 0,
      fp = 0,
      fn = 0;
    for (let i = 0; i < sims.length; i++) {
      const pred = sims[i] >= threshold;
      if (pred && labels[i]) tp++;
      else if (pred && !labels[i]) fp++;
      else if (!pred && labels[i]) fn++;
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    rows.push({ threshold, precision, recall, f1 });
  }

  console.log('thr   prec  rec   f1');
  for (const r of rows) {
    console.log(
      `${r.threshold.toFixed(2)}  ${r.precision.toFixed(3)} ${r.recall.toFixed(3)} ${r.f1.toFixed(3)}`,
    );
  }

  // Category breakdown at recommended threshold
  const qualifying = rows.filter((r) => r.precision >= PRECISION_FLOOR);
  let recommended: typeof rows[number];
  if (qualifying.length > 0) {
    recommended = qualifying.reduce((best, r) => (r.threshold > best.threshold ? r : best));
    console.log(
      `\nRecommended threshold (highest at precision ≥ ${PRECISION_FLOOR}): ${recommended.threshold} (prec=${recommended.precision.toFixed(3)}, rec=${recommended.recall.toFixed(3)}, f1=${recommended.f1.toFixed(3)})`,
    );
  } else {
    recommended = rows.reduce((best, r) => (r.f1 > best.f1 ? r : best));
    console.warn(
      `\nNo threshold met the precision ≥ ${PRECISION_FLOOR} floor. Falling back to best-F1 = ${recommended.threshold} (prec=${recommended.precision.toFixed(3)}, rec=${recommended.recall.toFixed(3)}, f1=${recommended.f1.toFixed(3)})`,
    );
  }

  const byCat: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (let i = 0; i < sims.length; i++) {
    const cat = cats[i];
    if (!byCat[cat]) byCat[cat] = { tp: 0, fp: 0, fn: 0 };
    const pred = sims[i] >= recommended.threshold;
    if (pred && labels[i]) byCat[cat].tp++;
    else if (pred && !labels[i]) byCat[cat].fp++;
    else if (!pred && labels[i]) byCat[cat].fn++;
  }
  console.log('\nPer-category at recommended threshold:');
  for (const [cat, counts] of Object.entries(byCat)) {
    console.log(`  ${cat}: tp=${counts.tp} fp=${counts.fp} fn=${counts.fn}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Phase 24.2 — Eval harness for the prompt architecture overhaul.
 *
 * Runs the chosen pipeline against `test/fixtures/prompt-eval.jsonl` and
 * reports precision, recall, token usage, and a per-bucket failure breakdown.
 *
 * Modes:
 *   --mode=current      Old single-stage prompt (DEFAULT_SYSTEM_PROMPT) only.
 *                       Use this for the baseline.
 *   --mode=classifier   Classifier-only. Each line is classified;
 *                       prediction = YES → [event placeholder] else [].
 *                       Use this to inspect the classifier in isolation.
 *   --mode=two-stage    Full new pipeline: classifier → (if YES) extractor.
 *                       Use this for the comparison.
 *
 * Output: a markdown table written to stdout. Pass --out <path> to also
 * write to a file.
 *
 * Cost: every line spends 1 classifier call (modes classifier/two-stage)
 * plus optionally 1 extractor call (modes current/two-stage with YES).
 * A 50-line fixture in two-stage mode therefore burns ~50 classifier calls
 * + ~20 extractor calls = ~70 calls. Mind your Gemini quota.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx ts-node backend/scripts/prompt-eval.ts \
 *     --mode=current --out plan/phase24-baseline.md
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_SYSTEM_PROMPT } from '../src/llm/services/default-system-prompt';
import { DEFAULT_CLASSIFIER_PROMPT } from '../src/llm/services/default-classifier-prompt';

type Bucket = 'positive' | 'hallucination' | 'clean';
type Mode = 'current' | 'classifier' | 'two-stage';

interface FixtureLine {
  messageContent: string;
  messageDate: string;
  channel: string;
  childName?: string;
  bucket: Bucket;
  expected: Array<{
    title: string;
    date: string;
    time?: string;
    endTime?: string;
    location?: string;
    description?: string;
  }>;
}

interface EvalResult {
  bucket: Bucket;
  expected: FixtureLine['expected'];
  predicted: FixtureLine['expected'];
  classifierVerdict?: { isEvent: boolean; reason: string };
  tokensIn: number;
  latencyMs: number;
  failure?: string;
}

interface Metrics {
  total: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  avgTokensIn: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  perBucketFP: Record<Bucket, number>;
  perBucketFN: Record<Bucket, number>;
}

function parseArgs(): { mode: Mode; fixturePath: string; outPath?: string; limit: number; model: string } {
  let mode: Mode = 'current';
  let fixturePath = path.join(__dirname, '..', 'test', 'fixtures', 'prompt-eval.jsonl');
  let outPath: string | undefined;
  let limit = Infinity;
  let model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--mode=')) mode = argv[i].slice('--mode='.length) as Mode;
    else if (argv[i] === '--fixture' && argv[i + 1]) fixturePath = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) outPath = argv[++i];
    else if (argv[i] === '--limit' && argv[i + 1]) limit = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--model' && argv[i + 1]) model = argv[++i];
  }
  return { mode, fixturePath, outPath, limit, model };
}

function getApiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const dbPath = path.join(os.homedir(), '.config', 'parentsync', 'parentsync.db');
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM user_settings WHERE key='gemini_api_key'").get() as { value: string } | undefined;
    db.close();
    if (row?.value) return row.value;
  }
  console.error('No GEMINI_API_KEY in env or DB');
  process.exit(1);
}

function approxTokens(s: string): number {
  // Conservative approximation. Gemini tokenization is similar to GPT — ~4 chars / token
  // on Latin script; Hebrew is closer to ~2 chars / token. Use the smaller divisor
  // to stay on the safe side.
  return Math.ceil(s.length / 3);
}

function loadFixture(p: string, limit: number): FixtureLine[] {
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.split('\n').filter((l) => l.trim().length > 0);
  const items = lines.map((l) => JSON.parse(l) as FixtureLine);
  return items.slice(0, limit);
}

async function callExtractor(client: GoogleGenAI, model: string, prompt: string, message: string, date: string): Promise<{ response: string; tokens: number; latencyMs: number }> {
  const userMessage = `Current date: ${date}\n\nMessage to parse:\n${message}`;
  const tokens = approxTokens(prompt + userMessage);
  const start = Date.now();
  const result = await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: { systemInstruction: prompt, temperature: 0 },
  });
  return {
    response: result.text ?? '',
    tokens,
    latencyMs: Date.now() - start,
  };
}

async function callClassifier(client: GoogleGenAI, model: string, message: string, date: string): Promise<{ isEvent: boolean; reason: string; tokens: number; latencyMs: number }> {
  const userMessage = `Current date: ${date}\n\n${message}`;
  const tokens = approxTokens(DEFAULT_CLASSIFIER_PROMPT + userMessage);
  const start = Date.now();
  const result = await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: { systemInstruction: DEFAULT_CLASSIFIER_PROMPT, temperature: 0 },
  });
  const latencyMs = Date.now() - start;
  const text = (result.text ?? '').trim();
  const firstLine = text.split('\n')[0].trim();
  const m = firstLine.match(/^(YES|NO)\b\s*[—\-–:]?\s*(.*)$/i);
  if (!m) {
    return { isEvent: true, reason: 'unparseable', tokens, latencyMs };
  }
  return {
    isEvent: m[1].toUpperCase() === 'YES',
    reason: (m[2] || '').trim().slice(0, 80),
    tokens,
    latencyMs,
  };
}

function parseExtractorOutput(response: string): FixtureLine['expected'] {
  if (!response) return [];
  const trimmed = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((e) => e && typeof e === 'object' && e.title);
    if (parsed && typeof parsed === 'object') {
      const values = Object.values(parsed);
      const arr = values.flatMap((v) => (Array.isArray(v) ? v : []));
      return arr.filter((e) => e && typeof e === 'object' && (e as any).title);
    }
  } catch {
    /* fall through */
  }
  return [];
}

function compareEvents(expected: FixtureLine['expected'], predicted: FixtureLine['expected']): boolean {
  // Match policy: events must agree on (title, date). Time/location/description
  // are bonus precision wins; not graded here to keep the metric stable across
  // prompt variants.
  if (expected.length === 0 && predicted.length === 0) return true;
  if (expected.length === 0 || predicted.length === 0) return false;
  // Order-insensitive match by (date, normalized title fragments).
  const keysExp = new Set(expected.map((e) => `${e.date}|${e.title.trim().toLowerCase()}`));
  const keysPred = new Set(predicted.map((e) => `${e.date}|${e.title.trim().toLowerCase()}`));
  // Approximate match: every expected key has a predicted entry on the same date
  // with overlapping title tokens.
  for (const exp of expected) {
    const expTokens = exp.title.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const found = predicted.some((p) => {
      if (p.date !== exp.date) return false;
      const pTokens = p.title.toLowerCase().split(/\s+/);
      return expTokens.some((t) => pTokens.some((pt) => pt.includes(t) || t.includes(pt)));
    });
    if (!found) return false;
  }
  return keysExp.size === keysPred.size || predicted.length === expected.length;
}

async function runLine(client: GoogleGenAI, model: string, mode: Mode, line: FixtureLine): Promise<EvalResult> {
  let predicted: FixtureLine['expected'] = [];
  let tokensIn = 0;
  let latencyMs = 0;
  let classifierVerdict: EvalResult['classifierVerdict'];
  let failure: string | undefined;

  try {
    if (mode === 'current') {
      const { response, tokens, latencyMs: latency } = await callExtractor(
        client, model, DEFAULT_SYSTEM_PROMPT, line.messageContent, line.messageDate,
      );
      predicted = parseExtractorOutput(response);
      tokensIn = tokens;
      latencyMs = latency;
    } else if (mode === 'classifier') {
      const v = await callClassifier(client, model, line.messageContent, line.messageDate);
      classifierVerdict = { isEvent: v.isEvent, reason: v.reason };
      predicted = v.isEvent ? line.expected : []; // assume oracle extractor
      tokensIn = v.tokens;
      latencyMs = v.latencyMs;
    } else {
      const v = await callClassifier(client, model, line.messageContent, line.messageDate);
      classifierVerdict = { isEvent: v.isEvent, reason: v.reason };
      tokensIn = v.tokens;
      latencyMs = v.latencyMs;
      if (v.isEvent) {
        const { response, tokens, latencyMs: latency } = await callExtractor(
          client, model, DEFAULT_SYSTEM_PROMPT, line.messageContent, line.messageDate,
        );
        predicted = parseExtractorOutput(response);
        tokensIn += tokens;
        latencyMs += latency;
      }
    }
  } catch (err) {
    failure = (err as Error).message;
  }

  return { bucket: line.bucket, expected: line.expected, predicted, classifierVerdict, tokensIn, latencyMs, failure };
}

function computeMetrics(results: EvalResult[]): Metrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const perBucketFP: Record<Bucket, number> = { positive: 0, hallucination: 0, clean: 0 };
  const perBucketFN: Record<Bucket, number> = { positive: 0, hallucination: 0, clean: 0 };
  const tokens: number[] = [];
  const latencies: number[] = [];

  for (const r of results) {
    if (r.failure) continue;
    const expectedHasEvent = r.expected.length > 0;
    const predictedHasEvent = r.predicted.length > 0;
    const matches = compareEvents(r.expected, r.predicted);

    if (expectedHasEvent && predictedHasEvent && matches) tp++;
    else if (!expectedHasEvent && !predictedHasEvent) tn++;
    else if (!expectedHasEvent && predictedHasEvent) { fp++; perBucketFP[r.bucket]++; }
    else if (expectedHasEvent && !predictedHasEvent) { fn++; perBucketFN[r.bucket]++; }
    else if (expectedHasEvent && predictedHasEvent && !matches) {
      // Predicted something but wrong → count as both FP and FN.
      fp++; fn++;
      perBucketFP[r.bucket]++;
      perBucketFN[r.bucket]++;
    }
    tokens.push(r.tokensIn);
    latencies.push(r.latencyMs);
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const avgTokensIn = tokens.length ? tokens.reduce((s, n) => s + n, 0) / tokens.length : 0;
  const sortedL = latencies.slice().sort((a, b) => a - b);
  const p50 = sortedL[Math.floor(sortedL.length * 0.5)] ?? 0;
  const p95 = sortedL[Math.floor(sortedL.length * 0.95)] ?? 0;

  return {
    total: results.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision,
    recall,
    avgTokensIn,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    perBucketFP,
    perBucketFN,
  };
}

function formatReport(mode: Mode, metrics: Metrics, results: EvalResult[]): string {
  const lines: string[] = [];
  lines.push(`# Prompt eval — mode: ${mode}`);
  lines.push('');
  lines.push(`- Fixture size: **${metrics.total}**`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Confusion matrix');
  lines.push('');
  lines.push('| | Expected event | Expected [] |');
  lines.push('|---|---:|---:|');
  lines.push(`| Predicted event | ${metrics.truePositives} (TP) | ${metrics.falsePositives} (FP) |`);
  lines.push(`| Predicted []    | ${metrics.falseNegatives} (FN) | ${metrics.trueNegatives} (TN) |`);
  lines.push('');
  lines.push('## Headline metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Precision | ${metrics.precision.toFixed(3)} |`);
  lines.push(`| Recall    | ${metrics.recall.toFixed(3)} |`);
  lines.push(`| Avg input tokens / parse | ${metrics.avgTokensIn.toFixed(0)} |`);
  lines.push(`| Latency p50 (ms) | ${metrics.p50LatencyMs.toFixed(0)} |`);
  lines.push(`| Latency p95 (ms) | ${metrics.p95LatencyMs.toFixed(0)} |`);
  lines.push('');
  lines.push('## Failures by bucket');
  lines.push('');
  lines.push('| Bucket | FP | FN |');
  lines.push('|---|---:|---:|');
  for (const b of ['positive', 'hallucination', 'clean'] as Bucket[]) {
    lines.push(`| ${b} | ${metrics.perBucketFP[b]} | ${metrics.perBucketFN[b]} |`);
  }
  lines.push('');
  const errors = results.filter((r) => r.failure);
  if (errors.length > 0) {
    lines.push('## Run errors');
    lines.push('');
    for (const e of errors.slice(0, 10)) {
      lines.push(`- bucket=${e.bucket}: ${e.failure}`);
    }
    if (errors.length > 10) lines.push(`- ... and ${errors.length - 10} more`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const { mode, fixturePath, outPath, limit, model } = parseArgs();
  const apiKey = getApiKey();
  const client = new GoogleGenAI({ apiKey });

  const fixture = loadFixture(fixturePath, limit);
  console.log(`Loaded ${fixture.length} fixture lines from ${fixturePath}`);
  console.log(`Mode: ${mode}, Model: ${model}`);

  const results: EvalResult[] = [];
  for (let i = 0; i < fixture.length; i++) {
    const line = fixture[i];
    const result = await runLine(client, model, mode, line);
    results.push(result);
    if ((i + 1) % 10 === 0 || i === fixture.length - 1) {
      console.log(`Progress: ${i + 1}/${fixture.length}`);
    }
  }

  const metrics = computeMetrics(results);
  const report = formatReport(mode, metrics, results);
  console.log('\n' + report);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, 'utf8');
    console.log(`Wrote: ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

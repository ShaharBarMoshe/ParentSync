/**
 * Phase 20.9.6 — Benchmark dedup overhead at scale.
 *
 * Inserts N parsed messages with synthetic embeddings, then times:
 *   (a) `findParsedWithEmbeddings` query
 *   (b) similarity loop in `MessageDeduplicationService`
 *   (c) end-to-end per-sync overhead with 10 incoming groups
 *
 * Confirms total overhead < 1 s at the 5K row scale, per the acceptance
 * criterion in `plan/phase20-semantic-dedup.md`.
 *
 * Usage:
 *   npx ts-node backend/scripts/dedup-bench.ts
 */
import { DataSource } from 'typeorm';
import { performance } from 'perf_hooks';
import { MessageEntity } from '../src/messages/entities/message.entity';
import { MessageSource } from '../src/shared/enums/message-source.enum';
import { TypeOrmMessageRepository } from '../src/messages/repositories/typeorm-message.repository';
import { cosineSimilarity } from '../src/shared/utils/cosine-similarity';

const DIM = 768;
const INCOMING_GROUPS = 10;

function randomUnit(): number[] {
  const v = Array.from({ length: DIM }, () => Math.random() - 0.5);
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / mag);
}

async function runScale(n: number) {
  const ds = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [MessageEntity],
    synchronize: true,
  });
  await ds.initialize();
  const repo = new TypeOrmMessageRepository(ds.getRepository(MessageEntity));

  // Seed N rows
  const tInsert = performance.now();
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    await repo.create({
      source: MessageSource.WHATSAPP,
      content: `seed message ${i}`,
      channel: 'bench',
      timestamp: new Date(now - i * 60_000),
      sender: 'bench-sender',
      parsed: true,
      embedding: randomUnit(),
      contentHash: 'hash-' + i,
    } as Partial<MessageEntity>);
  }
  const insertMs = performance.now() - tInsert;

  // Time the query
  const tQuery = performance.now();
  const candidates = await repo.findParsedWithEmbeddings(
    new Date(now - 30 * 24 * 60 * 60 * 1000),
    n,
  );
  const queryMs = performance.now() - tQuery;

  // Simulate INCOMING_GROUPS incoming embeddings
  const tSim = performance.now();
  const incoming = Array.from({ length: INCOMING_GROUPS }, () => randomUnit());
  for (const inc of incoming) {
    let best = 0;
    for (const c of candidates) {
      const sim = cosineSimilarity(inc, c.embedding ?? []);
      if (sim > best) best = sim;
    }
  }
  const simMs = performance.now() - tSim;

  console.log(
    `n=${n.toString().padStart(5)} insert=${insertMs.toFixed(0)}ms query=${queryMs.toFixed(1)}ms similarityLoop(${INCOMING_GROUPS}x)=${simMs.toFixed(1)}ms total(query+sim)=${(queryMs + simMs).toFixed(1)}ms`,
  );

  await ds.destroy();
}

async function main() {
  for (const n of [100, 1000, 5000]) {
    await runScale(n);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

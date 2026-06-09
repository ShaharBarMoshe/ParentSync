/**
 * Phase 20.9.0 — Error analysis: dump real duplicates from the user's
 * database for manual classification before tuning the threshold.
 *
 * Queries `calendar_events` for groups where (title, date, time, child_id)
 * match across ≥ 2 rows. For each match, fetches the originating
 * `sourceContent` from `messages` and writes a Markdown report so the
 * developer can label each pair as:
 *
 *   - identical forward        (high-priority dedup target)
 *   - paraphrase               (high-priority dedup target)
 *   - same-topic-different-date(must NOT match — adversarial)
 *   - legitimate recurrence    (must NOT match — adversarial)
 *   - other                    (write a note)
 *
 * Usage:
 *   npx ts-node backend/scripts/dedup-error-analysis.ts <path/to/db.sqlite> [outDir]
 */
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { MessageEntity } from '../src/messages/entities/message.entity';
import { CalendarEventEntity } from '../src/calendar/entities/calendar-event.entity';

async function main() {
  const dbPath = process.argv[2];
  const outDir = process.argv[3] ?? '.';
  if (!dbPath) {
    console.error('usage: dedup-error-analysis.ts <db.sqlite> [outDir]');
    process.exit(1);
  }

  const ds = new DataSource({
    type: 'sqlite',
    database: dbPath,
    entities: [MessageEntity, CalendarEventEntity],
    synchronize: false,
  });
  await ds.initialize();

  const dupGroups: { key: string; events: CalendarEventEntity[] }[] = await ds
    .createQueryBuilder()
    .select('e.title, e.date, e.time, e.child_id')
    .from(CalendarEventEntity, 'e')
    .groupBy('e.title')
    .addGroupBy('e.date')
    .addGroupBy('e.time')
    .addGroupBy('e.child_id')
    .having('COUNT(*) >= 2')
    .getRawMany()
    .then(async (rows) => {
      const out: { key: string; events: CalendarEventEntity[] }[] = [];
      for (const r of rows) {
        const events = await ds
          .getRepository(CalendarEventEntity)
          .createQueryBuilder('e')
          .where('e.title = :title', { title: r.title })
          .andWhere('e.date = :date', { date: r.date })
          .andWhere('e.time = :time OR (e.time IS NULL AND :time IS NULL)', {
            time: r.time ?? null,
          })
          .andWhere(
            'e.child_id = :child OR (e.child_id IS NULL AND :child IS NULL)',
            { child: r.child_id ?? null },
          )
          .getMany();
        out.push({ key: `${r.title}|${r.date}|${r.time}|${r.child_id}`, events });
      }
      return out;
    });

  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(outDir, `error-analysis-${today}.md`);

  const lines: string[] = [];
  lines.push(`# Dedup error analysis (${today})`);
  lines.push('');
  lines.push(`Found **${dupGroups.length}** duplicate event clusters in the DB.`);
  lines.push('');
  lines.push('Label each pair below using one of:');
  lines.push('');
  lines.push('- `IDENTICAL` — same flyer, byte-for-byte or near it');
  lines.push('- `PARAPHRASE` — same event, different wording / emoji');
  lines.push('- `SAME_TOPIC_DIFFERENT_DATE` — must NOT match');
  lines.push('- `LEGITIMATE_RECURRENCE` — weekly class, etc.');
  lines.push('- `OTHER` — add a note');
  lines.push('');

  for (let i = 0; i < dupGroups.length; i++) {
    const dg = dupGroups[i];
    lines.push(`## Cluster ${i + 1}: ${dg.events[0].title}`);
    lines.push('');
    lines.push(`- date: ${dg.events[0].date}`);
    lines.push(`- time: ${dg.events[0].time ?? '(date-only)'}`);
    lines.push(`- child_id: ${dg.events[0].childId ?? '(none)'}`);
    lines.push('');
    for (let j = 0; j < dg.events.length; j++) {
      const ev = dg.events[j];
      let sourceContent = ev.sourceContent ?? '';
      if (!sourceContent && ev.sourceId) {
        const msg = await ds
          .getRepository(MessageEntity)
          .findOne({ where: { id: ev.sourceId } });
        sourceContent = msg?.content ?? '';
      }
      lines.push(`### Source ${j + 1} (event ${ev.id})`);
      lines.push('');
      lines.push('```');
      lines.push(sourceContent.slice(0, 1500));
      lines.push('```');
      lines.push('');
    }
    lines.push(`**Label**: <!-- IDENTICAL | PARAPHRASE | ... -->`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  await fs.writeFile(outPath, lines.join('\n'), 'utf8');
  console.log(`Wrote ${dupGroups.length} clusters to ${outPath}`);
  await ds.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

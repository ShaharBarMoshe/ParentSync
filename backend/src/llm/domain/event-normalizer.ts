import type { ParsedEvent, EventAction } from '../dto/parsed-event.dto';

/**
 * Domain normalization for extracted events. Pure: no I/O, no framework, no
 * provider.
 *
 * Structured output guarantees the *shape* of what the model returns — it says
 * nothing about whether `date` is a real date, whether `endTime` is after
 * `time`, or whether one gathering came back described three ways. Those are
 * domain rules, and they are the difference between a correct family calendar
 * and a plausible-looking wrong one. They live here so that swapping the
 * extraction mechanism can never quietly take them with it.
 *
 * Deliberately still accepts `unknown[]`. The extractor upstream is schema-
 * enforced now, but a model that satisfies a schema can still return
 * `date: "next tuesday"`, and this is the layer that says no.
 */

/** Just enough of a logger to explain a dropped field; easy to stub in tests. */
export interface NormalizerLog {
  debug(message: string): void;
  log(message: string): void;
}

const NO_OP_LOG: NormalizerLog = { debug: () => {}, log: () => {} };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Accepts an endTime only when it is a well-formed HH:MM strictly later than
 * the start time. Drops it silently otherwise rather than rejecting the whole
 * event — the rest of the parse is still worth keeping.
 */
export function normalizeEndTime(
  raw: unknown,
  time: string | undefined,
  log: NormalizerLog = NO_OP_LOG,
): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'string') return undefined;
  if (!raw.match(TIME_RE)) {
    log.debug(`Dropping malformed endTime "${String(raw)}"`);
    return undefined;
  }
  if (!time) {
    log.debug(`Dropping endTime "${raw}" — start time missing`);
    return undefined;
  }
  if (raw <= time) {
    log.debug(`Dropping endTime "${raw}" — not after start time "${time}"`);
    return undefined;
  }
  return raw;
}

/**
 * Drop events that cannot be trusted, and coerce the survivors into
 * `ParsedEvent`.
 *
 * A missing or non-ISO `date` is fatal for a `create`, but not for a
 * `cancel`/`delay`: those may legitimately arrive with `date: ""` when the
 * message names the event to cancel without repeating when it was.
 */
export function validateEvents(
  events: unknown[],
  log: NormalizerLog = NO_OP_LOG,
): ParsedEvent[] {
  return events
    .filter((event): event is Record<string, unknown> => {
      if (typeof event !== 'object' || event === null) return false;
      const e = event as Record<string, unknown>;
      if (typeof e.title !== 'string' || !e.title.trim()) return false;

      const action = typeof e.action === 'string' ? e.action : 'create';
      const isDismissal = action === 'cancel' || action === 'delay';

      if (typeof e.date !== 'string') return false;
      if (!isDismissal && !e.date.match(DATE_RE)) return false;
      if (isDismissal && e.date !== '' && !e.date.match(DATE_RE)) return false;

      if (e.time && (typeof e.time !== 'string' || !e.time.match(TIME_RE)))
        return false;
      // endTime is dropped rather than rejected — see normalizeEndTime.
      if (
        e.newDate &&
        (typeof e.newDate !== 'string' || !e.newDate.match(DATE_RE))
      )
        return false;
      if (
        e.newTime &&
        (typeof e.newTime !== 'string' || !e.newTime.match(TIME_RE))
      )
        return false;
      if (e.action && !['create', 'cancel', 'delay'].includes(String(e.action)))
        return false;
      return true;
    })
    .map((event) => {
      const time = event.time ? String(event.time) : undefined;
      return {
        title: String(event.title).trim(),
        description: event.description
          ? String(event.description).trim()
          : undefined,
        date: String(event.date),
        time,
        endTime: normalizeEndTime(event.endTime, time, log),
        location: event.location ? String(event.location).trim() : undefined,
        action: ['cancel', 'delay'].includes(String(event.action))
          ? (String(event.action) as EventAction)
          : undefined,
        originalTitle: event.originalTitle
          ? String(event.originalTitle).trim()
          : undefined,
        newDate: event.newDate ? String(event.newDate) : undefined,
        newTime: event.newTime ? String(event.newTime) : undefined,
      };
    });
}

/**
 * Enforce the single-gathering rule deterministically: several `create` events
 * sharing (title, date, location, description) but differing in time are one
 * gathering described from several angles ("arrive at 17:00, party 17:30–18:00"),
 * and must not become several approval messages.
 *
 * Layer 3 (the LLM duplicate judge) catches the same case afterwards, but it
 * fails open on quota errors. This is the cheap deterministic net that runs
 * before any DB write.
 *
 * Cancel/delay events never merge — their semantics differ.
 * Tie-break for which survives: (time + endTime) > (time) > (all-day).
 */
export function collapseSingleGathering(
  events: ParsedEvent[],
  log: NormalizerLog = NO_OP_LOG,
): ParsedEvent[] {
  if (events.length <= 1) return events;
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  const groups = new Map<string, ParsedEvent[]>();

  for (const event of events) {
    if (event.action === 'cancel' || event.action === 'delay') {
      // Keyed uniquely so action events never merge with anything.
      groups.set(`__action_${groups.size}`, [event]);
      continue;
    }
    const key = [
      norm(event.title),
      event.date,
      norm(event.location),
      norm(event.description),
    ].join('|');
    const bucket = groups.get(key) ?? [];
    bucket.push(event);
    groups.set(key, bucket);
  }

  const score = (e: ParsedEvent): number =>
    (e.time ? 1 : 0) + (e.endTime ? 1 : 0);

  const collapsed: ParsedEvent[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      collapsed.push(group[0]);
      continue;
    }
    const best = group.reduce((w, c) => (score(c) > score(w) ? c : w));
    log.log(
      `Single-gathering collapse: ${group.length} events → 1 for "${best.title}" on ${best.date}`,
    );
    collapsed.push(best);
  }
  return collapsed;
}

/** The full domain pass applied to one group's extraction output. */
export function normalizeEvents(
  raw: unknown[],
  log: NormalizerLog = NO_OP_LOG,
): ParsedEvent[] {
  return collapseSingleGathering(validateEvents(raw, log), log);
}

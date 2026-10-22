import { Annotation } from '@langchain/langgraph';
import type { MessageEntity } from '../../messages/entities/message.entity';
import type { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import type { ParsedEvent } from '../../llm/dto/parsed-event.dto';
import type { DedupResult } from '../services/message-deduplication.service';

/** One channel-and-time-proximate cluster of messages, with its parse context. */
export interface GroupMeta {
  group: MessageEntity[];
  childName?: string;
  childId?: string;
  calendarColorId?: string;
  mergedContent: string;
  mergedImages: { mimeType: string; data: string }[];
  /** Date context so relative dates ("tomorrow") resolve as the sender meant. */
  messageDate: string;
  dedup?: DedupResult;
}

/** A cancel/delay instruction, with the context needed to apply it. */
export interface PendingDismissal {
  event: ParsedEvent;
  childId?: string;
  childName?: string;
  messageId: string;
}

export interface SyncCounters {
  messagesParsed: number;
  messagesFailed: number;
  eventsCreated: number;
  eventsSynced: number;
}

/** Last-write-wins: each node owns the fields it sets. */
const replace = <T>(defaultValue: () => T) => ({
  reducer: (_prev: T, next: T) => next,
  default: defaultValue,
});

/**
 * State threaded through the event-sync graph.
 *
 * Deliberately holds only what crosses a node boundary. Database handles never
 * appear here: a `QueryRunner` held across an edge would keep a SQLite write
 * transaction open while the graph runtime awaits, which is how the whole file
 * ends up locked. Transactions open and commit inside a single node.
 *
 * Written with `Annotation.Root` rather than LangGraph v1's `StateSchema`. The
 * two are equivalent for our purposes and `StateSchema` is the newer idiom, but
 * it wants a zod schema per channel — and half of these channels hold TypeORM
 * entities and a `Map`, which would come out as `z.custom<T>()`: zod as
 * paperwork, validating nothing. That trade only pays for its keystrokes when a
 * checkpointer serializes the state, and this graph deliberately has none (see
 * `event-sync.graph.ts`).
 */
export const EventSyncStateAnnotation = Annotation.Root({
  /** Every message group in this pass, in discovery order. */
  groups: Annotation<GroupMeta[]>(replace<GroupMeta[]>(() => [])),

  /** Indices into `groups` that survived the semantic dedup pre-filter. */
  freshIndices: Annotation<number[]>(replace<number[]>(() => [])),

  /** Indices into `groups` that matched an already-seen message. */
  duplicateIndices: Annotation<number[]>(replace<number[]>(() => [])),

  /** Extraction output, keyed by the group's index within `freshIndices`. */
  parsed: Annotation<Map<string, ParsedEvent[]>>(
    replace<Map<string, ParsedEvent[]>>(() => new Map()),
  ),

  /** Events persisted this pass. */
  savedEvents: Annotation<CalendarEventEntity[]>(
    replace<CalendarEventEntity[]>(() => []),
  ),

  /** Those that survived screening and should get an approval card. */
  approvalCandidates: Annotation<CalendarEventEntity[]>(
    replace<CalendarEventEntity[]>(() => []),
  ),

  /** Cancel/delay instructions extracted this pass, applied after approval. */
  dismissals: Annotation<PendingDismissal[]>(
    replace<PendingDismissal[]>(() => []),
  ),

  /** True when approval is configured; decides whether screening runs at all. */
  approvalEnabled: Annotation<boolean>(replace<boolean>(() => false)),

  /**
   * Set when the LLM account runs out of credit mid-pass. Fresh groups are
   * then left unparsed rather than marked done, so the next sync retries them
   * unchanged instead of dropping them permanently.
   */
  quotaExhausted: Annotation<boolean>(replace<boolean>(() => false)),

  /**
   * Accumulated across nodes; reported in the completion log and the API.
   *
   * The reducer adds rather than replaces, so a node returns only its own
   * delta. Read-modify-write on a shared counter would be wrong the moment two
   * nodes ever run concurrently.
   */
  counters: Annotation<SyncCounters, Partial<SyncCounters>>({
    reducer: (prev: SyncCounters, next: Partial<SyncCounters>) => ({
      messagesParsed: prev.messagesParsed + (next.messagesParsed ?? 0),
      messagesFailed: prev.messagesFailed + (next.messagesFailed ?? 0),
      eventsCreated: prev.eventsCreated + (next.eventsCreated ?? 0),
      eventsSynced: prev.eventsSynced + (next.eventsSynced ?? 0),
    }),
    default: () => ({
      messagesParsed: 0,
      messagesFailed: 0,
      eventsCreated: 0,
      eventsSynced: 0,
    }),
  }),
});

export type EventSyncState = typeof EventSyncStateAnnotation.State;

/**
 * What a node returns: a partial state, where `counters` carries *deltas*
 * rather than totals (the annotation's reducer adds them).
 */
export type EventSyncUpdate = Partial<Omit<EventSyncState, 'counters'>> & {
  counters?: Partial<SyncCounters>;
};

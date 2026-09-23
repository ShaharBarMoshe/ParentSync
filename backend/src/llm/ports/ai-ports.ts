import type { ParsedEvent } from '../dto/parsed-event.dto';

/**
 * The AI capabilities the domain needs, named as capabilities.
 *
 * These replace the old `ILLMService.callLLM(messages): Promise<string>`. That
 * port named the *mechanism* (send strings to a model) rather than the
 * capability, which is why mechanism concerns — JSON repair, markdown-fence
 * stripping, a hand-rolled batch key protocol — ended up inside
 * `MessageParserService`. A port that returns `ParsedEvent[]` has nowhere to
 * put them, so they cease to exist.
 *
 * No adapter type leaks through: no LangChain type appears in this file, and
 * nothing outside `src/llm/adapters/**` imports `@langchain/*`.
 */

/** An image carried inline with a message, base64 with no `data:` prefix. */
export interface InlineImage {
  mimeType: string;
  data: string;
}

/** One message group handed to the extractor. */
export interface ExtractionRequest {
  /** Caller-owned id; echoed back on the result so results need no ordering. */
  id: string;
  content: string;
  /**
   * The date the message was sent, as YYYY-MM-DD. Relative dates ("tomorrow")
   * resolve against this and not against today, or a message parsed three days
   * late lands three days late.
   */
  dateContext: string;
  images?: InlineImage[];
}

export interface ExtractionResult {
  id: string;
  events: ParsedEvent[];
}

/**
 * Stage 2: pull calendar events out of message text and images.
 *
 * Implementations decide for themselves how to split the work across provider
 * calls — batching text, sending images one at a time — and must return
 * exactly one result per request.
 *
 * Throws `LlmQuotaExhaustedError` when the account is out of credit. That is a
 * system-wide stop, not "these messages had no events": swallowing it marks
 * messages parsed and loses them for good.
 */
export interface IEventExtractor {
  extract(requests: ExtractionRequest[]): Promise<ExtractionResult[]>;
}

export interface ClassifierVerdict {
  isEvent: boolean;
  reason: string;
}

/**
 * Stage 1: the cheap relevance gate in front of the extractor. Most messages
 * in a sync are not events, and skipping one saves ~3,800 tokens.
 *
 * **Fails open by contract.** Any failure returns `isEvent: true` so the
 * extractor still gets its chance — a broken gate must never silently swallow
 * a real school event.
 */
export interface IRelevanceClassifier {
  classify(content: string, dateContext?: string): Promise<ClassifierVerdict>;
}

/** The fields the duplicate judge compares. */
export interface EventSummary {
  title: string;
  date: string;
  time?: string | null;
  location?: string | null;
  description?: string | null;
}

/**
 * Layer 3: does a freshly extracted event describe the same gathering as one
 * already on the calendar, under a different title?
 *
 * Returns `false` on any failure — treating events as distinct at worst asks
 * the user to dismiss a duplicate, whereas a wrong `true` drops a real event
 * with no trace.
 */
export interface IDuplicateJudge {
  areIdentical(a: EventSummary, b: EventSummary): Promise<boolean>;
}

export const EVENT_EXTRACTOR = 'EVENT_EXTRACTOR';
export const RELEVANCE_CLASSIFIER = 'RELEVANCE_CLASSIFIER';
export const DUPLICATE_JUDGE = 'DUPLICATE_JUDGE';

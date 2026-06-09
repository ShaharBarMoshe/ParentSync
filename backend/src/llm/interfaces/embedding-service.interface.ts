/**
 * Port for text → vector embedding services used by message-level semantic
 * deduplication.
 *
 * Cache contract: implementations MAY cache results keyed on the input text
 * to avoid duplicate API calls within a single sync. The cache is in-process
 * only — restarting the backend clears it. Identical inputs return identical
 * vectors (no randomization).
 *
 * Failure contract: implementations throw `EmbeddingFailedError` on SDK or
 * network failure. The dedup service catches this and fails open (proceeds
 * to parse the message normally rather than dropping it).
 */
export interface IEmbeddingService {
  /** Embed a single string. Returns a fixed-dimension numeric vector. */
  embedText(text: string): Promise<number[]>;

  /** Embed a batch of strings in input order. Returns one vector per input. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export class EmbeddingFailedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EmbeddingFailedError';
  }
}

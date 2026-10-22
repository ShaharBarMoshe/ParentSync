import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import {
  IEmbeddingService,
  EmbeddingFailedError,
} from '../interfaces/embedding-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { sha256 } from '../../shared/utils/hash';
import {
  LlmQuotaExhaustedError,
  isQuotaExhaustedError,
} from '../errors/llm-quota-exhausted.error';

const EMBEDDING_MODEL = 'gemini-embedding-001';
const CACHE_MAX_ENTRIES = 128;

/**
 * LangChain-backed implementation of `IEmbeddingService`.
 *
 * Keeps the contract the dedup services rely on — the SHA-256-keyed in-process
 * LRU, `EmbeddingFailedError` on failure so dedup can fail open, and the
 * separate `LlmQuotaExhaustedError` for a depleted account.
 *
 * One real improvement over the SDK adapter: `embedBatch` issues a single
 * `embedDocuments` call for the uncached texts instead of looping one request
 * per text. Calendar-conflict dedup embeds every candidate summary in a
 * window, so that loop was N sequential round-trips per checked event.
 */
@Injectable()
export class EmbeddingAdapter
  implements IEmbeddingService, OnModuleInit
{
  private readonly logger = new Logger(EmbeddingAdapter.name);
  private embeddings: GoogleGenerativeAIEmbeddings | null = null;
  /** LRU: insertion order is reuse order; oldest entries get evicted. */
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly settingsService: SettingsService) {}

  async onModuleInit(): Promise<void> {
    await this.loadClient();
  }

  private async loadClient(): Promise<void> {
    try {
      const setting =
        await this.settingsService.findByKeyDecrypted('gemini_api_key');
      this.embeddings = this.build(setting.value.trim());
      this.logger.log('LangChain embedding client configured');
    } catch {
      this.logger.warn('Gemini API key not configured (embeddings disabled)');
    }
  }

  private build(apiKey: string): GoogleGenerativeAIEmbeddings {
    return new GoogleGenerativeAIEmbeddings({
      apiKey,
      model: EMBEDDING_MODEL,
      maxRetries: 0,
    });
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string; value: string }): void {
    if (payload.key === 'gemini_api_key') {
      this.embeddings = this.build(payload.value.trim());
      // Vectors are model- and account-scoped; a key change invalidates them.
      this.cache.clear();
      this.logger.log('Embedding API key updated');
    }
  }

  async embedText(text: string): Promise<number[]> {
    const key = sha256(text);
    const cached = this.readCache(key);
    if (cached) {
      this.logger.debug(`Embedding cache hit chars=${text.length}`);
      return cached;
    }

    const client = this.requireClient();
    this.logger.debug(`Embedding API call chars=${text.length} cache=miss`);

    const [vector] = await this.guard(
      () => client.embedDocuments([text]),
      text.length,
    );
    const validated = this.requireVector(vector);
    this.cacheSet(key, validated);
    return validated;
  }

  /**
   * Embeds in input order. Only the uncached texts go to the API, in one call;
   * results are stitched back into their original positions.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const keys = texts.map((t) => sha256(t));
    const out = new Array<number[] | undefined>(texts.length);
    const missingIndices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.readCache(keys[i]);
      if (cached) out[i] = cached;
      else missingIndices.push(i);
    }

    if (missingIndices.length > 0) {
      const client = this.requireClient();

      // Send each distinct text once. A batch legitimately repeats content —
      // two channels forwarding the same school notice, for instance — and
      // paying for the same vector twice is pure waste.
      const uniqueTexts: string[] = [];
      const positionOfKey = new Map<string, number>();
      for (const i of missingIndices) {
        if (!positionOfKey.has(keys[i])) {
          positionOfKey.set(keys[i], uniqueTexts.length);
          uniqueTexts.push(texts[i]);
        }
      }

      this.logger.debug(
        `Embedding batch API call texts=${uniqueTexts.length} ` +
          `cached=${texts.length - missingIndices.length} ` +
          `duplicates=${missingIndices.length - uniqueTexts.length}`,
      );

      const vectors = await this.guard(
        () => client.embedDocuments(uniqueTexts),
        uniqueTexts.reduce((sum, t) => sum + t.length, 0),
      );

      if (vectors.length !== uniqueTexts.length) {
        // Silently mis-aligning vectors with their source text would corrupt
        // every similarity comparison downstream.
        throw new EmbeddingFailedError(
          `Embedding batch returned ${vectors.length} vectors for ${uniqueTexts.length} inputs`,
        );
      }

      for (const i of missingIndices) {
        const validated = this.requireVector(
          vectors[positionOfKey.get(keys[i])!],
        );
        this.cacheSet(keys[i], validated);
        out[i] = validated;
      }
    }

    return out as number[][];
  }

  private requireClient(): GoogleGenerativeAIEmbeddings {
    if (!this.embeddings) {
      throw new EmbeddingFailedError(
        'Gemini embedding client not configured (missing gemini_api_key)',
      );
    }
    return this.embeddings;
  }

  private requireVector(vector: number[] | undefined): number[] {
    if (!vector || vector.length === 0) {
      throw new EmbeddingFailedError('Gemini returned empty embedding response');
    }
    return vector;
  }

  /**
   * Translate provider failures into the port's error contract. Dedup fails
   * open on `EmbeddingFailedError`, but a depleted account is worth naming
   * separately — it will not recover on its own.
   */
  private async guard<T>(call: () => Promise<T>, chars: number): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof EmbeddingFailedError) throw err;

      if (isQuotaExhaustedError(err)) {
        this.logger.error(
          'Embedding quota/credit exhausted — semantic dedup is disabled until ' +
            `the account has credit again: ${(err as Error).message}`,
        );
        throw new LlmQuotaExhaustedError(
          `Gemini embed failed: ${(err as Error).message}`,
          err,
        );
      }

      this.logger.warn(
        `Embedding API failed: ${(err as Error).message} chars=${chars}`,
      );
      throw new EmbeddingFailedError(
        `Gemini embed failed: ${(err as Error).message}`,
        err,
      );
    }
  }

  private readCache(key: string): number[] | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    // Refresh LRU order.
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached;
  }

  private cacheSet(key: string, value: number[]): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

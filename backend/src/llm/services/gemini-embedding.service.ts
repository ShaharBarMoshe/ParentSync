import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { GoogleGenAI } from '@google/genai';
import {
  IEmbeddingService,
  EmbeddingFailedError,
} from '../interfaces/embedding-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { sha256 } from '../../shared/utils/hash';

const EMBEDDING_MODEL = 'text-embedding-004';
const CACHE_MAX_ENTRIES = 128;

/**
 * Gemini-backed implementation of IEmbeddingService.
 *
 * Uses the same API key as `GeminiService` (settings key `gemini_api_key`).
 * Maintains an in-process LRU keyed on SHA-256 of the input — see the cache
 * contract on IEmbeddingService.
 */
@Injectable()
export class GeminiEmbeddingService implements IEmbeddingService, OnModuleInit {
  private readonly logger = new Logger(GeminiEmbeddingService.name);
  private client: GoogleGenAI | null = null;
  /** LRU: insertion order is reuse order; oldest entries get evicted. */
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly settingsService: SettingsService) {}

  async onModuleInit() {
    await this.loadClient();
  }

  private async loadClient() {
    try {
      const apiKeySetting =
        await this.settingsService.findByKeyDecrypted('gemini_api_key');
      this.client = new GoogleGenAI({ apiKey: apiKeySetting.value.trim() });
      this.logger.log('Gemini embedding client configured');
    } catch {
      this.logger.warn('Gemini API key not configured (embeddings disabled)');
    }
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string; value: string }) {
    if (payload.key === 'gemini_api_key') {
      this.client = new GoogleGenAI({ apiKey: payload.value.trim() });
      this.cache.clear();
      this.logger.log('Gemini embedding API key updated');
    }
  }

  async embedText(text: string): Promise<number[]> {
    const key = sha256(text);
    const cached = this.cache.get(key);
    if (cached) {
      this.logger.debug(`Embedding cache hit chars=${text.length}`);
      // Refresh LRU order
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    if (!this.client) {
      throw new EmbeddingFailedError(
        'Gemini embedding client not configured (missing gemini_api_key)',
      );
    }

    this.logger.debug(
      `Embedding API call chars=${text.length} cache=miss`,
    );

    try {
      const response = await this.client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
      });
      const values = response.embeddings?.[0]?.values;
      if (!values || values.length === 0) {
        throw new EmbeddingFailedError(
          'Gemini returned empty embedding response',
        );
      }
      this.cacheSet(key, values);
      return values;
    } catch (err) {
      if (err instanceof EmbeddingFailedError) throw err;
      this.logger.warn(
        `Embedding API failed: ${(err as Error).message} chars=${text.length}`,
      );
      throw new EmbeddingFailedError(
        `Gemini embed failed: ${(err as Error).message}`,
        err,
      );
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) {
      out.push(await this.embedText(t));
    }
    return out;
  }

  private cacheSet(key: string, value: number[]) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

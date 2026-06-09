import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EMBEDDING_SERVICE,
  MESSAGE_REPOSITORY,
} from '../../shared/constants/injection-tokens';
import type {
  IMessageRepository,
  ParsedMessageEmbeddingRow,
} from '../../messages/interfaces/message-repository.interface';
import type { IEmbeddingService } from '../../llm/interfaces/embedding-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { cosineSimilarity } from '../../shared/utils/cosine-similarity';
import { sha256 } from '../../shared/utils/hash';

/** Result of a successful dedup match. */
export interface DedupMatch {
  /** ID of the previously-parsed message that this group duplicates. */
  matchedMessageId: string;
  /** Cosine similarity in `[0, 1]` (1.0 for exact-hash hits). */
  similarity: number;
  /** True when the match was found via byte-identical SHA-256 (no API call). */
  exact: boolean;
}

/** Output of `findDuplicateOf`. Always carries the embedding when one was
 *  produced — even on a non-hit — so the caller can persist it without a
 *  second API call. */
export interface DedupResult {
  /** Non-null when a match above threshold was found. */
  match: DedupMatch | null;
  /** SHA-256 of the merged content (always set). */
  contentHash: string;
  /** Embedding of the merged content. Null when dedup was disabled or when
   *  the embedding API failed. */
  embedding: number[] | null;
}

const DEFAULT_THRESHOLD = 0.92;
const LOOKBACK_DAYS = 30;
const LOOKBACK_LIMIT = 1000;

/**
 * Decides whether an incoming merged-group of messages is a near-duplicate of
 * something we've already parsed within the lookback window.
 *
 * **Fail-open contract:** this service never throws. If embeddings are
 * unavailable, settings are unreadable, or the candidate scan errors out,
 * `findDuplicateOf` returns `{ match: null }` and the caller proceeds with
 * the normal parse flow. Dedup is an optimization, never a blocker.
 */
@Injectable()
export class MessageDeduplicationService {
  private readonly logger = new Logger(MessageDeduplicationService.name);

  constructor(
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    @Inject(EMBEDDING_SERVICE)
    private readonly embeddingService: IEmbeddingService,
    private readonly settingsService: SettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async findDuplicateOf(mergedContent: string): Promise<DedupResult> {
    const contentHash = sha256(mergedContent);

    if (!(await this.isEnabled())) {
      return { match: null, contentHash, embedding: null };
    }

    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    let candidates: ParsedMessageEmbeddingRow[];
    try {
      candidates = await this.messageRepository.findParsedWithEmbeddings(
        since,
        LOOKBACK_LIMIT,
      );
    } catch (err) {
      this.logger.warn(
        `Dedup fail-open: candidate scan failed: ${(err as Error).message}`,
      );
      return { match: null, contentHash, embedding: null };
    }

    this.logger.debug(
      `Dedup check started contentChars=${mergedContent.length} candidatePool=${candidates.length}`,
    );

    // 20.5a — exact-hash short-circuit. Skips the embedding API entirely.
    const exact = candidates.find((c) => c.contentHash === contentHash);
    if (exact) {
      this.logger.debug(
        `Dedup hash-hit matchId=${exact.id} (no API call)`,
      );
      const match: DedupMatch = {
        matchedMessageId: exact.id,
        similarity: 1.0,
        exact: true,
      };
      this.emitDuplicateDetected(match);
      return { match, contentHash, embedding: exact.embedding ?? null };
    }

    let embedding: number[];
    try {
      embedding = await this.embeddingService.embedText(mergedContent);
    } catch (err) {
      this.logger.warn(
        `Dedup fail-open: embedding error, treating as fresh: ${(err as Error).message}`,
      );
      return { match: null, contentHash, embedding: null };
    }

    const threshold = await this.getThreshold();
    let best: DedupMatch | null = null;
    let bestScore = 0;

    for (const c of candidates) {
      if (!c.embedding || c.embedding.length !== embedding.length) continue;
      const sim = cosineSimilarity(embedding, c.embedding);
      if (sim > bestScore) bestScore = sim;
      if (sim >= threshold && (best === null || sim > best.similarity)) {
        best = { matchedMessageId: c.id, similarity: sim, exact: false };
      }
    }

    if (best) {
      this.logger.debug(
        `Dedup embedding-hit matchId=${best.matchedMessageId} similarity=${best.similarity.toFixed(3)} threshold=${threshold}`,
      );
      this.emitDuplicateDetected(best);
      return { match: best, contentHash, embedding };
    }

    this.logger.debug(
      `Dedup no-hit bestSimilarity=${bestScore.toFixed(3)} threshold=${threshold} candidatesScanned=${candidates.length}`,
    );
    return { match: null, contentHash, embedding };
  }

  async isEnabled(): Promise<boolean> {
    try {
      const setting = await this.settingsService.findByKey('dedup_enabled');
      return setting.value.toLowerCase() !== 'false';
    } catch {
      // Seed hook guarantees presence, but be defensive — default on.
      return true;
    }
  }

  private async getThreshold(): Promise<number> {
    try {
      const setting = await this.settingsService.findByKey('dedup_threshold');
      const parsed = Number.parseFloat(setting.value);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
        this.logger.warn(
          `Dedup threshold invalid (${setting.value}), using fallback ${DEFAULT_THRESHOLD}`,
        );
        return DEFAULT_THRESHOLD;
      }
      return parsed;
    } catch {
      return DEFAULT_THRESHOLD;
    }
  }

  private emitDuplicateDetected(match: DedupMatch): void {
    this.eventEmitter.emit('message.duplicate-detected', {
      matchedAgainstId: match.matchedMessageId,
      similarity: match.similarity,
      exact: match.exact,
    });
  }
}

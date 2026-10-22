import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as crypto from 'crypto';
import type { ParsedEvent } from '../dto/parsed-event.dto';
import { SettingsService } from '../../settings/settings.service';
import { MessageClassifierService } from './message-classifier.service';
import { PromptRegistry, type BuiltPrompt } from '../prompts/prompt-registry.service';
import { isQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';
import {
  EVENT_EXTRACTOR,
  DUPLICATE_JUDGE,
  type IEventExtractor,
  type IDuplicateJudge,
  type ExtractionRequest,
  type InlineImage,
  type EventSummary,
} from '../ports/ai-ports';

export type { InlineImage };

const CACHE_TTL_SECONDS = 86400; // 24 hours

/** A message group offered for parsing. */
export interface ParseGroup {
  id: string;
  content: string;
  images?: InlineImage[];
}

/**
 * Turns message text into calendar events, as cheaply as it can.
 *
 * What is left here after the LangChain rewrite is the *policy* around
 * extraction, and nothing else:
 *
 * - the 24-hour result cache, keyed on content + prompt version, so an edited
 *   prompt invalidates stale parses
 * - the stage-1 classifier gate, and the rule that image-bearing messages skip
 *   it (the classifier only reads text, and a flyer may be the whole event)
 * - the quota-exhausted rule: rethrow rather than report "no events", because
 *   reporting none marks the message parsed and loses it for good
 *
 * Everything that used to sit between here and the provider — markdown-fence
 * stripping, brace matching, batch-key heuristics, per-group reparse fallbacks
 * — is gone. `EVENT_EXTRACTOR` returns `ParsedEvent[]`, so there is nothing
 * left to repair.
 */
@Injectable()
export class MessageParserService {
  private readonly logger = new Logger(MessageParserService.name);

  constructor(
    @Inject(EVENT_EXTRACTOR) private readonly extractor: IEventExtractor,
    @Inject(DUPLICATE_JUDGE) private readonly duplicateJudge: IDuplicateJudge,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly settingsService: SettingsService,
    private readonly classifierService: MessageClassifierService,
    private readonly prompts: PromptRegistry,
  ) {}

  /** The active extraction prompt and its version hash. */
  buildSystemPrompt(): Promise<BuiltPrompt> {
    return this.prompts.systemPrompt();
  }

  async parseMessage(
    content: string,
    currentDate?: string,
    images?: InlineImage[],
  ): Promise<ParsedEvent[]> {
    const results = await this.parseMessageBatch(
      [{ id: 'single', content, images }],
      currentDate,
    );
    return results.get('single') ?? [];
  }

  /**
   * Parse a set of message groups, returning events per group id.
   *
   * Cached groups never reach the provider; uncached text groups pass the
   * classifier first; whatever survives goes to the extractor in one call,
   * which decides its own batching.
   */
  async parseMessageBatch(
    groups: ParseGroup[],
    currentDate?: string,
    perGroupDates?: string[],
  ): Promise<Map<string, ParsedEvent[]>> {
    const result = new Map<string, ParsedEvent[]>();
    if (groups.length === 0) return result;

    const { version } = await this.buildSystemPrompt();
    const defaultDate = currentDate ?? new Date().toISOString().split('T')[0];
    const dateFor = (index: number) =>
      perGroupDates?.[index] || currentDate || defaultDate;

    // 1. Cache.
    const uncached: { group: ParseGroup; dateContext: string }[] = [];
    for (const [index, group] of groups.entries()) {
      const cacheKey = this.getCacheKey(group.content, version, group.images);
      const cached = await this.cacheManager.get<ParsedEvent[]>(cacheKey);
      if (cached) {
        result.set(group.id, cached);
      } else {
        uncached.push({ group, dateContext: dateFor(index) });
      }
    }
    if (uncached.length === 0) {
      this.logger.debug(`All ${groups.length} groups served from cache`);
      return result;
    }

    // 2. Stage-1 gate. Image groups bypass it — it cannot see images.
    const requests: ExtractionRequest[] = [];
    let rejects = 0;
    for (const { group, dateContext } of uncached) {
      const hasImages = !!group.images?.length;
      if (!hasImages && group.content.trim().length > 0) {
        const verdict = await this.classifierService.classify(
          group.content,
          dateContext,
        );
        if (!verdict.isEvent) {
          rejects++;
          result.set(group.id, []);
          await this.cache(group, version, []);
          continue;
        }
      }
      requests.push({
        id: group.id,
        content: group.content,
        dateContext,
        images: group.images,
      });
    }
    if (rejects > 0) {
      this.logger.log(
        `Classifier rejected ${rejects}/${uncached.length} uncached groups`,
      );
      for (let i = 0; i < rejects; i++) {
        await this.incrementMetric('metric.classifier_reject_total');
      }
    }
    if (requests.length === 0) return result;

    // 3. Extract.
    const byId = new Map(groups.map((g) => [g.id, g]));
    try {
      for (const extracted of await this.extractor.extract(requests)) {
        result.set(extracted.id, extracted.events);
        const group = byId.get(extracted.id);
        if (group) await this.cache(group, version, extracted.events);
      }
    } catch (error) {
      // An exhausted account is a system-wide stop, not "these messages have
      // no events". Reporting none marks them parsed and drops them for good.
      if (isQuotaExhaustedError(error)) throw error;

      this.logger.error(
        `Extraction failed for ${requests.length} groups: ${(error as Error).message}`,
      );
      // Leave the failed groups absent from the map rather than caching [] —
      // an empty entry would be indistinguishable from "no events found".
    }
    return result;
  }

  /**
   * Whether two events describe the same real gathering. Suppresses a
   * duplicate approval card when a fresh extraction lands on an existing
   * event's slot under a different title.
   */
  eventsAreIdentical(a: EventSummary, b: EventSummary): Promise<boolean> {
    return this.duplicateJudge.areIdentical(a, b);
  }

  private cache(
    group: ParseGroup,
    version: string,
    events: ParsedEvent[],
  ): Promise<unknown> {
    return this.cacheManager.set(
      this.getCacheKey(group.content, version, group.images),
      events,
      CACHE_TTL_SECONDS,
    );
  }

  /**
   * Best-effort increment of a counter in settings. Failures are swallowed —
   * a metric must never break a parse.
   */
  private async incrementMetric(key: string): Promise<void> {
    try {
      let current = 0;
      try {
        const parsed = Number.parseInt(
          (await this.settingsService.findByKey(key)).value,
          10,
        );
        if (!Number.isNaN(parsed)) current = parsed;
      } catch {
        // Usually seeded; if missing, start at 0.
      }
      await this.settingsService.create({ key, value: String(current + 1) });
    } catch (err) {
      this.logger.debug(
        `Failed to increment metric ${key}: ${(err as Error).message}`,
      );
    }
  }

  private getCacheKey(
    content: string,
    promptVersion: string,
    images?: InlineImage[],
  ): string {
    const hasher = crypto.createHash('sha256').update(content);
    if (images?.length) {
      for (const img of images) {
        hasher.update('\u0000img\u0000');
        hasher.update(img.mimeType);
        hasher.update('\u0000');
        hasher.update(img.data);
      }
    }
    return `msg-parse:${promptVersion}:${hasher.digest('hex')}`;
  }
}

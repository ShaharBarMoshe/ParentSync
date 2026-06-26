import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as crypto from 'crypto';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';
import type { ILLMService, LlmInlineImage } from '../interfaces/llm-service.interface';
import type { ParsedEvent, EventAction } from '../dto/parsed-event.dto';
import { SettingsService } from '../../settings/settings.service';
import { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt';
import { MessageClassifierService } from './message-classifier.service';
import { LLM_SYSTEM_PROMPT_KEY, LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY } from '../../settings/constants/setting-keys';

interface BuiltPrompt {
  prompt: string;
  version: string;
}


const CACHE_TTL_SECONDS = 86400; // 24 hours

@Injectable()
export class MessageParserService implements OnModuleInit {
  private readonly logger = new Logger(MessageParserService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly settingsService: SettingsService,
    private readonly classifierService: MessageClassifierService,
  ) {}

  async onModuleInit(): Promise<void> {
    // If the user has not explicitly saved a custom prompt, always write the
    // current DEFAULT_SYSTEM_PROMPT so that shipped rule updates take effect
    // on every boot rather than being frozen at the value seeded on first install.
    const isCustomSetting = await this.settingsService.findByKey(LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY).catch(() => null);
    const isCustom = isCustomSetting?.value === 'true';
    if (!isCustom) {
      await this.settingsService.create({ key: LLM_SYSTEM_PROMPT_KEY, value: DEFAULT_SYSTEM_PROMPT });
      this.logger.log('System prompt synced to latest shipped default');
    }
  }

  /**
   * Composes the final system prompt: user prompt (or default) + a block
   * of recent negative examples that the user has 😢-rejected. Returns the
   * assembled string and a short hash that callers fold into cache keys
   * so a new negative invalidates stale cached parses for the same message.
   *
   * Reads on every call — sqlite is cheap and we want prompt edits to
   * take effect on the next parse without a restart.
   */
  async buildSystemPrompt(): Promise<BuiltPrompt> {
    let userPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const setting = await this.settingsService.findByKey(LLM_SYSTEM_PROMPT_KEY);
      const value = setting?.value?.trim();
      if (value) userPrompt = value;
    } catch {
      // setting not found — fall through to default
    }

    // Phase 24.5: the negative-examples feedback loop (😢 → prompt) was retired.
    // The LLM demonstrably ignored the appended block, it killed cache hit rate
    // by mutating the prompt on every reaction, and it bloated every parse.
    // The negative_examples table keeps receiving writes for historical/UI
    // purposes but is no longer read at parse time.
    const version = crypto
      .createHash('sha256')
      .update(userPrompt)
      .digest('hex')
      .slice(0, 16);
    return { prompt: userPrompt, version };
  }

  async parseMessage(
    content: string,
    currentDate?: string,
    images?: LlmInlineImage[],
  ): Promise<ParsedEvent[]> {
    const built = await this.buildSystemPrompt();
    const cacheKey = this.getCacheKey(content, built.version, images);

    // Check cache
    const cached = await this.cacheManager.get<ParsedEvent[]>(cacheKey);
    if (cached) {
      this.logger.debug('Cache hit for message parsing');
      return cached;
    }
    this.logger.debug('Cache miss for message parsing');

    // Phase 24 — stage 1: classifier. Skip for image-bearing messages (the
    // classifier only reads text; an image flyer might be a real event the
    // text doesn't describe). Fail-open by contract.
    const hasImagesForClassifier = !!(images && images.length > 0);
    if (!hasImagesForClassifier && content.trim().length > 0) {
      const verdict = await this.classifierService.classify(content, currentDate);
      if (!verdict.isEvent) {
        this.logger.debug(
          `Classifier rejected: ${verdict.reason} contentChars=${content.length}`,
        );
        await this.incrementMetric('metric.classifier_reject_total');
        await this.cacheManager.set(cacheKey, [], CACHE_TTL_SECONDS);
        return [];
      }
    }

    try {
      const dateContext = currentDate ?? new Date().toISOString().split('T')[0];
      const hasImages = !!(images && images.length > 0);
      const userMessage = hasImages
        ? `Current date: ${dateContext}\n\n${content ? `Message text:\n${content}\n\n` : ''}The message also contains ${images!.length} attached image(s). Extract any events visible in the image(s) — flyers, schedules, screenshots — and return a top-level JSON ARRAY of events: [{...}, {...}]. DO NOT use the numbered-object {"1": [...]} format — that shape is reserved for batched-text calls only. Return [] if no event is visible.`
        : `Current date: ${dateContext}\n\nMessage to parse:\n${content}`;

      const response = await this.llmService.callLLM([
        { role: 'system', content: built.prompt },
        { role: 'user', content: userMessage, images: hasImages ? images : undefined },
      ]);

      this.logger.log(
        `LLM response (${response.length} chars): ${response.substring(0, 300)}`,
      );

      const events = this.extractJsonFromResponse(response);
      const validatedEvents = this.collapseSingleGathering(this.validateEvents(events));

      this.logger.log(
        `Parsed ${events.length} raw events → ${validatedEvents.length} valid events`,
      );

      // Cache the result
      await this.cacheManager.set(cacheKey, validatedEvents, CACHE_TTL_SECONDS);

      return validatedEvents;
    } catch (error) {
      this.logger.error(`Failed to parse message: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse multiple message groups in a single LLM call. Each group is tagged
   * with a numeric ID so the LLM can return events keyed by group.
   * Falls back to individual parsing if the batch response can't be parsed.
   */
  async parseMessageBatch(
    groups: { id: string; content: string; images?: LlmInlineImage[] }[],
    currentDate?: string,
    perGroupDates?: string[],
  ): Promise<Map<string, ParsedEvent[]>> {
    const result = new Map<string, ParsedEvent[]>();

    if (groups.length === 0) return result;

    const built = await this.buildSystemPrompt();

    // Check cache for each group; separate cached vs uncached
    const uncached: { id: string; content: string; images?: LlmInlineImage[] }[] = [];
    for (const group of groups) {
      const cacheKey = this.getCacheKey(group.content, built.version, group.images);
      const cached = await this.cacheManager.get<ParsedEvent[]>(cacheKey);
      if (cached) {
        result.set(group.id, cached);
      } else {
        uncached.push(group);
      }
    }

    if (uncached.length === 0) {
      this.logger.debug(`Batch: all ${groups.length} groups served from cache`);
      return result;
    }

    // Phase 24 — stage 1: classifier filter. Run on every uncached *text-only*
    // group. Image groups bypass the classifier (it can't see images).
    // A NO verdict short-circuits to [] and caches it.
    const survivedClassifier: { id: string; content: string; images?: LlmInlineImage[] }[] = [];
    let classifierRejects = 0;
    for (const g of uncached) {
      const hasImages = !!(g.images && g.images.length > 0);
      if (hasImages || g.content.trim().length === 0) {
        survivedClassifier.push(g);
        continue;
      }
      const groupIndex = groups.findIndex((orig) => orig.id === g.id);
      const groupDate = perGroupDates?.[groupIndex] || currentDate;
      const verdict = await this.classifierService.classify(g.content, groupDate);
      if (!verdict.isEvent) {
        classifierRejects++;
        result.set(g.id, []);
        const cacheKey = this.getCacheKey(g.content, built.version, g.images);
        await this.cacheManager.set(cacheKey, [], CACHE_TTL_SECONDS);
      } else {
        survivedClassifier.push(g);
      }
    }
    if (classifierRejects > 0) {
      this.logger.log(
        `Classifier rejected ${classifierRejects}/${uncached.length} uncached groups`,
      );
      for (let i = 0; i < classifierRejects; i++) {
        await this.incrementMetric('metric.classifier_reject_total');
      }
    }
    if (survivedClassifier.length === 0) {
      return result;
    }

    // Image-bearing groups can't ride the text-only batch (the LLM gets one
    // image bundle per request and can't tell which message owns which
    // image). Parse them individually; let text-only groups still batch.
    const imageGroups = survivedClassifier.filter((g) => g.images && g.images.length > 0);
    const textOnly = survivedClassifier.filter((g) => !g.images || g.images.length === 0);

    for (const g of imageGroups) {
      const groupIndex = groups.findIndex((orig) => orig.id === g.id);
      const groupDate = perGroupDates?.[groupIndex] || currentDate;
      const events = await this.parseMessage(g.content, groupDate, g.images);
      result.set(g.id, events);
    }

    if (textOnly.length === 0) return result;
    // Continue the existing batch path with the text-only subset
    const uncachedForBatch = textOnly;

    // Single group — use the simpler single-message flow
    if (uncachedForBatch.length === 1) {
      // Find the per-group date for this uncached group
      const groupIndex = groups.findIndex((g) => g.id === uncachedForBatch[0].id);
      const groupDate = perGroupDates?.[groupIndex] || currentDate;
      const events = await this.parseMessage(uncachedForBatch[0].content, groupDate);
      result.set(uncachedForBatch[0].id, events);
      return result;
    }

    // Split large batches into chunks to avoid rate limits on free-tier models
    const MAX_BATCH_SIZE = 8;
    if (uncachedForBatch.length > MAX_BATCH_SIZE) {
      this.logger.log(
        `Splitting ${uncachedForBatch.length} groups into chunks of ${MAX_BATCH_SIZE}`,
      );
      for (let i = 0; i < uncachedForBatch.length; i += MAX_BATCH_SIZE) {
        const chunk = uncachedForBatch.slice(i, i + MAX_BATCH_SIZE);
        // Map per-group dates for this chunk
        const chunkDates = perGroupDates
          ? chunk.map((c) => {
              const idx = groups.findIndex((g) => g.id === c.id);
              return perGroupDates[idx] || currentDate || '';
            })
          : undefined;
        const chunkResult = await this.parseMessageBatch(
          chunk,
          currentDate,
          chunkDates,
        );
        for (const [id, events] of chunkResult) {
          result.set(id, events);
        }
      }
      return result;
    }

    this.logger.log(
      `Batch parsing ${uncachedForBatch.length} message groups in a single LLM call`,
    );

    try {
      const dateContext = currentDate ?? new Date().toISOString().split('T')[0];

      const numberedMessages = uncached
        .map((g, i) => {
          const groupIndex = groups.findIndex((orig) => orig.id === g.id);
          const groupDate = perGroupDates?.[groupIndex] || dateContext;
          return `===MESSAGE_${i + 1}===\nCurrent date for this message: ${groupDate}\n${g.content}`;
        })
        .join('\n\n');

      const userMessage =
        `Default current date: ${dateContext}\n\n` +
        `Parse the following ${uncachedForBatch.length} messages. Each message has its own "Current date" context — use THAT date (not the default) to resolve relative dates like "tomorrow", "next week", etc.\n` +
        `Return a JSON object where each key is the message number (as a string) and each value is an array of events extracted from that message. ` +
        `Example format: {"1": [{"title":"...", "date":"..."}], "2": [], "3": [{"title":"...", "date":"...", "time":"..."}]}\n\n` +
        numberedMessages;

      // Use higher token limit for batch — more groups = more output
      const maxTokens = Math.min(2048 + uncachedForBatch.length * 512, 8192);
      const response = await this.llmService.callLLM(
        [
          { role: 'system', content: built.prompt },
          { role: 'user', content: userMessage },
        ],
        undefined,
        undefined,
        maxTokens,
      );

      this.logger.log(
        `Batch LLM response (${response.length} chars): ${response.substring(0, 500)}`,
      );

      const parsed = this.extractBatchJsonFromResponse(response, uncachedForBatch.length);

      if (parsed) {
        for (let i = 0; i < uncachedForBatch.length; i++) {
          const key = String(i + 1);
          const events = parsed[key] || [];
          const validated = this.collapseSingleGathering(this.validateEvents(events));
          this.logger.log(
            `Batch group ${key}: ${events.length} raw → ${validated.length} valid events`,
          );
          result.set(uncachedForBatch[i].id, validated);
          // Cache each group individually
          const cacheKey = this.getCacheKey(uncachedForBatch[i].content, built.version);
          await this.cacheManager.set(cacheKey, validated, CACHE_TTL_SECONDS);
        }
        return result;
      }
    } catch (error) {
      this.logger.warn(
        `Batch parse failed, falling back to individual parsing: ${error.message}`,
      );
    }

    // Fallback: parse each group individually
    for (const group of uncachedForBatch) {
      const events = await this.parseMessage(group.content, currentDate);
      result.set(group.id, events);
    }
    return result;
  }

  private extractBatchJsonFromResponse(
    response: string,
    expectedCount: number,
  ): Record<string, unknown[]> | null {
    const trimmed = response.trim();

    // Try direct parse
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Try extracting from code blocks
      const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          obj = JSON.parse(jsonMatch[1].trim());
        } catch {
          // fall through
        }
      }
      // Try finding object braces
      if (!obj) {
        const braceMatch = trimmed.match(/\{[\s\S]*\}/);
        if (braceMatch) {
          try {
            obj = JSON.parse(braceMatch[0]);
          } catch {
            // fall through
          }
        }
      }
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      this.logger.warn('Batch response is not a JSON object — falling back');
      return null;
    }

    const record = obj as Record<string, unknown>;
    // Verify at least some expected keys exist
    const hasAnyKey = Array.from({ length: expectedCount }, (_, i) =>
      String(i + 1),
    ).some((k) => k in record);

    if (!hasAnyKey) {
      this.logger.warn('Batch response has no expected message keys — falling back');
      return null;
    }

    // Normalize: ensure each value is an array
    const result: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = Array.isArray(value) ? value : [];
    }
    return result;
  }

  private extractJsonFromResponse(response: string): unknown[] {
    // Try direct JSON parse first
    const trimmed = response.trim();
    try {
      const parsed = JSON.parse(trimmed);
      return this.coerceToEventArray(parsed);
    } catch {
      // Try extracting JSON from markdown code blocks
      const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          const arr = this.coerceToEventArray(parsed);
          if (arr.length > 0) return arr;
        } catch {
          // fall through
        }
      }

      // Try finding array brackets
      const bracketMatch = trimmed.match(/\[[\s\S]*\]/);
      if (bracketMatch) {
        try {
          const parsed = JSON.parse(bracketMatch[0]);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // fall through
        }
      }

      this.logger.warn('Could not extract JSON array from LLM response');
      return [];
    }
  }

  /**
   * Accepts either:
   *   - a plain array `[ev1, ev2, ...]` (the documented single-message shape)
   *   - a batched-object `{"1": [...], "2": [...]}` that some models return
   *     even when only one message was sent (notably Gemini Flash Lite when
   *     given image-only input). The latter is flattened into a single
   *     array because there's only one source message — the keys are just
   *     noise in that case.
   *
   * Anything else collapses to []; the caller logs a warning.
   */
  private coerceToEventArray(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const values = Object.values(parsed as Record<string, unknown>);
      if (values.length > 0 && values.every((v) => Array.isArray(v))) {
        const flat = (values as unknown[][]).flat();
        this.logger.log(
          `Flattened batch-shaped response ({${Object.keys(parsed as object).join(',')}}) into a ${flat.length}-event array`,
        );
        return flat;
      }
    }
    return [];
  }

  private validateEvents(events: unknown[]): ParsedEvent[] {
    return events
      .filter((event): event is Record<string, unknown> => {
        if (typeof event !== 'object' || event === null) return false;
        const e = event as Record<string, unknown>;
        // Must have title
        if (typeof e.title !== 'string' || !e.title.trim()) return false;

        const action = typeof e.action === 'string' ? e.action : 'create';
        const isDismissal = action === 'cancel' || action === 'delay';

        // date is required but can be empty string for dismissals
        if (typeof e.date !== 'string') return false;
        if (!isDismissal && !e.date.match(/^\d{4}-\d{2}-\d{2}$/)) return false;
        if (isDismissal && e.date !== '' && !e.date.match(/^\d{4}-\d{2}-\d{2}$/))
          return false;

        // Validate time format if present
        if (e.time && (typeof e.time !== 'string' || !e.time.match(/^\d{2}:\d{2}$/)))
          return false;
        // endTime is dropped (not rejected) if malformed or not strictly after time —
        // validation happens in the map step below so a bad endTime doesn't kill the event.
        // Validate newDate/newTime for delay actions
        if (e.newDate && (typeof e.newDate !== 'string' || !e.newDate.match(/^\d{4}-\d{2}-\d{2}$/)))
          return false;
        if (e.newTime && (typeof e.newTime !== 'string' || !e.newTime.match(/^\d{2}:\d{2}$/)))
          return false;
        // Validate action value
        if (e.action && !['create', 'cancel', 'delay'].includes(String(e.action)))
          return false;
        return true;
      })
      .map((event) => {
        const time = event.time ? String(event.time) : undefined;
        const endTime = this.normalizeEndTime(event.endTime, time);
        return {
          title: String(event.title).trim(),
          description: event.description ? String(event.description).trim() : undefined,
          date: String(event.date),
          time,
          endTime,
          location: event.location ? String(event.location).trim() : undefined,
          action: (['cancel', 'delay'].includes(String(event.action))
            ? String(event.action) as EventAction
            : undefined),
          originalTitle: event.originalTitle ? String(event.originalTitle).trim() : undefined,
          newDate: event.newDate ? String(event.newDate) : undefined,
          newTime: event.newTime ? String(event.newTime) : undefined,
        };
      });
  }

  /**
   * Accepts an endTime only when it's a well-formed HH:MM string strictly
   * later than the corresponding start time. Returns undefined otherwise.
   * Drops silently (with a debug log) rather than rejecting the whole event —
   * the rest of the parse is still usable.
   */
  private normalizeEndTime(raw: unknown, time: string | undefined): string | undefined {
    if (raw == null) return undefined;
    if (typeof raw !== 'string') return undefined;
    if (!raw.match(/^\d{2}:\d{2}$/)) {
      this.logger.debug(`Dropping malformed endTime "${String(raw)}"`);
      return undefined;
    }
    if (!time) {
      this.logger.debug(`Dropping endTime "${raw}" — start time missing`);
      return undefined;
    }
    if (raw <= time) {
      this.logger.debug(`Dropping endTime "${raw}" — not after start time "${time}"`);
      return undefined;
    }
    return raw;
  }

  /**
   * Enforces the single-gathering rule deterministically: when the LLM returns
   * multiple create-events with the same (title, date, location, description)
   * but different times, collapse them into one. Without this guard, a single
   * source message describing a gathering from two angles (e.g. "arrive at 17:00,
   * party 17:30-18:00") becomes two approval messages. Layer 3 (LLM dedup) catches
   * the same case after-the-fact but fails open on quota errors — this is the
   * cheap, deterministic safety net that runs before any DB write.
   *
   * Cancel/delay events are kept as-is — their semantics differ and they shouldn't
   * be merged.
   *
   * Tie-breaker for the kept event: prefer (time + endTime) > (time) > (all-day).
   */
  private collapseSingleGathering(events: ParsedEvent[]): ParsedEvent[] {
    if (events.length <= 1) return events;
    const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
    const groups = new Map<string, ParsedEvent[]>();
    for (const event of events) {
      if (event.action === 'cancel' || event.action === 'delay') {
        // Action events are passed through; key them uniquely so they never merge.
        groups.set(`__action_${groups.size}`, [event]);
        continue;
      }
      const key = [norm(event.title), event.date, norm(event.location), norm(event.description)].join('|');
      const bucket = groups.get(key) ?? [];
      bucket.push(event);
      groups.set(key, bucket);
    }
    const score = (e: ParsedEvent): number => (e.time ? 1 : 0) + (e.endTime ? 1 : 0);
    const collapsed: ParsedEvent[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) { collapsed.push(group[0]); continue; }
      const best = group.reduce((w, c) => (score(c) > score(w) ? c : w));
      this.logger.log(
        `Single-gathering collapse: ${group.length} events → 1 for "${best.title}" on ${best.date}`,
      );
      collapsed.push(best);
    }
    return collapsed;
  }

  /**
   * Best-effort increment of an integer counter stored under a settings key.
   * Failures are swallowed — metrics must never break a parse. Mirrors
   * EventSyncService.incrementMetric for the same reason.
   */
  private async incrementMetric(key: string): Promise<void> {
    try {
      let current = 0;
      try {
        const existing = await this.settingsService.findByKey(key);
        const parsed = Number.parseInt(existing.value, 10);
        if (!Number.isNaN(parsed)) current = parsed;
      } catch {
        // Seeder usually creates this; if missing, start at 0.
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
    images?: LlmInlineImage[],
  ): string {
    const hasher = crypto.createHash('sha256').update(content);
    if (images && images.length > 0) {
      for (const img of images) {
        hasher.update(' img ');
        hasher.update(img.mimeType);
        hasher.update(' ');
        hasher.update(img.data);
      }
    }
    return `msg-parse:${promptVersion}:${hasher.digest('hex')}`;
  }

  /**
   * Asks the LLM whether two events refer to the same real-world gathering.
   * Used to suppress duplicate approval messages when a fresh extraction
   * lands at the same date+time as an existing event but with a different
   * title (e.g. "יום הולדת בבילון" vs "מפגש בבילון").
   *
   * Returns false on any error so we never accidentally swallow a real
   * extraction because of a transient LLM hiccup.
   */
  async eventsAreIdentical(
    a: { title: string; date: string; time?: string | null; location?: string | null; description?: string | null },
    b: { title: string; date: string; time?: string | null; location?: string | null; description?: string | null },
  ): Promise<boolean> {
    const fmt = (e: typeof a) =>
      [
        `Title: ${e.title}`,
        `Date: ${e.date}`,
        `Time: ${e.time ?? 'all-day'}`,
        `Location: ${e.location ?? 'none'}`,
        `Description: ${e.description ?? 'none'}`,
      ].join('\n');

    const userMessage =
      'Decide whether the following two calendar events refer to the SAME real-world gathering.\n' +
      'They share a date and time slot but may have been described from different angles in different messages.\n' +
      'Reply with exactly "yes" if identical, or "no" if they are different gatherings. No other words.\n\n' +
      `Event A:\n${fmt(a)}\n\n` +
      `Event B:\n${fmt(b)}`;

    try {
      const response = await this.llmService.callLLM(
        [
          { role: 'system', content: 'You are a precise classifier. Reply only "yes" or "no".' },
          { role: 'user', content: userMessage },
        ],
        undefined,
        undefined,
        16,
      );
      const trimmed = response.trim().toLowerCase().replace(/[^a-z]/g, '');
      return trimmed === 'yes';
    } catch (error) {
      this.logger.warn(
        `eventsAreIdentical LLM call failed (treating as different): ${(error as Error).message}`,
      );
      return false;
    }
  }
}

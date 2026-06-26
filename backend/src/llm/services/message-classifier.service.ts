import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as crypto from 'crypto';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';
import type { ILLMService } from '../interfaces/llm-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { DEFAULT_CLASSIFIER_PROMPT } from './default-classifier-prompt';
import {
  LLM_CLASSIFIER_PROMPT_KEY,
  LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY,
  CLASSIFIER_ENABLED_KEY,
} from '../../settings/constants/setting-keys';

/** Verdict of one classification. */
export interface ClassifierVerdict {
  isEvent: boolean;
  reason: string;
}

interface BuiltPrompt {
  prompt: string;
  version: string;
}

const CACHE_TTL_SECONDS = 86400;

/**
 * Phase 24 — stage 1 of the two-stage extraction pipeline.
 *
 * Takes one message content + its date, decides whether it should reach the
 * full extractor at all. Most messages in a sync are not events; this gate
 * saves ~3,800 tokens per such message.
 *
 * **Fail-open contract.** Any error (LLM failure, malformed response, quota
 * exhausted) returns `{ isEvent: true, reason: 'classifier-fail-open' }` so
 * the extractor still gets a chance. The eval is the structural protection
 * against silently dropping events — this code only protects against silent
 * outages.
 */
@Injectable()
export class MessageClassifierService implements OnModuleInit {
  private readonly logger = new Logger(MessageClassifierService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly settingsService: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Seed the classifier prompt if the user hasn't customized it. Same
    // pattern as MessageParserService.onModuleInit so shipped updates land
    // automatically on boot.
    const isCustomSetting = await this.settingsService
      .findByKey(LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY)
      .catch(() => null);
    const isCustom = isCustomSetting?.value === 'true';
    if (!isCustom) {
      await this.settingsService.create({
        key: LLM_CLASSIFIER_PROMPT_KEY,
        value: DEFAULT_CLASSIFIER_PROMPT,
      });
      this.logger.log('Classifier prompt synced to latest shipped default');
    }
  }

  /**
   * Returns the (possibly user-overridden) classifier prompt plus a short
   * hash that callers fold into cache keys. Read on every call — sqlite is
   * cheap and prompt edits should take effect on the next classification.
   */
  async buildSystemPrompt(): Promise<BuiltPrompt> {
    let userPrompt = DEFAULT_CLASSIFIER_PROMPT;
    try {
      const setting = await this.settingsService.findByKey(LLM_CLASSIFIER_PROMPT_KEY);
      const value = setting?.value?.trim();
      if (value) userPrompt = value;
    } catch {
      // not found → fall through to default
    }
    const version = crypto
      .createHash('sha256')
      .update(userPrompt)
      .digest('hex')
      .slice(0, 16);
    return { prompt: userPrompt, version };
  }

  async isEnabled(): Promise<boolean> {
    try {
      const setting = await this.settingsService.findByKey(CLASSIFIER_ENABLED_KEY);
      return setting.value.toLowerCase() !== 'false';
    } catch {
      // Seed hook guarantees presence; default on if missing.
      return true;
    }
  }

  /**
   * Classify a single message. Returns `{ isEvent: true, reason: ... }` on:
   *   - LLM says YES
   *   - LLM error / malformed response (fail open)
   *   - classifier disabled via setting (short-circuit to YES so the
   *     extractor still runs — the user gets the old single-stage behavior)
   */
  async classify(content: string, messageDate?: string): Promise<ClassifierVerdict> {
    if (!(await this.isEnabled())) {
      return { isEvent: true, reason: 'classifier-disabled' };
    }

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return { isEvent: false, reason: 'empty-message' };
    }

    const built = await this.buildSystemPrompt();
    const cacheKey = this.getCacheKey(trimmed, built.version);
    const cached = await this.cacheManager.get<ClassifierVerdict>(cacheKey);
    if (cached) return cached;

    const dateContext = messageDate ? `Current date: ${messageDate}\n\n` : '';
    let response: string;
    try {
      response = await this.llmService.callLLM([
        { role: 'system', content: built.prompt },
        { role: 'user', content: `${dateContext}${trimmed}` },
      ]);
    } catch (error) {
      this.logger.warn(
        `Classifier fail-open: LLM error, treating as event: ${(error as Error).message}`,
      );
      return { isEvent: true, reason: 'classifier-fail-open' };
    }

    const verdict = this.parseVerdict(response);
    // Cache regardless of outcome — the same message will likely re-appear.
    await this.cacheManager.set(cacheKey, verdict, CACHE_TTL_SECONDS);
    return verdict;
  }

  /**
   * Expected response shape:
   *   YES — <reason>
   *   NO  — <reason>
   * Tolerates extra whitespace, hyphen variations (-, —, –), and missing reason.
   * On anything unparseable, fail open (assume YES) so the extractor still runs.
   */
  private parseVerdict(response: string): ClassifierVerdict {
    const text = response.trim();
    if (!text) {
      this.logger.warn('Classifier fail-open: empty response from LLM');
      return { isEvent: true, reason: 'classifier-empty-response' };
    }
    // Take only the first line to defend against the LLM adding follow-up commentary.
    const firstLine = text.split('\n')[0].trim();
    const match = firstLine.match(/^(YES|NO)\b\s*[—\-–:]?\s*(.*)$/i);
    if (!match) {
      this.logger.warn(
        `Classifier fail-open: unparseable response "${firstLine.substring(0, 80)}"`,
      );
      return { isEvent: true, reason: 'classifier-unparseable' };
    }
    const isEvent = match[1].toUpperCase() === 'YES';
    const reason = (match[2] || '').trim().slice(0, 80) || '(no reason)';
    return { isEvent, reason };
  }

  private getCacheKey(content: string, promptVersion: string): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `classify:${promptVersion}:${hash}`;
  }
}

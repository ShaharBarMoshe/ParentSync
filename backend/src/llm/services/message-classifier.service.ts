import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as crypto from 'crypto';
import { SettingsService } from '../../settings/settings.service';
import { CLASSIFIER_ENABLED_KEY } from '../../settings/constants/setting-keys';
import { PromptRegistry } from '../prompts/prompt-registry.service';
import {
  RELEVANCE_CLASSIFIER,
  type IRelevanceClassifier,
  type ClassifierVerdict,
} from '../ports/ai-ports';

export type { ClassifierVerdict };

const CACHE_TTL_SECONDS = 86400;

/**
 * Stage 1 of the two-stage extraction pipeline.
 *
 * Decides whether a message reaches the full extractor at all. Most messages
 * in a sync are not events, and skipping one saves ~3,800 tokens.
 *
 * This service owns the *policy* around the gate — the on/off setting, the
 * cache, the empty-message short-circuit. The provider call and its fail-open
 * behaviour live behind `RELEVANCE_CLASSIFIER`.
 */
@Injectable()
export class MessageClassifierService {
  private readonly logger = new Logger(MessageClassifierService.name);

  constructor(
    @Inject(RELEVANCE_CLASSIFIER)
    private readonly classifier: IRelevanceClassifier,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly settingsService: SettingsService,
    private readonly prompts: PromptRegistry,
  ) {}

  async isEnabled(): Promise<boolean> {
    try {
      const setting =
        await this.settingsService.findByKey(CLASSIFIER_ENABLED_KEY);
      return setting.value.toLowerCase() !== 'false';
    } catch {
      // The seed hook guarantees presence; default on if it is missing.
      return true;
    }
  }

  /**
   * Classify one message. Returns `isEvent: true` on a disabled classifier or
   * any provider failure, so the extractor still gets its chance.
   */
  async classify(
    content: string,
    messageDate?: string,
  ): Promise<ClassifierVerdict> {
    if (!(await this.isEnabled())) {
      return { isEvent: true, reason: 'classifier-disabled' };
    }

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return { isEvent: false, reason: 'empty-message' };
    }

    const { version } = await this.prompts.classifierPrompt();
    const cacheKey = this.getCacheKey(trimmed, version);
    const cached = await this.cacheManager.get<ClassifierVerdict>(cacheKey);
    if (cached) return cached;

    const verdict = await this.classifier.classify(trimmed, messageDate);

    // A fail-open verdict is not a judgement about the message — caching it
    // would freeze a transient outage into a day of skipped classification.
    if (verdict.reason !== 'classifier-fail-open') {
      await this.cacheManager.set(cacheKey, verdict, CACHE_TTL_SECONDS);
    }
    return verdict;
  }

  private getCacheKey(content: string, promptVersion: string): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `classify:${promptVersion}:${hash}`;
  }
}

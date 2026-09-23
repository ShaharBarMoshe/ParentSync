import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { SettingsService } from '../../settings/settings.service';
import { DEFAULT_SYSTEM_PROMPT } from '../services/default-system-prompt';
import { DEFAULT_CLASSIFIER_PROMPT } from '../services/default-classifier-prompt';
import {
  LLM_SYSTEM_PROMPT_KEY,
  LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY,
  LLM_CLASSIFIER_PROMPT_KEY,
  LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY,
} from '../../settings/constants/setting-keys';

/** A prompt plus a short hash of it, for folding into cache keys. */
export interface BuiltPrompt {
  prompt: string;
  version: string;
}

/**
 * The single owner of the two user-editable prompts.
 *
 * Both the extractor and the classifier prompt can be overridden in Settings,
 * and both need to be re-seeded on boot when they are *not* overridden, so a
 * shipped rule change actually reaches an installed app instead of staying
 * frozen at whatever was written on first install. That logic used to be
 * duplicated in two services' `onModuleInit`; now it is here.
 *
 * Read on every call rather than cached — SQLite is cheap, and a prompt edit
 * should take effect on the next parse without a restart.
 */
@Injectable()
export class PromptRegistry implements OnModuleInit {
  private readonly logger = new Logger(PromptRegistry.name);

  constructor(private readonly settingsService: SettingsService) {}

  async onModuleInit(): Promise<void> {
    await this.seed(
      LLM_SYSTEM_PROMPT_KEY,
      LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY,
      DEFAULT_SYSTEM_PROMPT,
      'System prompt',
    );
    await this.seed(
      LLM_CLASSIFIER_PROMPT_KEY,
      LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY,
      DEFAULT_CLASSIFIER_PROMPT,
      'Classifier prompt',
    );
  }

  /** The extraction (stage 2) prompt. */
  systemPrompt(): Promise<BuiltPrompt> {
    return this.read(LLM_SYSTEM_PROMPT_KEY, DEFAULT_SYSTEM_PROMPT);
  }

  /** The relevance-gate (stage 1) prompt. */
  classifierPrompt(): Promise<BuiltPrompt> {
    return this.read(LLM_CLASSIFIER_PROMPT_KEY, DEFAULT_CLASSIFIER_PROMPT);
  }

  private async seed(
    valueKey: string,
    isCustomKey: string,
    fallback: string,
    label: string,
  ): Promise<void> {
    const isCustomSetting = await this.settingsService
      .findByKey(isCustomKey)
      .catch(() => null);
    if (isCustomSetting?.value === 'true') return;
    await this.settingsService.create({ key: valueKey, value: fallback });
    this.logger.log(`${label} synced to latest shipped default`);
  }

  private async read(key: string, fallback: string): Promise<BuiltPrompt> {
    let prompt = fallback;
    try {
      const setting = await this.settingsService.findByKey(key);
      const value = setting?.value?.trim();
      if (value) prompt = value;
    } catch {
      // Not set — the shipped default stands.
    }
    return { prompt, version: PromptRegistry.versionOf(prompt) };
  }

  /**
   * A cache-busting fingerprint. When the prompt changes, every cached parse
   * made under the old one must miss, or a prompt fix appears to do nothing.
   */
  static versionOf(prompt: string): string {
    return crypto
      .createHash('sha256')
      .update(prompt)
      .digest('hex')
      .slice(0, 16);
  }
}

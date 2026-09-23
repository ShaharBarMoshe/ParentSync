import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { SettingsService } from '../../settings/settings.service';

export const DEFAULT_MODEL = 'gemini-2.0-flash';

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Builds the chat models every chain runs on, and owns the two settings they
 * depend on.
 *
 * A fresh model per call is deliberate: model name, temperature and token
 * budget are per-call, and the API key can change underneath us at any moment
 * via `settings.changed`. Construction opens no connection, so it is cheap.
 *
 * `maxRetries: 0` is load-bearing. LangChain retries by default; stacking that
 * on `LlmRetryPolicy` would multiply attempts (3 × 3) and — worse — would
 * retry a quota-exhausted call three times before our fast-fail could see it.
 * Retries belong to exactly one layer, and that layer is `ChainRunner`.
 */
@Injectable()
export class GeminiChatFactory implements OnModuleInit {
  private readonly logger = new Logger(GeminiChatFactory.name);
  private apiKey: string | null = null;
  private model = DEFAULT_MODEL;

  constructor(private readonly settingsService: SettingsService) {}

  async onModuleInit(): Promise<void> {
    try {
      const setting =
        await this.settingsService.findByKeyDecrypted('gemini_api_key');
      this.apiKey = setting.value.trim();
      this.logger.log('Gemini chat client configured');
    } catch {
      this.logger.warn('Gemini API key not configured in settings');
    }
    try {
      this.model = (await this.settingsService.findByKey('gemini_model')).value;
    } catch {
      this.model = DEFAULT_MODEL;
    }
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string; value: string }): void {
    if (payload.key === 'gemini_api_key') {
      this.apiKey = payload.value.trim();
      this.logger.log('Gemini API key updated');
    } else if (payload.key === 'gemini_model') {
      this.model = payload.value;
      this.logger.log(`Gemini model updated to: ${payload.value}`);
    }
  }

  /** The model name a call will use when it does not name one itself. */
  get defaultModel(): string {
    return this.model;
  }

  get configured(): boolean {
    return !!this.apiKey;
  }

  create(options: ChatOptions = {}): ChatGoogleGenerativeAI {
    if (!this.apiKey) {
      throw new Error(
        'Gemini API key not configured. Set gemini_api_key in Settings.',
      );
    }
    return new ChatGoogleGenerativeAI({
      apiKey: this.apiKey,
      model: options.model ?? this.model,
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxTokens ?? 2048,
      // See the class comment — ChainRunner owns retries.
      maxRetries: 0,
    });
  }
}

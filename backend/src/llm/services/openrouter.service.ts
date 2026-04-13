import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { firstValueFrom } from 'rxjs';
import { ILLMService, LlmMessage } from '../interfaces/llm-service.interface';
import { OpenRouterResponse } from '../dto/llm-response.dto';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const DEFAULT_MODEL = 'google/gemma-3-27b-it:free';

@Injectable()
export class OpenRouterService implements ILLMService, OnModuleInit {
  private readonly logger = new Logger(OpenRouterService.name);
  private apiKey = '';
  private defaultModel = DEFAULT_MODEL;

  constructor(
    private readonly httpService: HttpService,
    private readonly settingsService: SettingsService,
    private readonly rateLimiter: LlmRateLimiter,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    await this.loadSettings();
  }

  private async loadSettings() {
    try {
      const apiKeySetting = await this.settingsService.findByKeyDecrypted('openrouter_api_key');
      this.apiKey = apiKeySetting.value.trim();
    } catch {
      this.logger.warn('OpenRouter API key not configured in settings');
    }
    try {
      const modelSetting = await this.settingsService.findByKey('openrouter_model');
      this.defaultModel = modelSetting.value;
    } catch {
      this.defaultModel = DEFAULT_MODEL;
    }
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string; value: string }) {
    if (payload.key === 'openrouter_api_key') {
      this.apiKey = payload.value.trim();
      this.logger.log('OpenRouter API key updated');
    } else if (payload.key === 'openrouter_model') {
      this.defaultModel = payload.value;
      this.logger.log(`OpenRouter model updated to: ${payload.value}`);
    }
  }

  async callLLM(
    messages: LlmMessage[],
    model: string = this.defaultModel,
    temperature = 0.3,
    maxTokens = 2048,
  ): Promise<string> {
    // Acquire rate limit slot before making the call
    await this.rateLimiter.acquire();

    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const body = {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        };

        this.logger.log(
          `LLM request POST ${OPENROUTER_API_URL} (attempt: ${attempt}/${MAX_RETRIES})\n` +
          JSON.stringify(body, null, 2),
        );

        const response = await firstValueFrom(
          this.httpService.post<OpenRouterResponse>(
            OPENROUTER_API_URL,
            body,
            {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'ParentSync',
              },
            },
          ),
        );

        const content = response.data?.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('Empty response from OpenRouter');
        }

        const duration = Date.now() - startTime;
        this.logger.debug(
          `LLM call successful (model: ${model}, tokens: ${response.data.usage?.total_tokens ?? 'unknown'}, duration: ${duration}ms)`,
        );

        return content;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;

        // Don't retry on 4xx client errors (except 429 rate limit)
        if (status && status >= 400 && status < 500 && status !== 429) {
          const duration = Date.now() - startTime;
          this.logger.error(
            `LLM call failed with client error ${status} (${duration}ms): ${this.sanitizeError(error.message)}`,
          );
          this.emitCriticalError(status, model);
          throw error;
        }

        this.logger.warn(
          `LLM call attempt ${attempt}/${MAX_RETRIES} failed: ${this.sanitizeError(error.message)}`,
        );

        if (attempt < MAX_RETRIES) {
          const retryAfter = error.response?.headers?.['retry-after'];
          const delay = status === 429 && retryAfter
            ? Math.min(parseInt(retryAfter, 10) * 1000 || 10_000, 60_000)
            : BASE_DELAY_MS * Math.pow(2, attempt - 1);
          this.logger.warn(`Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const duration = Date.now() - startTime;
    this.logger.error(
      `LLM call failed after ${MAX_RETRIES} retries (${duration}ms): ${this.sanitizeError(lastError?.message)}`,
    );
    throw lastError;
  }

  private emitCriticalError(status: number, model: string) {
    const messages: Record<number, string> = {
      401: 'OpenRouter API key is invalid or missing. Please update it in Settings.',
      403: 'OpenRouter API key does not have access to this model. Please check your API key permissions in Settings.',
      404: `LLM model "${model}" was not found on OpenRouter. Please select a valid model in Settings.`,
    };
    const message = messages[status] || `OpenRouter API returned error ${status}. Please check your LLM settings.`;

    this.eventEmitter.emit('app.error', {
      source: 'llm',
      code: `LLM_CLIENT_ERROR_${status}`,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  private sanitizeError(message?: string): string {
    if (!message) return 'Unknown error';
    return message
      .replace(/Bearer\s+[a-zA-Z0-9\-_]+/g, 'Bearer [REDACTED]')
      .replace(/sk-[a-zA-Z0-9\-_]+/g, '[REDACTED_KEY]')
      .replace(/key[=:]\s*["']?[a-zA-Z0-9\-_]{20,}["']?/gi, 'key=[REDACTED]');
  }
}

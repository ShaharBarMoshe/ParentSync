import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { firstValueFrom } from 'rxjs';
import { ILLMService, LlmMessage } from '../interfaces/llm-service.interface';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 3;
const MAX_RETRIES_RATE_LIMIT = 5;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_DELAY_MS = 10_000;
const DEFAULT_MODEL = 'gemini-2.0-flash';

interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

@Injectable()
export class GeminiService implements ILLMService, OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
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
      const apiKeySetting = await this.settingsService.findByKeyDecrypted('gemini_api_key');
      this.apiKey = apiKeySetting.value.trim();
    } catch {
      this.logger.warn('Gemini API key not configured in settings');
    }
    try {
      const modelSetting = await this.settingsService.findByKey('gemini_model');
      this.defaultModel = modelSetting.value;
    } catch {
      this.defaultModel = DEFAULT_MODEL;
    }
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string; value: string }) {
    if (payload.key === 'gemini_api_key') {
      this.apiKey = payload.value.trim();
      this.logger.log('Gemini API key updated');
    } else if (payload.key === 'gemini_model') {
      this.defaultModel = payload.value;
      this.logger.log(`Gemini model updated to: ${payload.value}`);
    }
  }

  private convertMessages(messages: LlmMessage[]): {
    systemInstruction?: { parts: { text: string }[] };
    contents: GeminiContent[];
  } {
    let systemInstruction: { parts: { text: string }[] } | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: msg.content }] };
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return { systemInstruction, contents };
  }

  async callLLM(
    messages: LlmMessage[],
    model: string = this.defaultModel,
    temperature = 0.3,
    maxTokens = 2048,
  ): Promise<string> {
    await this.rateLimiter.acquire();

    const startTime = Date.now();
    let lastError: Error | undefined;
    const maxAttempts = MAX_RETRIES;
    let rateLimitRetries = 0;

    const { systemInstruction, contents } = this.convertMessages(messages);

    for (let attempt = 1; attempt <= maxAttempts + rateLimitRetries; attempt++) {
      try {
        const url = `${GEMINI_API_URL}/${model}:generateContent?key=${this.apiKey}`;

        const body: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
          },
        };

        if (systemInstruction) {
          body.systemInstruction = systemInstruction;
        }

        this.logger.log(
          `Gemini request POST ${GEMINI_API_URL}/${model}:generateContent (attempt: ${attempt})`,
        );

        const response = await firstValueFrom(
          this.httpService.post<GeminiResponse>(url, body, {
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        const content =
          response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!content) {
          throw new Error('Empty response from Gemini');
        }

        const duration = Date.now() - startTime;
        const tokens = response.data.usageMetadata?.totalTokenCount ?? 'unknown';
        this.logger.debug(
          `Gemini call successful (model: ${model}, tokens: ${tokens}, duration: ${duration}ms)`,
        );

        return content;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;

        // Don't retry on 4xx client errors (except 429 rate limit)
        if (status && status >= 400 && status < 500 && status !== 429) {
          const duration = Date.now() - startTime;
          const errorBody = error.response?.data?.error?.message || error.message;
          this.logger.error(
            `Gemini call failed with client error ${status} (${duration}ms): ${this.sanitizeError(errorBody)}`,
          );
          this.emitCriticalError(status, model);
          throw error;
        }

        // For 429, allow extra retries with longer delays
        if (status === 429 && rateLimitRetries < MAX_RETRIES_RATE_LIMIT) {
          rateLimitRetries++;
          const retryAfter = error.response?.headers?.['retry-after'];
          const delay = retryAfter
            ? Math.min(parseInt(retryAfter, 10) * 1000 || RATE_LIMIT_DELAY_MS, 60_000)
            : RATE_LIMIT_DELAY_MS;
          this.logger.warn(
            `Rate limited (429). Waiting ${delay}ms before retry ${rateLimitRetries}/${MAX_RETRIES_RATE_LIMIT}...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        this.logger.warn(
          `Gemini call attempt ${attempt} failed: ${this.sanitizeError(error.message)}`,
        );

        if (attempt < maxAttempts + rateLimitRetries) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          this.logger.warn(`Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const duration = Date.now() - startTime;
    this.logger.error(
      `Gemini call failed after retries (${duration}ms): ${this.sanitizeError(lastError?.message)}`,
    );
    throw lastError;
  }

  private emitCriticalError(status: number, model: string) {
    const messages: Record<number, string> = {
      400: `Gemini API returned 400 — invalid request. Check your model name "${model}" in Settings.`,
      403: 'Gemini API key is invalid or does not have access. Please update it in Settings.',
      404: `Gemini model "${model}" not found. Please select a valid model in Settings.`,
    };
    const message = messages[status] || `Gemini API returned error ${status}. Please check your LLM settings.`;

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
      .replace(/key=[a-zA-Z0-9\-_]+/g, 'key=[REDACTED]')
      .replace(/AIza[a-zA-Z0-9\-_]+/g, '[REDACTED_KEY]');
  }
}

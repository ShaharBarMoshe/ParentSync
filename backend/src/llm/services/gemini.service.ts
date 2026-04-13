import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { GoogleGenAI } from '@google/genai';
import { ILLMService, LlmMessage } from '../interfaces/llm-service.interface';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const MAX_RETRIES = 3;
const MAX_RETRIES_RATE_LIMIT = 5;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_DELAY_MS = 10_000;

@Injectable()
export class GeminiService implements ILLMService, OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
  private client: GoogleGenAI | null = null;
  private defaultModel = DEFAULT_MODEL;

  constructor(
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
      this.client = new GoogleGenAI({ apiKey: apiKeySetting.value.trim() });
      this.logger.log('Gemini client configured');
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
      this.client = new GoogleGenAI({ apiKey: payload.value.trim() });
      this.logger.log('Gemini API key updated');
    } else if (payload.key === 'gemini_model') {
      this.defaultModel = payload.value;
      this.logger.log(`Gemini model updated to: ${payload.value}`);
    }
  }

  async callLLM(
    messages: LlmMessage[],
    model: string = this.defaultModel,
    temperature = 0.3,
    maxTokens = 2048,
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Gemini API key not configured. Set gemini_api_key in Settings.');
    }

    await this.rateLimiter.acquire();

    const startTime = Date.now();
    let lastError: Error | undefined;
    const maxAttempts = MAX_RETRIES;
    let rateLimitRetries = 0;

    // Separate system instruction from conversation
    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: m.content }],
      }));

    for (let attempt = 1; attempt <= maxAttempts + rateLimitRetries; attempt++) {
      try {
        this.logger.log(
          `Gemini request (model: ${model}, attempt: ${attempt})`,
        );

        const response = await this.client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: systemInstruction || undefined,
            temperature,
            maxOutputTokens: maxTokens,
          },
        });

        const content = response.text;
        if (!content) {
          throw new Error('Empty response from Gemini');
        }

        const duration = Date.now() - startTime;
        const tokens = response.usageMetadata?.totalTokenCount ?? 'unknown';
        this.logger.debug(
          `Gemini call successful (model: ${model}, tokens: ${tokens}, duration: ${duration}ms)`,
        );

        return content;
      } catch (error) {
        lastError = error;
        const status = (error as any).status ?? (error as any).httpStatusCode;

        // Don't retry on 4xx client errors (except 429 rate limit)
        if (status && status >= 400 && status < 500 && status !== 429) {
          const duration = Date.now() - startTime;
          this.logger.error(
            `Gemini call failed with error ${status} (${duration}ms): ${this.sanitizeError(error.message)}`,
          );
          this.emitCriticalError(status, model);
          throw error;
        }

        // For 429, allow extra retries with longer delays
        if (status === 429 && rateLimitRetries < MAX_RETRIES_RATE_LIMIT) {
          rateLimitRetries++;
          const delay = RATE_LIMIT_DELAY_MS;
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

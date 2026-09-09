import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { GoogleGenAI } from '@google/genai';
import { ILLMService, LlmMessage } from '../interfaces/llm-service.interface';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';
import { LlmRetryPolicy, sanitizeLlmError } from './llm-retry-policy';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

const DEFAULT_MODEL = 'gemini-2.0-flash';

@Injectable()
export class GeminiService implements ILLMService, OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
  private client: GoogleGenAI | null = null;
  private defaultModel = DEFAULT_MODEL;
  private readonly retryPolicy: LlmRetryPolicy;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly rateLimiter: LlmRateLimiter,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.retryPolicy = new LlmRetryPolicy(
      this.logger,
      {
        onClientError: (status, model) => this.emitCriticalError(status, model),
        onQuotaExhausted: () => this.emitQuotaExhausted(),
      },
      sanitizeLlmError,
    );
  }

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

    // Separate system instruction from conversation
    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const parts: Array<
          { text: string } | { inlineData: { mimeType: string; data: string } }
        > = [{ text: m.content }];
        if (m.role === 'user' && m.images?.length) {
          for (const img of m.images) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          }
        }
        return {
          role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
          parts,
        };
      });

    return this.retryPolicy.execute(async (attempt) => {
      this.logger.log(`Gemini request (model: ${model}, attempt: ${attempt})`);

      const response = await this.client!.models.generateContent({
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

      const tokens = response.usageMetadata?.totalTokenCount ?? 'unknown';
      this.logger.debug(
        `Gemini call successful (model: ${model}, tokens: ${tokens}, duration: ${Date.now() - startTime}ms)`,
      );

      return content;
    }, model);
  }

  private emitQuotaExhausted() {
    this.eventEmitter.emit('app.error', {
      source: 'llm',
      code: AppErrorCodes.LLM_QUOTA_EXHAUSTED,
      message:
        'Gemini rejected the request because the API quota or prepaid credit ' +
        'is exhausted. Parsing is paused until the Google AI Studio project ' +
        'has credit again — see https://ai.studio/projects.',
      timestamp: new Date().toISOString(),
    });
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

}

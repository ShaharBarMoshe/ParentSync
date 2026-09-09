import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ContentBlock } from '@langchain/core/messages';
import { ILLMService, LlmMessage } from '../interfaces/llm-service.interface';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';
import { TracingService } from '../observability/tracing.service';
import { LlmRetryPolicy, sanitizeLlmError } from './llm-retry-policy';

const DEFAULT_MODEL = 'gemini-2.0-flash';

/**
 * LangChain-backed implementation of the `ILLMService` port.
 *
 * Deliberately keeps everything the hand-rolled Gemini adapter learned the
 * hard way — the rate limiter, the retry ladder, quota fast-fail, key
 * sanitization, `app.error` emissions and settings hot-reload — and delegates
 * only the transport to LangChain. What LangChain adds is structured output
 * (see `MessageParserService`) and a traced run per call.
 *
 * `maxRetries: 0` is load-bearing: LangChain retries by default, and stacking
 * that on `LlmRetryPolicy` would multiply attempts (3 × 3) and, worse, retry a
 * quota-exhausted call before our fast-fail could see it.
 */
@Injectable()
export class LangChainLlmService implements ILLMService, OnModuleInit {
  private readonly logger = new Logger(LangChainLlmService.name);
  private apiKey: string | null = null;
  private defaultModel = DEFAULT_MODEL;
  private readonly retryPolicy: LlmRetryPolicy;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly rateLimiter: LlmRateLimiter,
    private readonly eventEmitter: EventEmitter2,
    private readonly tracingService: TracingService,
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

  async onModuleInit(): Promise<void> {
    await this.loadSettings();
  }

  private async loadSettings(): Promise<void> {
    try {
      const setting =
        await this.settingsService.findByKeyDecrypted('gemini_api_key');
      this.apiKey = setting.value.trim();
      this.logger.log('LangChain Gemini client configured');
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
  handleSettingsChanged(payload: { key: string; value: string }): void {
    if (payload.key === 'gemini_api_key') {
      this.apiKey = payload.value.trim();
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
    if (!this.apiKey) {
      throw new Error(
        'Gemini API key not configured. Set gemini_api_key in Settings.',
      );
    }

    await this.rateLimiter.acquire();

    const chat = this.buildChatModel(model, temperature, maxTokens);
    const lcMessages = LangChainLlmService.toLangChainMessages(messages);
    const callbacks = await this.tracingService.callbacks();
    const startTime = Date.now();

    return this.retryPolicy.execute(async (attempt) => {
      this.logger.log(`Gemini request (model: ${model}, attempt: ${attempt})`);

      const response = await chat.invoke(lcMessages, { callbacks });
      const content = LangChainLlmService.textOf(response.content);
      if (!content) {
        throw new Error('Empty response from Gemini');
      }

      const usage = response.response_metadata?.tokenUsage as
        | { totalTokens?: number }
        | undefined;
      const tokens =
        response.usage_metadata?.total_tokens ?? usage?.totalTokens ?? 'unknown';
      this.logger.debug(
        `Gemini call successful (model: ${model}, tokens: ${tokens}, duration: ${Date.now() - startTime}ms)`,
      );

      return content;
    }, model);
  }

  /**
   * A fresh client per call: model, temperature and token budget are all
   * per-call parameters, and the API key can change under us at any time via
   * `settings.changed`. Construction is cheap — it opens no connection.
   */
  private buildChatModel(
    model: string,
    temperature: number,
    maxTokens: number,
  ): ChatGoogleGenerativeAI {
    return new ChatGoogleGenerativeAI({
      apiKey: this.apiKey!,
      model,
      temperature,
      maxOutputTokens: maxTokens,
      // See the class comment — our ladder owns retries.
      maxRetries: 0,
    });
  }

  /**
   * Map the port's message shape onto LangChain's.
   *
   * System messages become a real `SystemMessage` rather than being folded
   * into the first user turn: Gemini treats a system instruction differently
   * from user text, and the extraction prompts depend on that.
   */
  static toLangChainMessages(messages: LlmMessage[]): BaseMessage[] {
    return messages.map((m) => {
      if (m.role === 'system') return new SystemMessage(m.content);
      if (m.role === 'assistant') return new AIMessage(m.content);

      if (!m.images?.length) return new HumanMessage(m.content);

      // LangChain v1 carries base64 media natively, so the provider adapter
      // builds Gemini's inlineData part itself — no data: URL round-trip.
      const parts: ContentBlock[] = [{ type: 'text', text: m.content }];
      for (const image of m.images) {
        parts.push({
          type: 'image',
          mimeType: image.mimeType,
          data: image.data,
        });
      }
      return new HumanMessage({ content: parts });
    });
  }

  /** LangChain content is a string or an array of parts; we only want text. */
  private static textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && 'text' in part
            ? String((part as { text: unknown }).text)
            : '',
      )
      .join('');
  }

  private emitQuotaExhausted(): void {
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

  private emitCriticalError(status: number, model: string): void {
    const messages: Record<number, string> = {
      400: `Gemini API returned 400 — invalid request. Check your model name "${model}" in Settings.`,
      403: 'Gemini API key is invalid or does not have access. Please update it in Settings.',
      404: `Gemini model "${model}" not found. Please select a valid model in Settings.`,
    };
    const message =
      messages[status] ||
      `Gemini API returned error ${status}. Please check your LLM settings.`;

    this.eventEmitter.emit('app.error', {
      source: 'llm',
      code: `LLM_CLIENT_ERROR_${status}`,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Runnable } from '@langchain/core/runnables';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { TracingService } from '../observability/tracing.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';
import { LlmRetryPolicy, sanitizeLlmError } from '../services/llm-retry-policy';

/**
 * The one place a chain meets the outside world.
 *
 * Every provider call in the app goes through `run()`, which applies, in
 * order: the shared rate limiter, the retry ladder, and the LangSmith
 * callbacks for this invocation. Putting it here rather than at each call site
 * is the point — the previous design re-derived these rules per call site, and
 * the rules that matter (never retry a 4xx, never retry an exhausted account)
 * are exactly the ones that silently drift apart when duplicated.
 *
 * `LlmRetryPolicy` stays rather than moving to LangChain's `withRetry`:
 * LangChain's generic retry cannot tell a transient 429 from a depleted
 * account, and would burn the full ladder — plus, previously, a per-group
 * fallback pass — on an error only a human topping up the account can clear.
 *
 * The rate limiter likewise stays ours rather than LangChain's
 * `InMemoryRateLimiter`: this version of `ChatGoogleGenerativeAI` exposes no
 * `rateLimiter` option, a model-bound limiter would reset with each per-call
 * model instance, and ours also gates the embedding path a chat-model limiter
 * could never see.
 */
@Injectable()
export class ChainRunner {
  private readonly logger = new Logger(ChainRunner.name);
  private readonly retryPolicy: LlmRetryPolicy;

  constructor(
    private readonly rateLimiter: LlmRateLimiter,
    private readonly tracingService: TracingService,
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

  /**
   * Invoke a composed chain under the full policy.
   *
   * `runName` names the run in LangSmith; give each call site a distinct one
   * or a trace becomes an undifferentiated pile of `RunnableSequence`s.
   */
  async run<I, O>(
    chain: Runnable<I, O>,
    input: I,
    opts: { model: string; runName: string },
  ): Promise<O> {
    await this.rateLimiter.acquire();
    const callbacks = await this.tracingService.callbacks();
    const startTime = Date.now();

    return this.retryPolicy.execute(async (attempt) => {
      this.logger.log(
        `${opts.runName} (model: ${opts.model}, attempt: ${attempt})`,
      );
      const result = await chain.invoke(input, {
        callbacks,
        runName: opts.runName,
      });
      this.logger.debug(
        `${opts.runName} succeeded in ${Date.now() - startTime}ms`,
      );
      return result;
    }, opts.model);
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
    this.eventEmitter.emit('app.error', {
      source: 'llm',
      code: `LLM_CLIENT_ERROR_${status}`,
      message:
        messages[status] ||
        `Gemini API returned error ${status}. Please check your LLM settings.`,
      timestamp: new Date().toISOString(),
    });
  }
}

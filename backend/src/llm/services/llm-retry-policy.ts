import { Logger } from '@nestjs/common';
import {
  LlmQuotaExhaustedError,
  isQuotaExhaustedError,
} from '../errors/llm-quota-exhausted.error';

export const MAX_RETRIES = 3;
export const MAX_RETRIES_RATE_LIMIT = 5;
export const BASE_DELAY_MS = 1000;
export const RATE_LIMIT_DELAY_MS = 10_000;

export interface RetryPolicyHooks {
  /** A non-retryable 4xx came back (invalid key, bad model, malformed request). */
  onClientError(status: number, model: string): void;
  /** The account is out of quota or credit — no retry can fix it. */
  onQuotaExhausted(): void;
}

/**
 * The retry ladder shared by every LLM adapter.
 *
 * Extracted so the Gemini-SDK and LangChain adapters cannot drift apart on the
 * rules that actually cost money and lose school events:
 *
 * - **4xx other than 429**: never retried. A wrong model name or a revoked key
 *   fails the same way five times; retrying just delays the error the user
 *   needs to see.
 * - **Exhausted quota**: fails immediately, even though it arrives as a 429.
 *   Only a human topping up the account clears it, so burning the whole ladder
 *   (and then the batch parser's per-message fallback) on it wastes minutes
 *   per sync and floods the log.
 * - **Transient 429**: a separate, longer ladder — this one does clear on its
 *   own.
 * - **Everything else**: exponential backoff.
 *
 * The provider SDK's own retry must be disabled where this is used, or the two
 * ladders multiply.
 */
export class LlmRetryPolicy {
  constructor(
    private readonly logger: Logger,
    private readonly hooks: RetryPolicyHooks,
    private readonly sanitize: (message?: string) => string,
  ) {}

  async execute<T>(
    call: (attempt: number) => Promise<T>,
    model: string,
  ): Promise<T> {
    const startTime = Date.now();
    let lastError: Error | undefined;
    let rateLimitRetries = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES + rateLimitRetries; attempt++) {
      try {
        return await call(attempt);
      } catch (error) {
        lastError = error as Error;
        const status = this.statusOf(error);

        if (status && status >= 400 && status < 500 && status !== 429) {
          this.logger.error(
            `LLM call failed with error ${status} (${Date.now() - startTime}ms): ` +
              this.sanitize((error as Error).message),
          );
          this.hooks.onClientError(status, model);
          throw error;
        }

        if (isQuotaExhaustedError(error)) {
          this.logger.error(
            `LLM quota/credit exhausted after ${Date.now() - startTime}ms — not retrying: ` +
              this.sanitize((error as Error).message),
          );
          this.hooks.onQuotaExhausted();
          throw new LlmQuotaExhaustedError(
            this.sanitize((error as Error).message),
            error,
          );
        }

        if (status === 429 && rateLimitRetries < MAX_RETRIES_RATE_LIMIT) {
          rateLimitRetries++;
          this.logger.warn(
            `Rate limited (429). Waiting ${RATE_LIMIT_DELAY_MS}ms before retry ` +
              `${rateLimitRetries}/${MAX_RETRIES_RATE_LIMIT}...`,
          );
          await this.sleep(RATE_LIMIT_DELAY_MS);
          continue;
        }

        this.logger.warn(
          `LLM call attempt ${attempt} failed: ${this.sanitize((error as Error).message)}`,
        );

        if (attempt < MAX_RETRIES + rateLimitRetries) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          this.logger.warn(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    this.logger.error(
      `LLM call failed after retries (${Date.now() - startTime}ms): ` +
        this.sanitize(lastError?.message),
    );
    throw lastError;
  }

  /**
   * Providers report HTTP status inconsistently — the Gemini SDK uses `status`
   * or `httpStatusCode`, LangChain surfaces the underlying error and often
   * only leaves the code in the message.
   */
  private statusOf(error: unknown): number | undefined {
    const e = error as Record<string, any>;
    const direct =
      e?.status ?? e?.httpStatusCode ?? e?.code ?? e?.response?.status;
    if (typeof direct === 'number') return direct;

    const message = typeof e?.message === 'string' ? e.message : '';
    const match = message.match(/\b(4\d{2}|5\d{2})\b/);
    return match ? Number(match[1]) : undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Strip API keys out of anything headed for a log or a thrown message. */
export function sanitizeLlmError(message?: string): string {
  if (!message) return 'Unknown error';
  return message
    .replace(/key=[a-zA-Z0-9\-_]+/g, 'key=[REDACTED]')
    .replace(/AIza[a-zA-Z0-9\-_]+/g, '[REDACTED_KEY]');
}

/**
 * The LLM provider rejected the call because the account's quota or credit is
 * gone — not because we were briefly too fast.
 *
 * Google returns HTTP 429 / `RESOURCE_EXHAUSTED` for both cases, but they need
 * opposite handling:
 *
 * - a per-minute rate limit clears in seconds, so backing off and retrying is
 *   exactly right;
 * - depleted prepaid credit does not clear until a human tops up the account,
 *   so every retry is guaranteed to fail. Retrying it 8 times per message, and
 *   then again per message in the batch parser's individual fallback, turns one
 *   dead account into hours of pointless traffic and a flooded log.
 *
 * Callers should treat this as "stop the current pass and try again next sync".
 */
export class LlmQuotaExhaustedError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmQuotaExhaustedError';
  }
}

/**
 * True when a provider error means the account is out of quota/credit rather
 * than momentarily rate limited.
 *
 * Deliberately conservative: only wording that names billing, credit or a
 * depleted plan counts. A bare 429 stays retryable, so a genuine per-minute
 * limit keeps its existing backoff behaviour.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
  if (error instanceof LlmQuotaExhaustedError) return true;

  const message = (error as Error)?.message?.toLowerCase() ?? '';
  if (!message) return false;

  return (
    message.includes('credits are depleted') ||
    message.includes('prepayment') ||
    message.includes('billing account') ||
    message.includes('quota exceeded for quota metric') ||
    message.includes('exceeded your current quota') ||
    message.includes('free tier is not available')
  );
}

import {
  LlmQuotaExhaustedError,
  isQuotaExhaustedError,
} from './llm-quota-exhausted.error';

describe('isQuotaExhaustedError', () => {
  it('recognises the depleted-prepaid-credit error Google actually returns', () => {
    const err = new Error(
      '{"error":{"code":429,"message":"Your prepayment credits are depleted. ' +
        'Please go to AI Studio at https://ai.studio/projects to manage your ' +
        'project and billing.","status":"RESOURCE_EXHAUSTED"}}',
    );
    expect(isQuotaExhaustedError(err)).toBe(true);
  });

  it('recognises a blown quota metric', () => {
    expect(
      isQuotaExhaustedError(
        new Error('Quota exceeded for quota metric generate_requests'),
      ),
    ).toBe(true);
    expect(
      isQuotaExhaustedError(
        new Error('You exceeded your current quota, please check your plan'),
      ),
    ).toBe(true);
  });

  it('recognises its own error type', () => {
    expect(isQuotaExhaustedError(new LlmQuotaExhaustedError('gone'))).toBe(true);
  });

  it('leaves a plain per-minute rate limit retryable', () => {
    expect(
      isQuotaExhaustedError(new Error('429 Too Many Requests - rate limited')),
    ).toBe(false);
    expect(
      isQuotaExhaustedError(
        new Error('Resource has been exhausted (e.g. check quota).'),
      ),
    ).toBe(false);
  });

  it('is safe on non-errors', () => {
    expect(isQuotaExhaustedError(null)).toBe(false);
    expect(isQuotaExhaustedError(undefined)).toBe(false);
    expect(isQuotaExhaustedError({})).toBe(false);
  });
});

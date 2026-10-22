import { Logger } from '@nestjs/common';
import { LlmRetryPolicy, sanitizeLlmError } from './llm-retry-policy';
import { LlmQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';

describe('LlmRetryPolicy', () => {
  let policy: LlmRetryPolicy;
  let hooks: { onClientError: jest.Mock; onQuotaExhausted: jest.Mock };

  beforeEach(() => {
    jest.restoreAllMocks();
    // Collapse backoff so the ladder runs at test speed.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    const logger = new Logger('test');
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    hooks = { onClientError: jest.fn(), onQuotaExhausted: jest.fn() };
    policy = new LlmRetryPolicy(logger, hooks, sanitizeLlmError);
  });

  it('returns the first successful result without retrying', async () => {
    const call = jest.fn().mockResolvedValue('ok');
    await expect(policy.execute(call, 'm')).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure up to the ceiling, then throws', async () => {
    const call = jest.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(policy.execute(call, 'm')).rejects.toThrow('socket hang up');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404])(
    'never retries a %s and reports it once',
    async (status) => {
      const call = jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('client error'), { status }));

      await expect(policy.execute(call, 'm')).rejects.toThrow('client error');
      expect(call).toHaveBeenCalledTimes(1);
      expect(hooks.onClientError).toHaveBeenCalledWith(status, 'm');
    },
  );

  it('fails a depleted account immediately, without retrying', async () => {
    const call = jest
      .fn()
      .mockRejectedValue(new Error('prepayment credits are depleted'));

    await expect(policy.execute(call, 'm')).rejects.toBeInstanceOf(
      LlmQuotaExhaustedError,
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(hooks.onQuotaExhausted).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a plain 429, which does clear on its own', async () => {
    const call = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('429 Too Many Requests'), { status: 429 }),
      )
      .mockResolvedValue('recovered');

    await expect(policy.execute(call, 'm')).resolves.toBe('recovered');
    expect(call).toHaveBeenCalledTimes(2);
  });

  /**
   * LangChain surfaces provider errors without a numeric status field, leaving
   * the code only in the message — so the policy has to read both shapes or it
   * would retry a dead API key three times.
   */
  describe('reading the status from either shape', () => {
    it.each([
      ['status field', Object.assign(new Error('x'), { status: 403 })],
      ['httpStatusCode field', Object.assign(new Error('x'), { httpStatusCode: 403 })],
      ['response.status', Object.assign(new Error('x'), { response: { status: 403 } })],
      ['message text', new Error('Error 403: permission denied')],
    ])('recognises a 4xx from a %s', async (_label, error) => {
      const call = jest.fn().mockRejectedValue(error);

      await expect(policy.execute(call, 'm')).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
      expect(hooks.onClientError).toHaveBeenCalledWith(403, 'm');
    });

    it('does not mistake an unrelated number for a status', async () => {
      const call = jest.fn().mockRejectedValue(new Error('parsed 42 events'));

      await expect(policy.execute(call, 'm')).rejects.toThrow('parsed 42 events');
      // No status found → treated as transient → full ladder.
      expect(call).toHaveBeenCalledTimes(3);
    });
  });

  describe('sanitizeLlmError', () => {
    it('redacts key= parameters and bare Google keys', () => {
      expect(sanitizeLlmError('failed key=abc123DEF')).toBe(
        'failed key=[REDACTED]',
      );
      expect(sanitizeLlmError('bad AIzaSyABC-123_x key')).toBe(
        'bad [REDACTED_KEY] key',
      );
    });

    it('handles a missing message', () => {
      expect(sanitizeLlmError(undefined)).toBe('Unknown error');
    });
  });
});

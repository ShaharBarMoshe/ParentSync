import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RunnableLambda } from '@langchain/core/runnables';
import { ChainRunner } from './chain-runner.service';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { TracingService } from '../observability/tracing.service';
import { LlmQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

jest.setTimeout(20000);

describe('ChainRunner', () => {
  let runner: ChainRunner;
  let rateLimiter: { acquire: jest.Mock };
  let tracing: { callbacks: jest.Mock };
  let emitter: { emit: jest.Mock };

  /** A chain whose behaviour per attempt the test controls. */
  const chainOf = (impl: jest.Mock) =>
    RunnableLambda.from(async (input: unknown) => impl(input));

  const opts = { model: 'gemini-2.0-flash', runName: 'test-run' };

  beforeEach(async () => {
    rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) };
    tracing = { callbacks: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChainRunner,
        { provide: LlmRateLimiter, useValue: rateLimiter },
        { provide: TracingService, useValue: tracing },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    runner = module.get(ChainRunner);
    // Keep the retry ladder's backoff from making the suite slow.
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the chain output on success', async () => {
    const impl = jest.fn().mockResolvedValue({ ok: true });
    await expect(runner.run(chainOf(impl), 'in', opts)).resolves.toEqual({
      ok: true,
    });
  });

  it('acquires a rate-limiter slot before calling the provider', async () => {
    const order: string[] = [];
    rateLimiter.acquire.mockImplementation(async () => {
      order.push('acquire');
    });
    const impl = jest.fn().mockImplementation(async () => {
      order.push('invoke');
      return 'x';
    });
    await runner.run(chainOf(impl), 'in', opts);
    expect(order).toEqual(['acquire', 'invoke']);
  });

  it('asks the tracing service for callbacks on every run', async () => {
    await runner.run(chainOf(jest.fn().mockResolvedValue('x')), 'in', opts);
    expect(tracing.callbacks).toHaveBeenCalled();
  });

  describe('retry ladder', () => {
    it('retries a transient failure and returns the eventual success', async () => {
      const impl = jest
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue('recovered');
      await expect(runner.run(chainOf(impl), 'in', opts)).resolves.toBe(
        'recovered',
      );
      expect(impl).toHaveBeenCalledTimes(2);
    });

    it('never retries a non-429 client error, and reports it to the user', async () => {
      const error: any = new Error('bad model');
      error.status = 404;
      const impl = jest.fn().mockRejectedValue(error);

      await expect(runner.run(chainOf(impl), 'in', opts)).rejects.toThrow(
        'bad model',
      );
      expect(impl).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        'app.error',
        expect.objectContaining({ code: 'LLM_CLIENT_ERROR_404' }),
      );
    });

    it('fails fast on an exhausted account instead of burning the ladder', async () => {
      const impl = jest
        .fn()
        .mockRejectedValue(
          new Error('429 You exceeded your current quota, please check your plan'),
        );

      await expect(runner.run(chainOf(impl), 'in', opts)).rejects.toThrow(
        LlmQuotaExhaustedError,
      );
      expect(impl).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        'app.error',
        expect.objectContaining({ code: AppErrorCodes.LLM_QUOTA_EXHAUSTED }),
      );
    });

    it('keeps the API key out of the quota error it surfaces', async () => {
      const impl = jest
        .fn()
        .mockRejectedValue(
          new Error(
            'You exceeded your current quota (key=AIzaSyTOPSECRET123)',
          ),
        );

      // The quota error is the one that reaches the user, via `app.error` and
      // the sync log — so it is the one that must not carry the key.
      await expect(runner.run(chainOf(impl), 'in', opts)).rejects.toThrow(
        /key=\[REDACTED\]/,
      );
      await expect(runner.run(chainOf(impl), 'in', opts)).rejects.not.toThrow(
        /AIzaSyTOPSECRET123/,
      );
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GeminiService } from './gemini.service';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';
import { LlmQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

const generateContentMock = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: generateContentMock },
  })),
}));

describe('GeminiService', () => {
  let service: GeminiService;
  let module: TestingModule;

  beforeEach(async () => {
    generateContentMock.mockReset();
    generateContentMock.mockResolvedValue({
      text: '[]',
      usageMetadata: { totalTokenCount: 7 },
    });

    module = await Test.createTestingModule({
      providers: [
        GeminiService,
        {
          provide: SettingsService,
          useValue: {
            findByKey: jest.fn().mockImplementation((key: string) =>
              key === 'gemini_model'
                ? Promise.resolve({ value: 'gemini-2.0-flash' })
                : Promise.reject(new Error('Not found')),
            ),
            findByKeyDecrypted: jest.fn().mockImplementation((key: string) =>
              key === 'gemini_api_key'
                ? Promise.resolve({ value: 'test-key' })
                : Promise.reject(new Error('Not found')),
            ),
          },
        },
        {
          provide: LlmRateLimiter,
          useValue: { acquire: jest.fn().mockResolvedValue(undefined) },
        },
        EventEmitter2,
      ],
    }).compile();

    service = module.get(GeminiService);
    await service.onModuleInit();
  });

  it('separates the system message into systemInstruction', async () => {
    await service.callLLM([
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'hi' },
    ]);

    const call = generateContentMock.mock.calls[0][0];
    expect(call.config.systemInstruction).toBe('be precise');
    expect(call.contents).toHaveLength(1);
    expect(call.contents[0].role).toBe('user');
    expect(call.contents[0].parts).toEqual([{ text: 'hi' }]);
  });

  it('appends inlineData parts for images on a user message', async () => {
    await service.callLLM([
      { role: 'system', content: 'extract events' },
      {
        role: 'user',
        content: 'see attached',
        images: [
          { mimeType: 'image/jpeg', data: 'AAAA' },
          { mimeType: 'image/png', data: 'BBBB' },
        ],
      },
    ]);

    const call = generateContentMock.mock.calls[0][0];
    expect(call.contents[0].role).toBe('user');
    expect(call.contents[0].parts).toEqual([
      { text: 'see attached' },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
      { inlineData: { mimeType: 'image/png', data: 'BBBB' } },
    ]);
  });

  it('does not attach images to assistant messages', async () => {
    await service.callLLM([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      // images on assistant should be ignored — not a user input
      { role: 'assistant', content: 'a', images: [{ mimeType: 'image/jpeg', data: 'X' }] },
    ]);

    const call = generateContentMock.mock.calls[0][0];
    const assistantMsg = call.contents.find((c: any) => c.role === 'model');
    expect(assistantMsg.parts).toEqual([{ text: 'a' }]);
  });

  it('omits inlineData parts when images is empty', async () => {
    await service.callLLM([
      { role: 'user', content: 'plain', images: [] },
    ]);

    const call = generateContentMock.mock.calls[0][0];
    expect(call.contents[0].parts).toEqual([{ text: 'plain' }]);
  });

  it('uses the configured model and forwards the response text', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: 'hello back',
      usageMetadata: { totalTokenCount: 3 },
    });

    const result = await service.callLLM(
      [{ role: 'user', content: 'hi' }],
      'gemini-2.5-flash',
    );

    expect(generateContentMock.mock.calls[0][0].model).toBe('gemini-2.5-flash');
    expect(result).toBe('hello back');
  });
  describe('exhausted quota vs transient rate limit', () => {
    const depleted = () => {
      const err: any = new Error(
        '{"error":{"code":429,"message":"Your prepayment credits are depleted. ' +
          'Please go to AI Studio at https://ai.studio/projects to manage your ' +
          'project and billing.","status":"RESOURCE_EXHAUSTED"}}',
      );
      err.status = 429;
      return err;
    };

    const rateLimited = () => {
      const err: any = new Error('429 Too Many Requests');
      err.status = 429;
      return err;
    };

    it('fails immediately on a depleted account instead of retrying', async () => {
      generateContentMock.mockRejectedValue(depleted());

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).rejects.toThrow(LlmQuotaExhaustedError);

      // One attempt only — no backoff ladder against an account that cannot pay.
      expect(generateContentMock).toHaveBeenCalledTimes(1);
    });

    it('emits LLM_QUOTA_EXHAUSTED so the UI can surface it', async () => {
      generateContentMock.mockRejectedValue(depleted());
      const emitter = module.get(EventEmitter2);
      const emitted: any[] = [];
      emitter.on('app.error', (e: unknown) => emitted.push(e));

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).rejects.toThrow(LlmQuotaExhaustedError);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual(
        expect.objectContaining({
          source: 'llm',
          code: AppErrorCodes.LLM_QUOTA_EXHAUSTED,
        }),
      );
    });

    it('still retries a plain per-minute rate limit', async () => {
      generateContentMock
        .mockRejectedValueOnce(rateLimited())
        .mockResolvedValue({ text: '[]', usageMetadata: { totalTokenCount: 1 } });

      // The retry waits RATE_LIMIT_DELAY_MS (10s) for real; skip it.
      jest.useFakeTimers();
      try {
        const pending = service.callLLM([{ role: 'user', content: 'hi' }]);
        await jest.advanceTimersByTimeAsync(11_000);
        await expect(pending).resolves.toBe('[]');
      } finally {
        jest.useRealTimers();
      }

      expect(generateContentMock).toHaveBeenCalledTimes(2);
    });

    it('does not redact-leak the API key into the thrown message', async () => {
      const err: any = new Error(
        'prepayment credits are depleted (key=AIzaSECRETVALUE123)',
      );
      err.status = 429;
      generateContentMock.mockRejectedValue(err);

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).rejects.toThrow(/REDACTED/);
    });
  });
});

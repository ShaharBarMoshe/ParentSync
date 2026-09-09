import { EventEmitter2 } from '@nestjs/event-emitter';
import { LangChainLlmService } from './langchain-llm.service';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';
import { TracingService } from '../observability/tracing.service';
import { LlmQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';

const invoke = jest.fn();
const constructorCalls: any[] = [];

jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest.fn().mockImplementation((config: unknown) => {
    constructorCalls.push(config);
    return { invoke };
  }),
}));

describe('LangChainLlmService', () => {
  let service: LangChainLlmService;
  let eventEmitter: EventEmitter2;
  let emitted: any[];
  let rateLimiter: { acquire: jest.Mock };
  let tracing: { callbacks: jest.Mock };
  let settings: Record<string, string>;

  beforeEach(async () => {
    jest.clearAllMocks();
    constructorCalls.length = 0;
    emitted = [];
    settings = { gemini_api_key: 'AIzaTESTKEY', gemini_model: 'gemini-2.5-flash-lite' };

    const settingsService = {
      findByKey: jest.fn(async (key: string) => {
        if (!(key in settings)) throw new Error('not found');
        return { key, value: settings[key] };
      }),
      findByKeyDecrypted: jest.fn(async (key: string) => {
        if (!(key in settings)) throw new Error('not found');
        return { key, value: settings[key] };
      }),
    } as unknown as SettingsService;

    rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) };
    tracing = { callbacks: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = new EventEmitter2();
    eventEmitter.onAny((_event: string, payload: unknown) => emitted.push(payload));

    service = new LangChainLlmService(
      settingsService,
      rateLimiter as unknown as LlmRateLimiter,
      eventEmitter,
      tracing as unknown as TracingService,
    );
    await service.onModuleInit();

    invoke.mockResolvedValue(new AIMessage('[]'));
  });

  /** Fails the test fast rather than hanging on a real backoff sleep. */
  function noBackoff() {
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);
  }

  describe('message mapping', () => {
    it('maps a system message to SystemMessage, not a user turn', () => {
      const [first] = LangChainLlmService.toLangChainMessages([
        { role: 'system', content: 'You are an extractor.' },
      ]);
      expect(first).toBeInstanceOf(SystemMessage);
      expect(first.content).toBe('You are an extractor.');
    });

    it('maps assistant to AIMessage and user to HumanMessage', () => {
      const [assistant, user] = LangChainLlmService.toLangChainMessages([
        { role: 'assistant', content: 'prior' },
        { role: 'user', content: 'now' },
      ]);
      expect(assistant).toBeInstanceOf(AIMessage);
      expect(user).toBeInstanceOf(HumanMessage);
    });

    it('attaches images as native multimodal blocks on a user message', () => {
      const [msg] = LangChainLlmService.toLangChainMessages([
        {
          role: 'user',
          content: 'see flyer',
          images: [{ mimeType: 'image/png', data: 'BASE64DATA' }],
        },
      ]);

      expect(msg.content).toEqual([
        { type: 'text', text: 'see flyer' },
        { type: 'image', mimeType: 'image/png', data: 'BASE64DATA' },
      ]);
    });

    it('does not attach images to an assistant message', () => {
      const [msg] = LangChainLlmService.toLangChainMessages([
        {
          role: 'assistant',
          content: 'reply',
          images: [{ mimeType: 'image/png', data: 'X' }],
        },
      ]);
      expect(msg.content).toBe('reply');
    });

    it('keeps content a plain string when images is empty', () => {
      const [msg] = LangChainLlmService.toLangChainMessages([
        { role: 'user', content: 'text only', images: [] },
      ]);
      expect(msg.content).toBe('text only');
    });
  });

  describe('calling', () => {
    it('uses the configured model and returns the response text', async () => {
      invoke.mockResolvedValue(new AIMessage('{"ok":true}'));

      const result = await service.callLLM([{ role: 'user', content: 'hi' }]);

      expect(result).toBe('{"ok":true}');
      expect(constructorCalls[0].model).toBe('gemini-2.5-flash-lite');
    });

    it('acquires the rate limiter before calling', async () => {
      await service.callLLM([{ role: 'user', content: 'hi' }]);
      expect(rateLimiter.acquire).toHaveBeenCalledTimes(1);
    });

    /**
     * Load-bearing: LangChain retries by default, and stacking that on our
     * ladder would multiply attempts and retry a quota error before the
     * fast-fail could see it.
     */
    it('disables LangChain’s own retries', async () => {
      await service.callLLM([{ role: 'user', content: 'hi' }]);
      expect(constructorCalls[0].maxRetries).toBe(0);
    });

    it('passes tracing callbacks through when tracing is on', async () => {
      const cb = [{ name: 'tracer' }];
      tracing.callbacks.mockResolvedValue(cb);

      await service.callLLM([{ role: 'user', content: 'hi' }]);

      expect(invoke).toHaveBeenCalledWith(expect.anything(), { callbacks: cb });
    });

    it('passes undefined callbacks when tracing is off', async () => {
      await service.callLLM([{ role: 'user', content: 'hi' }]);
      expect(invoke).toHaveBeenCalledWith(expect.anything(), {
        callbacks: undefined,
      });
    });

    it('joins array content into a single string', async () => {
      invoke.mockResolvedValue(
        new AIMessage({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
      );

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).resolves.toBe('ab');
    });

    it('throws without an API key rather than calling out', async () => {
      const bare = new LangChainLlmService(
        { findByKey: jest.fn().mockRejectedValue(new Error('x')),
          findByKeyDecrypted: jest.fn().mockRejectedValue(new Error('x')) } as unknown as SettingsService,
        rateLimiter as unknown as LlmRateLimiter,
        eventEmitter,
        tracing as unknown as TracingService,
      );
      await bare.onModuleInit();

      await expect(bare.callLLM([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'Gemini API key not configured',
      );
      expect(invoke).not.toHaveBeenCalled();
    });

    it('treats an empty response as a failure', async () => {
      noBackoff();
      invoke.mockResolvedValue(new AIMessage(''));

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).rejects.toThrow('Empty response');
    });
  });

  describe('errors and retries', () => {
    it('does not retry a 4xx and reports it to the UI', async () => {
      const err = Object.assign(new Error('bad model'), { status: 404 });
      invoke.mockRejectedValue(err);

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }], 'nope-model'),
      ).rejects.toThrow('bad model');

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(emitted).toContainEqual(
        expect.objectContaining({ code: 'LLM_CLIENT_ERROR_404' }),
      );
    });

    it('fails immediately on a depleted account instead of retrying', async () => {
      invoke.mockRejectedValue(
        Object.assign(
          new Error('429 You exceeded your current quota. RESOURCE_EXHAUSTED'),
          { status: 429 },
        ),
      );

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).rejects.toBeInstanceOf(LlmQuotaExhaustedError);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(emitted).toContainEqual(
        expect.objectContaining({ code: AppErrorCodes.LLM_QUOTA_EXHAUSTED }),
      );
    });

    it('still retries a plain per-minute rate limit', async () => {
      noBackoff();
      invoke
        .mockRejectedValueOnce(
          Object.assign(new Error('429 Too Many Requests'), { status: 429 }),
        )
        .mockResolvedValue(new AIMessage('recovered'));

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).resolves.toBe('recovered');
      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('retries a transient failure with backoff', async () => {
      noBackoff();
      invoke
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue(new AIMessage('ok'));

      await expect(
        service.callLLM([{ role: 'user', content: 'hi' }]),
      ).resolves.toBe('ok');
      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('never leaks the API key into a thrown message', async () => {
      invoke.mockRejectedValue(
        Object.assign(
          new Error('prepayment credits are depleted (key=AIzaSECRETVALUE123)'),
          { status: 429 },
        ),
      );

      const error: Error = await service
        .callLLM([{ role: 'user', content: 'hi' }])
        .then(() => new Error('expected a rejection'))
        .catch((e: Error) => e);

      expect(error.message).toMatch(/REDACTED/);
      expect(error.message).not.toContain('AIzaSECRETVALUE123');
    });
  });

  describe('settings hot-reload', () => {
    it('swaps the model without a restart', async () => {
      service.handleSettingsChanged({ key: 'gemini_model', value: 'gemini-3-pro' });

      await service.callLLM([{ role: 'user', content: 'hi' }]);

      expect(constructorCalls.at(-1).model).toBe('gemini-3-pro');
    });

    it('swaps the API key without a restart', async () => {
      service.handleSettingsChanged({ key: 'gemini_api_key', value: '  AIzaNEW  ' });

      await service.callLLM([{ role: 'user', content: 'hi' }]);

      expect(constructorCalls.at(-1).apiKey).toBe('AIzaNEW');
    });

    it('ignores unrelated settings', async () => {
      service.handleSettingsChanged({ key: 'approval_channel', value: 'x' });

      await service.callLLM([{ role: 'user', content: 'hi' }]);

      expect(constructorCalls.at(-1).model).toBe('gemini-2.5-flash-lite');
    });
  });
});

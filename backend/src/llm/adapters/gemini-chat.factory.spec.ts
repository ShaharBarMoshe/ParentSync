import { Test, TestingModule } from '@nestjs/testing';
import { GeminiChatFactory, DEFAULT_MODEL } from './gemini-chat.factory';
import { SettingsService } from '../../settings/settings.service';

describe('GeminiChatFactory', () => {
  let factory: GeminiChatFactory;
  let settings: {
    findByKey: jest.Mock;
    findByKeyDecrypted: jest.Mock;
  };

  beforeEach(async () => {
    settings = {
      findByKeyDecrypted: jest.fn().mockResolvedValue({ value: ' KEY-1 ' }),
      findByKey: jest.fn().mockResolvedValue({ value: 'gemini-2.5-flash' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeminiChatFactory,
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();

    factory = module.get(GeminiChatFactory);
    await factory.onModuleInit();
  });

  it('loads the key and model from settings, trimming the key', () => {
    expect(factory.configured).toBe(true);
    expect(factory.defaultModel).toBe('gemini-2.5-flash');
    expect(factory.create().apiKey).toBe('KEY-1');
  });

  it('falls back to the shipped default model when the setting is missing', async () => {
    settings.findByKey.mockRejectedValue(new Error('not found'));
    await factory.onModuleInit();
    expect(factory.defaultModel).toBe(DEFAULT_MODEL);
  });

  it('reports unconfigured and refuses to build when there is no key', async () => {
    settings.findByKeyDecrypted.mockRejectedValue(new Error('not found'));
    const module = await Test.createTestingModule({
      providers: [
        GeminiChatFactory,
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();
    const bare = module.get(GeminiChatFactory);
    await bare.onModuleInit();

    expect(bare.configured).toBe(false);
    expect(() => bare.create()).toThrow(/not configured/i);
  });

  /**
   * The single most expensive thing to get wrong here. LangChain's own retry
   * defaults to 6 attempts; leaving it on would stack with `LlmRetryPolicy`
   * (6 × 3) and would burn six retries on a quota-exhausted account before our
   * fast-fail could ever see the error.
   */
  it('disables the provider-side retry so only our ladder retries', () => {
    expect((factory.create() as any).caller.maxRetries).toBe(0);
  });

  it('applies per-call model, temperature and token budget', () => {
    const chat = factory.create({
      model: 'gemini-1.5-pro',
      temperature: 0.9,
      maxTokens: 4096,
    });
    expect(chat.model).toBe('gemini-1.5-pro');
    expect(chat.temperature).toBe(0.9);
    expect(chat.maxOutputTokens).toBe(4096);
  });

  it('uses the settings model when a call does not name one', () => {
    expect(factory.create().model).toBe('gemini-2.5-flash');
  });

  describe('settings hot-reload', () => {
    it('swaps the API key without a restart', () => {
      factory.handleSettingsChanged({
        key: 'gemini_api_key',
        value: ' KEY-2 ',
      });
      expect(factory.create().apiKey).toBe('KEY-2');
    });

    it('swaps the model without a restart', () => {
      factory.handleSettingsChanged({
        key: 'gemini_model',
        value: 'gemini-3-pro',
      });
      expect(factory.defaultModel).toBe('gemini-3-pro');
    });

    it('ignores unrelated settings', () => {
      factory.handleSettingsChanged({ key: 'timezone', value: 'UTC' });
      expect(factory.defaultModel).toBe('gemini-2.5-flash');
      expect(factory.create().apiKey).toBe('KEY-1');
    });
  });
});

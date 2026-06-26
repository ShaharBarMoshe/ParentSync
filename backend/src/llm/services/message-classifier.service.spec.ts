import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { MessageClassifierService } from './message-classifier.service';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';
import { SettingsService } from '../../settings/settings.service';

describe('MessageClassifierService', () => {
  let service: MessageClassifierService;
  let mockLlmService: { callLLM: jest.Mock };
  let mockCache: { get: jest.Mock; set: jest.Mock };
  let mockSettings: { findByKey: jest.Mock; create: jest.Mock };

  const settingsResolver = (overrides: Record<string, string> = {}) => (key: string) => {
    const defaults: Record<string, string> = {
      classifier_enabled: 'true',
    };
    const v = overrides[key] ?? defaults[key];
    if (v === undefined) return Promise.reject(new Error(`Setting not found: ${key}`));
    return Promise.resolve({ value: v });
  };

  beforeEach(async () => {
    mockLlmService = { callLLM: jest.fn() };
    mockCache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    mockSettings = {
      findByKey: jest.fn().mockImplementation(settingsResolver()),
      create: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageClassifierService,
        { provide: LLM_SERVICE, useValue: mockLlmService },
        { provide: CACHE_MANAGER, useValue: mockCache },
        { provide: SettingsService, useValue: mockSettings },
      ],
    }).compile();

    service = module.get(MessageClassifierService);
  });

  describe('classify — happy path', () => {
    it('returns isEvent=true for a YES verdict', async () => {
      mockLlmService.callLLM.mockResolvedValue('YES — explicit date and activity');

      const v = await service.classify('טיול שנתי ביום שלישי');

      expect(v.isEvent).toBe(true);
      expect(v.reason).toBe('explicit date and activity');
      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(1);
    });

    it('returns isEvent=false for a NO verdict', async () => {
      mockLlmService.callLLM.mockResolvedValue('NO — absence notice');

      const v = await service.classify('לא נגיע היום, יש בית חם');

      expect(v.isEvent).toBe(false);
      expect(v.reason).toBe('absence notice');
    });

    it('accepts en-dash, em-dash, hyphen, or colon as the separator', async () => {
      for (const sep of ['—', '–', '-', ':']) {
        mockLlmService.callLLM.mockResolvedValueOnce(`YES ${sep} valid event`);
        const v = await service.classify(`probe-${sep}`);
        expect(v.isEvent).toBe(true);
      }
    });

    it('takes only the first line, ignoring trailing commentary', async () => {
      mockLlmService.callLLM.mockResolvedValue('NO — chit chat\nFollow-up: this is unsolicited extra text');

      const v = await service.classify('שלום!');

      expect(v.isEvent).toBe(false);
      expect(v.reason).toBe('chit chat');
    });

    it('truncates an overlong reason to 80 chars', async () => {
      const longReason = 'a'.repeat(200);
      mockLlmService.callLLM.mockResolvedValue(`NO — ${longReason}`);

      const v = await service.classify('probe');

      expect(v.reason.length).toBeLessThanOrEqual(80);
    });

    it('uses "(no reason)" placeholder when the model returns just YES/NO', async () => {
      mockLlmService.callLLM.mockResolvedValue('NO');

      const v = await service.classify('probe');

      expect(v.isEvent).toBe(false);
      expect(v.reason).toBe('(no reason)');
    });
  });

  describe('short-circuits', () => {
    it('returns isEvent=false (without calling LLM) for an empty message', async () => {
      const v = await service.classify('   ');

      expect(v.isEvent).toBe(false);
      expect(v.reason).toBe('empty-message');
      expect(mockLlmService.callLLM).not.toHaveBeenCalled();
    });

    it('returns isEvent=true (without calling LLM) when classifier_enabled = false', async () => {
      mockSettings.findByKey.mockImplementation(settingsResolver({ classifier_enabled: 'false' }));

      const v = await service.classify('any message');

      expect(v.isEvent).toBe(true);
      expect(v.reason).toBe('classifier-disabled');
      expect(mockLlmService.callLLM).not.toHaveBeenCalled();
    });

    it('defaults to enabled when classifier_enabled setting is missing', async () => {
      // No classifier_enabled in resolver defaults override → falls through to true.
      mockLlmService.callLLM.mockResolvedValue('YES — sample');
      mockSettings.findByKey.mockImplementation((key: string) => {
        if (key === 'classifier_enabled') return Promise.reject(new Error('Not found'));
        return Promise.reject(new Error('Not found'));
      });

      const v = await service.classify('probe');

      expect(v.isEvent).toBe(true);
      expect(mockLlmService.callLLM).toHaveBeenCalled();
    });
  });

  describe('fail-open contract', () => {
    it('returns isEvent=true with reason=classifier-fail-open when LLM throws', async () => {
      mockLlmService.callLLM.mockRejectedValue(new Error('429 quota exceeded'));

      const v = await service.classify('probe');

      expect(v.isEvent).toBe(true);
      expect(v.reason).toBe('classifier-fail-open');
    });

    it('returns isEvent=true when the response is empty', async () => {
      mockLlmService.callLLM.mockResolvedValue('');

      const v = await service.classify('probe');

      expect(v.isEvent).toBe(true);
      expect(v.reason).toBe('classifier-empty-response');
    });

    it('returns isEvent=true when the response is unparseable', async () => {
      mockLlmService.callLLM.mockResolvedValue('I think this is probably an event, here is why...');

      const v = await service.classify('probe');

      expect(v.isEvent).toBe(true);
      expect(v.reason).toBe('classifier-unparseable');
    });
  });

  describe('caching', () => {
    it('caches the verdict keyed on prompt-version + content hash', async () => {
      mockLlmService.callLLM.mockResolvedValue('YES — match');

      await service.classify('same content');
      expect(mockCache.set).toHaveBeenCalledTimes(1);
      const [cacheKey] = mockCache.set.mock.calls[0];
      expect(cacheKey).toMatch(/^classify:[0-9a-f]{16}:[0-9a-f]{64}$/);
    });

    it('serves the cached verdict on second call (no LLM)', async () => {
      mockCache.get.mockResolvedValueOnce({ isEvent: false, reason: 'cached' });

      const v = await service.classify('same content');

      expect(v.isEvent).toBe(false);
      expect(v.reason).toBe('cached');
      expect(mockLlmService.callLLM).not.toHaveBeenCalled();
    });
  });

  describe('date context', () => {
    it('prepends the messageDate to the user prompt when supplied', async () => {
      mockLlmService.callLLM.mockResolvedValue('YES — date present');

      await service.classify('content', '2026-06-20');

      const messages = mockLlmService.callLLM.mock.calls[0][0];
      const userMsg = messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg.content).toContain('Current date: 2026-06-20');
    });

    it('omits the date prefix when messageDate is not supplied', async () => {
      mockLlmService.callLLM.mockResolvedValue('YES — no date');

      await service.classify('content');

      const messages = mockLlmService.callLLM.mock.calls[0][0];
      const userMsg = messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg.content).not.toContain('Current date:');
    });
  });

  describe('onModuleInit', () => {
    it('seeds the default classifier prompt when not customized', async () => {
      mockSettings.findByKey.mockRejectedValue(new Error('Not found'));

      await service.onModuleInit();

      expect(mockSettings.create).toHaveBeenCalledWith({
        key: 'llm_classifier_prompt',
        value: expect.stringContaining('binary classifier'),
      });
    });

    it('leaves the prompt alone when the user has marked it custom', async () => {
      mockSettings.findByKey.mockResolvedValue({ value: 'true' });

      await service.onModuleInit();

      expect(mockSettings.create).not.toHaveBeenCalled();
    });
  });
});

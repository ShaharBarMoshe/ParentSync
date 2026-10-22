import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { MessageClassifierService } from './message-classifier.service';
import { RELEVANCE_CLASSIFIER } from '../ports/ai-ports';
import { SettingsService } from '../../settings/settings.service';
import { PromptRegistry } from '../prompts/prompt-registry.service';

describe('MessageClassifierService', () => {
  let service: MessageClassifierService;
  let mockClassifier: { classify: jest.Mock };
  let mockCache: { get: jest.Mock; set: jest.Mock };
  let mockSettings: { findByKey: jest.Mock; create: jest.Mock };
  let mockPrompts: { classifierPrompt: jest.Mock };

  const settingsResolver =
    (overrides: Record<string, string> = {}) =>
    (key: string) => {
      const defaults: Record<string, string> = { classifier_enabled: 'true' };
      const v = overrides[key] ?? defaults[key];
      if (v === undefined)
        return Promise.reject(new Error(`Setting not found: ${key}`));
      return Promise.resolve({ value: v });
    };

  beforeEach(async () => {
    mockClassifier = {
      classify: jest.fn().mockResolvedValue({ isEvent: true, reason: 'ok' }),
    };
    mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    mockSettings = {
      findByKey: jest.fn().mockImplementation(settingsResolver()),
      create: jest.fn().mockResolvedValue(undefined),
    };
    mockPrompts = {
      classifierPrompt: jest
        .fn()
        .mockResolvedValue({ prompt: 'CLASSIFY', version: 'v1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageClassifierService,
        { provide: RELEVANCE_CLASSIFIER, useValue: mockClassifier },
        { provide: CACHE_MANAGER, useValue: mockCache },
        { provide: SettingsService, useValue: mockSettings },
        { provide: PromptRegistry, useValue: mockPrompts },
      ],
    }).compile();

    service = module.get(MessageClassifierService);
  });

  describe('verdict pass-through', () => {
    it('returns the port verdict unchanged for a positive answer', async () => {
      mockClassifier.classify.mockResolvedValue({
        isEvent: true,
        reason: 'explicit date and activity',
      });
      await expect(service.classify('Trip on Monday')).resolves.toEqual({
        isEvent: true,
        reason: 'explicit date and activity',
      });
    });

    it('returns the port verdict unchanged for a negative answer', async () => {
      mockClassifier.classify.mockResolvedValue({
        isEvent: false,
        reason: 'chit-chat',
      });
      const verdict = await service.classify('thanks!');
      expect(verdict.isEvent).toBe(false);
    });
  });

  describe('short-circuits', () => {
    it('rejects an empty message without reaching the port', async () => {
      const verdict = await service.classify('   ');
      expect(verdict).toEqual({ isEvent: false, reason: 'empty-message' });
      expect(mockClassifier.classify).not.toHaveBeenCalled();
    });

    it('passes everything through when the classifier is switched off', async () => {
      mockSettings.findByKey.mockImplementation(
        settingsResolver({ classifier_enabled: 'false' }),
      );
      const verdict = await service.classify('anything');
      expect(verdict).toEqual({
        isEvent: true,
        reason: 'classifier-disabled',
      });
      expect(mockClassifier.classify).not.toHaveBeenCalled();
    });

    it('defaults to enabled when the setting is missing', async () => {
      mockSettings.findByKey.mockRejectedValue(new Error('not found'));
      await service.classify('Trip on Monday');
      expect(mockClassifier.classify).toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('caches a real verdict keyed on prompt version and content', async () => {
      mockClassifier.classify.mockResolvedValue({
        isEvent: false,
        reason: 'chit-chat',
      });
      await service.classify('thanks!');
      expect(mockCache.set).toHaveBeenCalledWith(
        expect.stringContaining('classify:v1:'),
        { isEvent: false, reason: 'chit-chat' },
        expect.any(Number),
      );
    });

    it('serves a cached verdict without reaching the port', async () => {
      mockCache.get.mockResolvedValue({ isEvent: false, reason: 'cached' });
      const verdict = await service.classify('thanks!');
      expect(verdict.reason).toBe('cached');
      expect(mockClassifier.classify).not.toHaveBeenCalled();
    });

    it('never caches a fail-open verdict, so an outage lasts one call', async () => {
      mockClassifier.classify.mockResolvedValue({
        isEvent: true,
        reason: 'classifier-fail-open',
      });
      const verdict = await service.classify('Trip on Monday');
      expect(verdict.isEvent).toBe(true);
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('busts the cache when the prompt version changes', async () => {
      await service.classify('same text');
      const firstKey = mockCache.get.mock.calls[0][0];
      mockPrompts.classifierPrompt.mockResolvedValue({
        prompt: 'EDITED',
        version: 'v2',
      });
      await service.classify('same text');
      expect(mockCache.get.mock.calls[1][0]).not.toBe(firstKey);
    });
  });

  describe('date context', () => {
    it('forwards the message date so relative dates resolve correctly', async () => {
      await service.classify('trip tomorrow', '2026-03-01');
      expect(mockClassifier.classify).toHaveBeenCalledWith(
        'trip tomorrow',
        '2026-03-01',
      );
    });

    it('forwards undefined when no date is supplied', async () => {
      await service.classify('trip tomorrow');
      expect(mockClassifier.classify).toHaveBeenCalledWith(
        'trip tomorrow',
        undefined,
      );
    });

    it('trims the content before handing it to the port', async () => {
      await service.classify('  padded  ');
      expect(mockClassifier.classify).toHaveBeenCalledWith(
        'padded',
        undefined,
      );
    });
  });
});

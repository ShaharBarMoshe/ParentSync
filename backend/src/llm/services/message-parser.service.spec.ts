import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { MessageParserService } from './message-parser.service';
import { MessageClassifierService } from './message-classifier.service';
import { PromptRegistry } from '../prompts/prompt-registry.service';
import { EVENT_EXTRACTOR, DUPLICATE_JUDGE } from '../ports/ai-ports';
import type { ExtractionRequest } from '../ports/ai-ports';
import { SettingsService } from '../../settings/settings.service';
import { LlmQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';
import { daysFromNow } from '../../../test/helpers/relative-dates';

describe('MessageParserService', () => {
  let service: MessageParserService;
  let mockExtractor: { extract: jest.Mock };
  let mockJudge: { areIdentical: jest.Mock };
  let mockCacheManager: { get: jest.Mock; set: jest.Mock };
  let mockSettingsService: any;
  let mockClassifierService: { classify: jest.Mock };
  let mockPrompts: { systemPrompt: jest.Mock };

  const date = daysFromNow(14);

  /** Default extractor: every requested group comes back with no events. */
  const emptyFor = (requests: ExtractionRequest[]) =>
    requests.map((r) => ({ id: r.id, events: [] }));

  beforeEach(async () => {
    mockExtractor = { extract: jest.fn().mockImplementation(emptyFor) };
    mockJudge = { areIdentical: jest.fn().mockResolvedValue(false) };
    mockCacheManager = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    mockSettingsService = {
      findByKey: jest.fn().mockRejectedValue(new Error('Not found')),
      create: jest.fn().mockResolvedValue(undefined),
    };
    // Default: the gate says yes, so it never masks an extraction assertion.
    mockClassifierService = {
      classify: jest.fn().mockResolvedValue({ isEvent: true, reason: 'test' }),
    };
    mockPrompts = {
      systemPrompt: jest
        .fn()
        .mockResolvedValue({ prompt: 'EXTRACT', version: 'v1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageParserService,
        { provide: EVENT_EXTRACTOR, useValue: mockExtractor },
        { provide: DUPLICATE_JUDGE, useValue: mockJudge },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: MessageClassifierService, useValue: mockClassifierService },
        { provide: PromptRegistry, useValue: mockPrompts },
      ],
    }).compile();

    service = module.get(MessageParserService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  describe('parseMessage', () => {
    it('returns the events the extractor found', async () => {
      mockExtractor.extract.mockResolvedValue([
        { id: 'single', events: [{ title: 'Birthday', date }] },
      ]);
      const events = await service.parseMessage('birthday party', date);
      expect(events).toHaveLength(1);
      expect(events[0].title).toBe('Birthday');
    });

    it('returns [] when the extractor found nothing', async () => {
      await expect(service.parseMessage('hello there', date)).resolves.toEqual(
        [],
      );
    });

    it('forwards the date context so relative dates resolve correctly', async () => {
      await service.parseMessage('trip tomorrow', '2026-03-01');
      expect(mockExtractor.extract).toHaveBeenCalledWith([
        expect.objectContaining({ dateContext: '2026-03-01' }),
      ]);
    });

    it('defaults the date context to today when none is given', async () => {
      const today = new Date().toISOString().split('T')[0];
      await service.parseMessage('trip tomorrow');
      expect(mockExtractor.extract).toHaveBeenCalledWith([
        expect.objectContaining({ dateContext: today }),
      ]);
    });

    it('forwards images to the extractor', async () => {
      const images = [{ mimeType: 'image/jpeg', data: 'BASE64' }];
      await service.parseMessage('see flyer', date, images);
      expect(mockExtractor.extract).toHaveBeenCalledWith([
        expect.objectContaining({ images }),
      ]);
    });
  });

  describe('caching', () => {
    it('serves a cached parse without calling the extractor', async () => {
      const cached = [{ title: 'Cached', date }];
      mockCacheManager.get.mockResolvedValue(cached);
      await expect(service.parseMessage('anything', date)).resolves.toEqual(
        cached,
      );
      expect(mockExtractor.extract).not.toHaveBeenCalled();
    });

    it('stores the result under a key carrying the prompt version', async () => {
      mockExtractor.extract.mockResolvedValue([
        { id: 'single', events: [{ title: 'A', date }] },
      ]);
      await service.parseMessage('content', date);
      expect(mockCacheManager.set).toHaveBeenCalledWith(
        expect.stringContaining('msg-parse:v1:'),
        [{ title: 'A', date }],
        expect.any(Number),
      );
    });

    it('uses one stable key for identical content', async () => {
      await service.parseMessage('same text', date);
      await service.parseMessage('same text', date);
      const [first, second] = mockCacheManager.get.mock.calls;
      expect(first[0]).toBe(second[0]);
    });

    it('keys the same text differently with and without images', async () => {
      await service.parseMessage('same text', date);
      await service.parseMessage('same text', date, [
        { mimeType: 'image/png', data: 'AAA' },
      ]);
      const [first, second] = mockCacheManager.get.mock.calls;
      expect(first[0]).not.toBe(second[0]);
    });

    it('busts the cache when the prompt changes, so a prompt fix takes effect', async () => {
      await service.parseMessage('same text', date);
      mockPrompts.systemPrompt.mockResolvedValue({
        prompt: 'EDITED',
        version: 'v2',
      });
      await service.parseMessage('same text', date);
      const [first, second] = mockCacheManager.get.mock.calls;
      expect(first[0]).not.toBe(second[0]);
    });

    it('caches a classifier rejection so the next sync skips the gate too', async () => {
      mockClassifierService.classify.mockResolvedValue({
        isEvent: false,
        reason: 'chit-chat',
      });
      await service.parseMessage('thanks!', date);
      expect(mockCacheManager.set).toHaveBeenCalledWith(
        expect.stringContaining('msg-parse:v1:'),
        [],
        expect.any(Number),
      );
    });
  });

  describe('classifier gate', () => {
    it('short-circuits to [] without calling the extractor on a NO', async () => {
      mockClassifierService.classify.mockResolvedValue({
        isEvent: false,
        reason: 'chit-chat',
      });
      await expect(service.parseMessage('thanks!', date)).resolves.toEqual([]);
      expect(mockExtractor.extract).not.toHaveBeenCalled();
    });

    it('runs the extractor on a YES', async () => {
      await service.parseMessage('trip on Monday', date);
      expect(mockExtractor.extract).toHaveBeenCalled();
    });

    it('runs the extractor when the gate fails open', async () => {
      mockClassifierService.classify.mockResolvedValue({
        isEvent: true,
        reason: 'classifier-fail-open',
      });
      await service.parseMessage('trip on Monday', date);
      expect(mockExtractor.extract).toHaveBeenCalled();
    });

    it('bypasses the gate for an image-bearing message', async () => {
      await service.parseMessage('', date, [
        { mimeType: 'image/jpeg', data: 'BASE64' },
      ]);
      expect(mockClassifierService.classify).not.toHaveBeenCalled();
      expect(mockExtractor.extract).toHaveBeenCalled();
    });

    it('bypasses the gate for an empty text message', async () => {
      await service.parseMessage('   ', date);
      expect(mockClassifierService.classify).not.toHaveBeenCalled();
    });

    it('passes the group date to the gate, not the batch default', async () => {
      await service.parseMessageBatch(
        [{ id: 'a', content: 'trip tomorrow' }],
        '2026-04-01',
        ['2026-04-09'],
      );
      expect(mockClassifierService.classify).toHaveBeenCalledWith(
        'trip tomorrow',
        '2026-04-09',
      );
    });

    it('counts each rejection in the metric', async () => {
      mockClassifierService.classify.mockResolvedValue({
        isEvent: false,
        reason: 'chit-chat',
      });
      await service.parseMessageBatch([
        { id: 'a', content: 'thanks' },
        { id: 'b', content: 'ok' },
      ]);
      const increments = mockSettingsService.create.mock.calls.filter(
        (c: any[]) => c[0].key === 'metric.classifier_reject_total',
      );
      expect(increments).toHaveLength(2);
    });
  });

  describe('parseMessageBatch', () => {
    it('returns an empty map for no groups, without touching the extractor', async () => {
      const result = await service.parseMessageBatch([]);
      expect(result.size).toBe(0);
      expect(mockExtractor.extract).not.toHaveBeenCalled();
    });

    it('hands every uncached group to the extractor in one call', async () => {
      mockExtractor.extract.mockResolvedValue([
        { id: 'a', events: [{ title: 'Birthday', date }] },
        { id: 'b', events: [] },
        { id: 'c', events: [{ title: 'Meeting', date, time: '15:00' }] },
      ]);

      const result = await service.parseMessageBatch(
        [
          { id: 'a', content: 'birthday party' },
          { id: 'b', content: 'hello how are you' },
          { id: 'c', content: 'meeting at 3pm' },
        ],
        date,
      );

      expect(mockExtractor.extract).toHaveBeenCalledTimes(1);
      expect(result.size).toBe(3);
      expect(result.get('a')![0].title).toBe('Birthday');
      expect(result.get('b')).toHaveLength(0);
      expect(result.get('c')![0].time).toBe('15:00');
    });

    it('skips the extractor entirely when every group is cached', async () => {
      mockCacheManager.get.mockResolvedValue([{ title: 'Cached', date }]);
      const result = await service.parseMessageBatch([
        { id: 'a', content: 'one' },
        { id: 'b', content: 'two' },
      ]);
      expect(result.size).toBe(2);
      expect(mockExtractor.extract).not.toHaveBeenCalled();
    });

    it('mixes cached and uncached groups, sending only the uncached ones', async () => {
      const cached = [{ title: 'Cached Event', date }];
      mockCacheManager.get
        .mockResolvedValueOnce(cached)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockExtractor.extract.mockResolvedValue([
        { id: 'g2', events: [{ title: 'Event 2', date }] },
        { id: 'g3', events: [] },
      ]);

      const result = await service.parseMessageBatch([
        { id: 'g1', content: 'cached content' },
        { id: 'g2', content: 'new content 1' },
        { id: 'g3', content: 'new content 2' },
      ]);

      expect(result.get('g1')).toEqual(cached);
      expect(result.get('g2')).toHaveLength(1);
      expect(result.get('g3')).toHaveLength(0);
      expect(mockExtractor.extract).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'g2' }),
        expect.objectContaining({ id: 'g3' }),
      ]);
    });

    it('caches each group individually so a later single parse hits', async () => {
      mockExtractor.extract.mockResolvedValue([
        { id: 'a', events: [{ title: 'A', date }] },
        { id: 'b', events: [{ title: 'B', date }] },
      ]);
      await service.parseMessageBatch([
        { id: 'a', content: 'one' },
        { id: 'b', content: 'two' },
      ]);
      expect(mockCacheManager.set).toHaveBeenCalledWith(
        expect.any(String),
        [{ title: 'A', date }],
        expect.any(Number),
      );
      expect(mockCacheManager.set).toHaveBeenCalledWith(
        expect.any(String),
        [{ title: 'B', date }],
        expect.any(Number),
      );
    });

    it('gives each group its own date context', async () => {
      await service.parseMessageBatch(
        [
          { id: 'a', content: 'one' },
          { id: 'b', content: 'two' },
        ],
        '2026-04-01',
        ['2026-04-05', '2026-04-07'],
      );
      expect(mockExtractor.extract).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'a', dateContext: '2026-04-05' }),
        expect.objectContaining({ id: 'b', dateContext: '2026-04-07' }),
      ]);
    });

    it('falls back to the batch date when a group has none of its own', async () => {
      await service.parseMessageBatch(
        [
          { id: 'a', content: 'one' },
          { id: 'b', content: 'two' },
        ],
        '2026-04-01',
        ['2026-04-05'],
      );
      expect(mockExtractor.extract).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'a', dateContext: '2026-04-05' }),
        expect.objectContaining({ id: 'b', dateContext: '2026-04-01' }),
      ]);
    });
  });

  describe('extraction failure', () => {
    it('rethrows an exhausted quota rather than reporting "no events"', async () => {
      mockExtractor.extract.mockRejectedValue(
        new LlmQuotaExhaustedError('out of credit'),
      );
      await expect(service.parseMessage('content', date)).rejects.toThrow(
        LlmQuotaExhaustedError,
      );
    });

    it('rethrows an exhausted quota out of a batch too', async () => {
      mockExtractor.extract.mockRejectedValue(
        new LlmQuotaExhaustedError('out of credit'),
      );
      await expect(
        service.parseMessageBatch([
          { id: 'a', content: 'one' },
          { id: 'b', content: 'two' },
        ]),
      ).rejects.toThrow(LlmQuotaExhaustedError);
    });

    it('leaves a failed group absent rather than caching a false empty', async () => {
      mockExtractor.extract.mockRejectedValue(new Error('provider exploded'));
      const result = await service.parseMessageBatch([
        { id: 'a', content: 'one' },
      ]);
      expect(result.has('a')).toBe(false);
      expect(mockCacheManager.set).not.toHaveBeenCalled();
    });

    it('still resolves to [] from parseMessage on an ordinary failure', async () => {
      mockExtractor.extract.mockRejectedValue(new Error('provider exploded'));
      await expect(service.parseMessage('content', date)).resolves.toEqual([]);
    });
  });

  describe('eventsAreIdentical', () => {
    it('delegates to the duplicate judge', async () => {
      mockJudge.areIdentical.mockResolvedValue(true);
      const a = { title: 'Party', date };
      const b = { title: 'Gathering', date };
      await expect(service.eventsAreIdentical(a, b)).resolves.toBe(true);
      expect(mockJudge.areIdentical).toHaveBeenCalledWith(a, b);
    });
  });

  describe('buildSystemPrompt', () => {
    it('returns the active prompt and its version from the registry', async () => {
      await expect(service.buildSystemPrompt()).resolves.toEqual({
        prompt: 'EXTRACT',
        version: 'v1',
      });
    });
  });
});

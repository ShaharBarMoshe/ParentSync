import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { MessageParserService } from './message-parser.service';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';

describe('MessageParserService', () => {
  let service: MessageParserService;
  let mockLlmService: any;
  let mockCacheManager: any;

  beforeEach(async () => {
    mockLlmService = {
      callLLM: jest.fn(),
    };

    mockCacheManager = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageParserService,
        { provide: LLM_SERVICE, useValue: mockLlmService },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
      ],
    }).compile();

    service = module.get<MessageParserService>(MessageParserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should parse a birthday event', async () => {
    mockLlmService.callLLM.mockResolvedValue(
      JSON.stringify([
        {
          title: "Miki's Birthday",
          date: '2026-03-12',
          location: 'Jungle Park, Modiin',
        },
      ]),
    );

    const events = await service.parseMessage(
      'birthday for miki 12.3.26 in the jungle park Modiin',
      '2026-03-10',
    );

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Miki's Birthday");
    expect(events[0].date).toBe('2026-03-12');
    expect(events[0].location).toBe('Jungle Park, Modiin');
  });

  it('should return empty array for non-event messages', async () => {
    mockLlmService.callLLM.mockResolvedValue('[]');

    const events = await service.parseMessage('hello how are you?');
    expect(events).toHaveLength(0);
  });

  it('should parse a doctor appointment', async () => {
    mockLlmService.callLLM.mockResolvedValue(
      JSON.stringify([
        {
          title: 'Doctor Appointment',
          date: '2026-03-17',
          time: '15:00',
          description: 'Appointment with Dr. Smith',
        },
      ]),
    );

    const events = await service.parseMessage(
      'doctor appointment tuesday 3pm with dr. smith',
      '2026-03-15',
    );

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Doctor Appointment');
    expect(events[0].date).toBe('2026-03-17');
    expect(events[0].time).toBe('15:00');
  });

  it('should handle multiple events in a single message', async () => {
    mockLlmService.callLLM.mockResolvedValue(
      JSON.stringify([
        { title: 'Meeting', date: '2026-03-20', time: '09:00' },
        { title: 'Dinner', date: '2026-03-20', time: '19:00', location: 'Restaurant' },
      ]),
    );

    const events = await service.parseMessage(
      'Meeting at 9am and dinner at 7pm on March 20th',
    );
    expect(events).toHaveLength(2);
  });

  it('should extract JSON from markdown code blocks', async () => {
    mockLlmService.callLLM.mockResolvedValue(
      '```json\n[{"title":"Event","date":"2026-03-15"}]\n```',
    );

    const events = await service.parseMessage('event on march 15');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Event');
  });

  it('should return empty array on LLM error', async () => {
    mockLlmService.callLLM.mockRejectedValue(new Error('API down'));

    const events = await service.parseMessage('some message');
    expect(events).toHaveLength(0);
  });

  it('should return empty array for malformed JSON', async () => {
    mockLlmService.callLLM.mockResolvedValue('not json at all');

    const events = await service.parseMessage('some message');
    expect(events).toHaveLength(0);
  });

  it('should filter out invalid events (missing required fields)', async () => {
    mockLlmService.callLLM.mockResolvedValue(
      JSON.stringify([
        { title: 'Valid Event', date: '2026-03-15' },
        { title: '', date: '2026-03-15' }, // empty title
        { title: 'No Date' }, // missing date
        { title: 'Bad Date', date: 'not-a-date' }, // invalid date format
        { title: 'Bad Time', date: '2026-03-15', time: '3pm' }, // invalid time format
      ]),
    );

    const events = await service.parseMessage('some message');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Valid Event');
  });

  it('should use cache when available', async () => {
    const cachedEvents = [{ title: 'Cached', date: '2026-03-15' }];
    mockCacheManager.get.mockResolvedValue(cachedEvents);

    const events = await service.parseMessage('cached message');
    expect(events).toEqual(cachedEvents);
    expect(mockLlmService.callLLM).not.toHaveBeenCalled();
  });

  it('should store results in cache after parsing', async () => {
    mockLlmService.callLLM.mockResolvedValue(
      JSON.stringify([{ title: 'New Event', date: '2026-03-15' }]),
    );

    await service.parseMessage('new message');

    expect(mockCacheManager.set).toHaveBeenCalledWith(
      expect.stringContaining('msg-parse:'),
      expect.arrayContaining([
        expect.objectContaining({ title: 'New Event' }),
      ]),
      86400,
    );
  });

  it('should generate consistent cache keys for same content', async () => {
    mockLlmService.callLLM.mockResolvedValue('[]');

    await service.parseMessage('same message');
    await service.parseMessage('same message');

    const calls = mockCacheManager.get.mock.calls;
    expect(calls[0][0]).toBe(calls[1][0]);
  });

  describe('parseMessageBatch', () => {
    it('should return empty Map for empty input', async () => {
      const result = await service.parseMessageBatch([], '2026-04-13');
      expect(result.size).toBe(0);
      expect(mockLlmService.callLLM).not.toHaveBeenCalled();
    });

    it('should delegate to parseMessage for a single uncached group', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([{ title: 'Trip', date: '2026-04-20' }]),
      );

      const result = await service.parseMessageBatch(
        [{ id: 'g1', content: 'טיול שנתי ביום חמישי' }],
        '2026-04-13',
      );

      expect(result.size).toBe(1);
      expect(result.get('g1')).toHaveLength(1);
      expect(result.get('g1')![0].title).toBe('Trip');
      // Single group should call LLM once (via parseMessage, not batch format)
      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(1);
    });

    it('should return all groups from cache without LLM call', async () => {
      const cached1 = [{ title: 'Event 1', date: '2026-04-15' }];
      const cached2 = [{ title: 'Event 2', date: '2026-04-16' }];
      mockCacheManager.get
        .mockResolvedValueOnce(cached1)
        .mockResolvedValueOnce(cached2);

      const result = await service.parseMessageBatch(
        [
          { id: 'g1', content: 'message 1' },
          { id: 'g2', content: 'message 2' },
        ],
        '2026-04-13',
      );

      expect(result.size).toBe(2);
      expect(result.get('g1')).toEqual(cached1);
      expect(result.get('g2')).toEqual(cached2);
      expect(mockLlmService.callLLM).not.toHaveBeenCalled();
    });

    it('should batch uncached groups in a single LLM call', async () => {
      mockCacheManager.get.mockResolvedValue(null); // nothing cached

      const batchResponse = JSON.stringify({
        '1': [{ title: 'Birthday', date: '2026-04-20' }],
        '2': [],
        '3': [{ title: 'Meeting', date: '2026-04-21', time: '15:00' }],
      });
      mockLlmService.callLLM.mockResolvedValue(batchResponse);

      const result = await service.parseMessageBatch(
        [
          { id: 'a', content: 'birthday party' },
          { id: 'b', content: 'hello how are you' },
          { id: 'c', content: 'meeting at 3pm' },
        ],
        '2026-04-13',
      );

      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(1);
      expect(result.size).toBe(3);
      expect(result.get('a')).toHaveLength(1);
      expect(result.get('a')![0].title).toBe('Birthday');
      expect(result.get('b')).toHaveLength(0);
      expect(result.get('c')).toHaveLength(1);
      expect(result.get('c')![0].time).toBe('15:00');
    });

    it('should mix cached and uncached groups', async () => {
      const cached = [{ title: 'Cached Event', date: '2026-04-15' }];
      mockCacheManager.get
        .mockResolvedValueOnce(cached)   // g1 cached
        .mockResolvedValueOnce(null)     // g2 not cached
        .mockResolvedValueOnce(null);    // g3 not cached

      // Batch call for 2 uncached groups
      const batchResponse = JSON.stringify({
        '1': [{ title: 'Event 2', date: '2026-04-16' }],
        '2': [],
      });
      mockLlmService.callLLM.mockResolvedValue(batchResponse);

      const result = await service.parseMessageBatch(
        [
          { id: 'g1', content: 'cached content' },
          { id: 'g2', content: 'new content 1' },
          { id: 'g3', content: 'new content 2' },
        ],
        '2026-04-13',
      );

      expect(result.size).toBe(3);
      expect(result.get('g1')).toEqual(cached);
      expect(result.get('g2')).toHaveLength(1);
      expect(result.get('g3')).toHaveLength(0);
      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(1);
    });

    it('should cache each group individually after batch parse', async () => {
      mockCacheManager.get.mockResolvedValue(null);

      const batchResponse = JSON.stringify({
        '1': [{ title: 'A', date: '2026-04-20' }],
        '2': [{ title: 'B', date: '2026-04-21' }],
      });
      mockLlmService.callLLM.mockResolvedValue(batchResponse);

      await service.parseMessageBatch(
        [
          { id: 'x', content: 'msg one' },
          { id: 'y', content: 'msg two' },
        ],
        '2026-04-13',
      );

      // Should cache each group separately
      expect(mockCacheManager.set).toHaveBeenCalledTimes(2);
    });

    it('should handle missing keys in batch response with empty arrays', async () => {
      mockCacheManager.get.mockResolvedValue(null);

      // Response only has key "1", missing "2"
      const batchResponse = JSON.stringify({
        '1': [{ title: 'Only Event', date: '2026-04-20' }],
      });
      mockLlmService.callLLM.mockResolvedValue(batchResponse);

      const result = await service.parseMessageBatch(
        [
          { id: 'a', content: 'has events' },
          { id: 'b', content: 'missing in response' },
        ],
        '2026-04-13',
      );

      expect(result.get('a')).toHaveLength(1);
      expect(result.get('b')).toHaveLength(0);
    });

    it('should fall back to individual parsing when batch response is an array', async () => {
      mockCacheManager.get.mockResolvedValue(null);

      // LLM returns array instead of object (wrong format for batch)
      mockLlmService.callLLM
        .mockResolvedValueOnce('[{"title":"X","date":"2026-04-20"}]')  // batch attempt
        .mockResolvedValueOnce('[{"title":"A","date":"2026-04-20"}]')  // fallback group 1
        .mockResolvedValueOnce('[]');                                   // fallback group 2

      const result = await service.parseMessageBatch(
        [
          { id: 'a', content: 'msg 1' },
          { id: 'b', content: 'msg 2' },
        ],
        '2026-04-13',
      );

      // Should have made 3 LLM calls: 1 batch (failed) + 2 individual fallbacks
      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(3);
      expect(result.get('a')).toHaveLength(1);
      expect(result.get('b')).toHaveLength(0);
    });

    it('should fall back to individual parsing when LLM throws error', async () => {
      mockCacheManager.get.mockResolvedValue(null);

      mockLlmService.callLLM
        .mockRejectedValueOnce(new Error('LLM error'))    // batch fails
        .mockResolvedValueOnce('[]')                       // fallback group 1
        .mockResolvedValueOnce('[]');                       // fallback group 2

      const result = await service.parseMessageBatch(
        [
          { id: 'a', content: 'msg 1' },
          { id: 'b', content: 'msg 2' },
        ],
        '2026-04-13',
      );

      expect(result.size).toBe(2);
      expect(result.get('a')).toHaveLength(0);
      expect(result.get('b')).toHaveLength(0);
    });

    it('should validate events in batch response', async () => {
      mockCacheManager.get.mockResolvedValue(null);

      const batchResponse = JSON.stringify({
        '1': [
          { title: 'Valid', date: '2026-04-20' },
          { title: '', date: '2026-04-20' },      // empty title — filtered
          { title: 'No Date' },                     // missing date — filtered
        ],
        '2': [
          { title: 'Bad Time', date: '2026-04-21', time: 'noon' }, // invalid time — filtered
        ],
      });
      mockLlmService.callLLM.mockResolvedValue(batchResponse);

      const result = await service.parseMessageBatch(
        [
          { id: 'a', content: 'msg 1' },
          { id: 'b', content: 'msg 2' },
        ],
        '2026-04-13',
      );

      expect(result.get('a')).toHaveLength(1);
      expect(result.get('a')![0].title).toBe('Valid');
      expect(result.get('b')).toHaveLength(0);
    });

    it('should include ===MESSAGE_N=== delimiters in batch LLM call', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockLlmService.callLLM.mockResolvedValue('{"1":[],"2":[]}');

      await service.parseMessageBatch(
        [
          { id: 'a', content: 'first message' },
          { id: 'b', content: 'second message' },
        ],
        '2026-04-13',
      );

      const userMessage = mockLlmService.callLLM.mock.calls[0][0][1].content;
      expect(userMessage).toContain('===MESSAGE_1===');
      expect(userMessage).toContain('===MESSAGE_2===');
      expect(userMessage).toContain('first message');
      expect(userMessage).toContain('second message');
      expect(userMessage).toContain('Default current date: 2026-04-13');
      // Each message has its own date context
      expect(userMessage).toContain('Current date for this message:');
    });

    it('should extract batch JSON from markdown code blocks', async () => {
      mockCacheManager.get.mockResolvedValue(null);

      mockLlmService.callLLM.mockResolvedValue(
        '```json\n{"1": [{"title":"Event","date":"2026-04-20"}], "2": []}\n```',
      );

      const result = await service.parseMessageBatch(
        [
          { id: 'a', content: 'msg 1' },
          { id: 'b', content: 'msg 2' },
        ],
        '2026-04-13',
      );

      expect(result.get('a')).toHaveLength(1);
      expect(result.get('b')).toHaveLength(0);
    });
  });

  describe('dismissal event validation', () => {
    it('should accept cancel events with empty date', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          {
            title: 'טיול שנתי',
            action: 'cancel',
            date: '',
            originalTitle: 'טיול שנתי',
          },
        ]),
      );

      const events = await service.parseMessage('הטיול השנתי בוטל');
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('cancel');
      expect(events[0].date).toBe('');
      expect(events[0].originalTitle).toBe('טיול שנתי');
    });

    it('should accept cancel events with a date', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          {
            title: 'טיול שנתי',
            action: 'cancel',
            date: '2026-04-20',
            originalTitle: 'טיול שנתי',
          },
        ]),
      );

      const events = await service.parseMessage('הטיול השנתי ליום חמישי בוטל');
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('cancel');
      expect(events[0].date).toBe('2026-04-20');
    });

    it('should accept delay events with newDate and newTime', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          {
            title: 'אסיפה',
            action: 'delay',
            date: '',
            originalTitle: 'אסיפה',
            newDate: '2026-04-25',
            newTime: '18:00',
          },
        ]),
      );

      const events = await service.parseMessage('האסיפה נדחתה ליום ראשון ב-18:00');
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('delay');
      expect(events[0].newDate).toBe('2026-04-25');
      expect(events[0].newTime).toBe('18:00');
    });

    it('should reject dismissal events with invalid newDate format', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          {
            title: 'אסיפה',
            action: 'delay',
            date: '',
            newDate: 'next-week',
          },
        ]),
      );

      const events = await service.parseMessage('האסיפה נדחתה');
      expect(events).toHaveLength(0);
    });

    it('should reject dismissal events with invalid newTime format', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          {
            title: 'אסיפה',
            action: 'delay',
            date: '',
            newDate: '2026-04-25',
            newTime: '6pm',
          },
        ]),
      );

      const events = await service.parseMessage('האסיפה נדחתה');
      expect(events).toHaveLength(0);
    });

    it('should default to create when action is not set (backward compat)', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Regular Event', date: '2026-04-20' },
        ]),
      );

      const events = await service.parseMessage('event on april 20');
      expect(events).toHaveLength(1);
      expect(events[0].action).toBeUndefined();
    });

    it('should reject events with invalid action value', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Bad Action', date: '2026-04-20', action: 'delete' },
        ]),
      );

      const events = await service.parseMessage('some message');
      expect(events).toHaveLength(0);
    });

    it('should reject cancel event with invalid date format (non-empty, non-YYYY-MM-DD)', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Event', action: 'cancel', date: 'tomorrow' },
        ]),
      );

      const events = await service.parseMessage('some message');
      expect(events).toHaveLength(0);
    });
  });
});

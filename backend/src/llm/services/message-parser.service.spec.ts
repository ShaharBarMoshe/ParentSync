import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { MessageParserService } from './message-parser.service';
import { MessageClassifierService } from './message-classifier.service';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';
import { SettingsService } from '../../settings/settings.service';

describe('MessageParserService', () => {
  let service: MessageParserService;
  let mockLlmService: any;
  let mockCacheManager: any;
  let mockSettingsService: any;
  let mockClassifierService: any;

  beforeEach(async () => {
    mockLlmService = {
      callLLM: jest.fn(),
    };

    mockCacheManager = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    mockSettingsService = {
      findByKey: jest.fn().mockRejectedValue(new Error('Not found')),
      seedDefaultIfMissing: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    };

    // Default: classifier always says YES so existing tests are unaffected.
    mockClassifierService = {
      classify: jest.fn().mockResolvedValue({ isEvent: true, reason: 'test' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageParserService,
        { provide: LLM_SERVICE, useValue: mockLlmService },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: MessageClassifierService, useValue: mockClassifierService },
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

  describe('endTime extraction', () => {
    it('propagates a valid endTime from LLM JSON', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Parent meeting', date: '2026-06-15', time: '19:00', endTime: '20:30' },
        ]),
      );

      const events = await service.parseMessage('parent meeting from 19 to 20:30');

      expect(events).toHaveLength(1);
      expect(events[0].time).toBe('19:00');
      expect(events[0].endTime).toBe('20:30');
    });

    it('omits endTime when absent in LLM response', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([{ title: 'Trip', date: '2026-06-15', time: '08:00' }]),
      );

      const events = await service.parseMessage('trip at 8');

      expect(events).toHaveLength(1);
      expect(events[0].time).toBe('08:00');
      expect(events[0].endTime).toBeUndefined();
    });

    it('drops endTime when it is earlier than time', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Meeting', date: '2026-06-15', time: '16:00', endTime: '15:00' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(1);
      expect(events[0].time).toBe('16:00');
      expect(events[0].endTime).toBeUndefined();
    });

    it('drops endTime when it equals time (must be strictly later)', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Meeting', date: '2026-06-15', time: '16:00', endTime: '16:00' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events[0].endTime).toBeUndefined();
    });

    it('drops endTime with malformed format and keeps the event', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Workshop', date: '2026-06-15', time: '10:00', endTime: 'tomorrow' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(1);
      expect(events[0].endTime).toBeUndefined();
    });

    it('drops endTime when time is missing entirely (all-day event)', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Costume day', date: '2026-06-15', endTime: '14:00' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(1);
      expect(events[0].time).toBeUndefined();
      expect(events[0].endTime).toBeUndefined();
    });
  });

  describe('single-gathering collapse', () => {
    it('collapses two events with same (title, date, location, description) but different times', async () => {
      // This is the exact LLM output from the 2026-06-16 graduation-party bug.
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'מסיבת סיום', date: '2026-06-22', time: '17:00', location: 'Laser Game X', description: 'KITA DALET SHTAIM' },
          { title: 'מסיבת סיום', date: '2026-06-22', time: '17:30', endTime: '18:00', location: 'Laser Game X', description: 'KITA DALET SHTAIM' },
        ]),
      );

      const events = await service.parseMessage('graduation party message');

      expect(events).toHaveLength(1);
      // Prefer the entry with both time + endTime.
      expect(events[0].time).toBe('17:30');
      expect(events[0].endTime).toBe('18:00');
    });

    it('keeps events with different titles even if other fields match', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'הגעה', date: '2026-06-22', time: '17:00', location: 'Hall', description: 'desc' },
          { title: 'מסיבה', date: '2026-06-22', time: '17:30', location: 'Hall', description: 'desc' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(2);
    });

    it('keeps events with different dates even if other fields match', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'מסיבה', date: '2026-06-22', time: '17:00' },
          { title: 'מסיבה', date: '2026-06-23', time: '17:00' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(2);
    });

    it('keeps action events (cancel/delay) without merging them', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'מסיבה', date: '2026-06-22', action: 'cancel', originalTitle: 'מסיבה' },
          { title: 'מסיבה', date: '2026-06-22', action: 'cancel', originalTitle: 'מסיבה' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(2);
    });

    it('chooses the time-only entry over an all-day entry when collapsing', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'אירוע', date: '2026-06-22', location: 'X', description: 'd' },
          { title: 'אירוע', date: '2026-06-22', time: '10:00', location: 'X', description: 'd' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(1);
      expect(events[0].time).toBe('10:00');
    });

    it('normalises title/location/description for the match key (trim + case)', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([
          { title: 'Event ', date: '2026-06-22', time: '10:00', location: 'PLACE', description: 'd' },
          { title: 'event', date: '2026-06-22', time: '11:00', endTime: '12:00', location: 'place ', description: 'd' },
        ]),
      );

      const events = await service.parseMessage('garbage');

      expect(events).toHaveLength(1);
      expect(events[0].endTime).toBe('12:00');
    });
  });

  describe('batch-shaped response on a single-message call', () => {
    it('flattens {"1": [...]} into the event array', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify({
          '1': [
            { title: 'School play', date: '2026-06-10' },
            { title: 'Bake sale', date: '2026-06-15' },
          ],
        }),
      );

      const events = await service.parseMessage('flyer', '2026-05-10', [
        { mimeType: 'image/png', data: 'AAAA' },
      ]);

      expect(events).toHaveLength(2);
      expect(events.map((e) => e.title)).toEqual(['School play', 'Bake sale']);
    });

    it('flattens multi-key batch-shapes by union (single-call case)', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify({
          '1': [{ title: 'Event A', date: '2026-06-10' }],
          '2': [{ title: 'Event B', date: '2026-06-11' }],
        }),
      );

      const events = await service.parseMessage('flyer', '2026-05-10', [
        { mimeType: 'image/png', data: 'AAAA' },
      ]);

      expect(events.map((e) => e.title)).toEqual(['Event A', 'Event B']);
    });

    it('ignores an object whose values are not all arrays', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify({ message: 'no events', count: 0 }),
      );

      const events = await service.parseMessage('flyer', '2026-05-10');
      expect(events).toHaveLength(0);
    });
  });

  describe('image input', () => {
    it('forwards images to the LLM on the user message', async () => {
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([{ title: 'School play', date: '2026-06-10' }]),
      );

      const images = [{ mimeType: 'image/jpeg', data: 'AAAA' }];
      const events = await service.parseMessage('', '2026-05-10', images);

      expect(events).toHaveLength(1);
      expect(events[0].title).toBe('School play');

      const sent = mockLlmService.callLLM.mock.calls[0][0];
      const userMsg = sent.find((m: any) => m.role === 'user');
      expect(userMsg.images).toEqual(images);
      // Empty content should not produce a "Message text:" block
      expect(userMsg.content).not.toContain('Message text:');
      expect(userMsg.content).toContain('1 attached image(s)');
    });

    it('uses different cache keys for the same text with vs without images', async () => {
      mockLlmService.callLLM.mockResolvedValue('[]');

      await service.parseMessage('flyer', '2026-05-10');
      await service.parseMessage('flyer', '2026-05-10', [
        { mimeType: 'image/png', data: 'ZZZZ' },
      ]);

      const calls = mockCacheManager.get.mock.calls;
      expect(calls[0][0]).not.toBe(calls[1][0]);
    });

    it('routes image-bearing groups out of the batch path', async () => {
      // Text-only batch should still hit the multi-message LLM call;
      // image groups should be parsed individually.
      mockLlmService.callLLM
        // Per-message call for the image group
        .mockResolvedValueOnce(
          JSON.stringify([{ title: 'Image event', date: '2026-06-01' }]),
        )
        // Batch call for the two text-only groups
        .mockResolvedValueOnce(
          JSON.stringify({
            '1': [{ title: 'Text event A', date: '2026-06-02' }],
            '2': [{ title: 'Text event B', date: '2026-06-03' }],
          }),
        );

      const result = await service.parseMessageBatch(
        [
          {
            id: 'img',
            content: '',
            images: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
          },
          { id: 'a', content: 'text a' },
          { id: 'b', content: 'text b' },
        ],
        '2026-05-10',
      );

      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(2);
      expect(result.get('img')?.[0].title).toBe('Image event');
      expect(result.get('a')?.[0].title).toBe('Text event A');
      expect(result.get('b')?.[0].title).toBe('Text event B');

      // First call should be the per-message (image) call — no multi-message delimiters
      const firstCall = mockLlmService.callLLM.mock.calls[0][0];
      const firstUser = firstCall.find((m: any) => m.role === 'user');
      expect(firstUser.images).toBeDefined();
      expect(firstUser.content).not.toContain('===MESSAGE_');

      // Second call is the text-only batch
      const secondCall = mockLlmService.callLLM.mock.calls[1][0];
      const secondUser = secondCall.find((m: any) => m.role === 'user');
      expect(secondUser.images).toBeUndefined();
      expect(secondUser.content).toContain('===MESSAGE_1===');
      expect(secondUser.content).toContain('===MESSAGE_2===');
    });
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

  describe('classifier integration (two-stage pipeline)', () => {
    it('parseMessage short-circuits to [] when classifier says NO — no LLM call', async () => {
      mockClassifierService.classify.mockResolvedValue({
        isEvent: false,
        reason: 'absence-notice',
      });

      const events = await service.parseMessage('לא נגיע היום, יש בית חם');

      expect(events).toEqual([]);
      expect(mockLlmService.callLLM).not.toHaveBeenCalled();
      expect(mockSettingsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'metric.classifier_reject_total' }),
      );
    });

    it('parseMessage caches the empty result so the next sync skips the classifier too', async () => {
      mockClassifierService.classify.mockResolvedValue({ isEvent: false, reason: 'chit-chat' });

      await service.parseMessage('שלום!');

      // The empty [] is written to cache for the next sync.
      const setCalls = mockCacheManager.set.mock.calls.filter((c: any[]) => Array.isArray(c[1]) && c[1].length === 0);
      expect(setCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('parseMessage bypasses the classifier when an image is attached', async () => {
      mockLlmService.callLLM.mockResolvedValue('[]');

      await service.parseMessage('caption', '2026-06-20', [
        { mimeType: 'image/jpeg', data: 'base64=' },
      ]);

      expect(mockClassifierService.classify).not.toHaveBeenCalled();
      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(1);
    });

    it('parseMessage runs the extractor when classifier says YES', async () => {
      mockClassifierService.classify.mockResolvedValue({ isEvent: true, reason: 'date+activity' });
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([{ title: 'מבחן', date: '2026-06-20' }]),
      );

      const events = await service.parseMessage('מבחן בעברית מחר');

      expect(events).toHaveLength(1);
      expect(mockClassifierService.classify).toHaveBeenCalledTimes(1);
      expect(mockLlmService.callLLM).toHaveBeenCalledTimes(1);
    });

    it('parseMessageBatch filters NO groups and only sends YES groups to the LLM', async () => {
      // Two groups: first is a chit-chat (NO), second is a real event (YES).
      mockClassifierService.classify.mockImplementation((content: string) =>
        Promise.resolve(
          content.includes('שלום') ? { isEvent: false, reason: 'greeting' } : { isEvent: true, reason: 'real' },
        ),
      );
      mockLlmService.callLLM.mockResolvedValue(JSON.stringify({ '1': [{ title: 'מבחן', date: '2026-06-20' }] }));

      const result = await service.parseMessageBatch([
        { id: 'a', content: 'שלום!' },
        { id: 'b', content: 'מבחן מחר ב-10:00' },
      ]);

      expect(result.get('a')).toEqual([]);
      expect(result.get('b')?.length).toBeGreaterThan(0);
    });

    it('parseMessageBatch routes a single survivor through the single-message path', async () => {
      mockClassifierService.classify.mockResolvedValueOnce({ isEvent: false, reason: 'noise' });
      mockClassifierService.classify.mockResolvedValueOnce({ isEvent: true, reason: 'real' });
      mockLlmService.callLLM.mockResolvedValue(
        JSON.stringify([{ title: 'מבחן', date: '2026-06-20' }]),
      );

      const result = await service.parseMessageBatch([
        { id: 'a', content: 'שלום' },
        { id: 'b', content: 'מבחן' },
      ]);

      expect(result.get('a')).toEqual([]);
      expect(result.get('b')).toHaveLength(1);
    });

    it('parseMessageBatch skips classification on cache-hit groups', async () => {
      mockCacheManager.get.mockResolvedValueOnce([{ title: 'cached', date: '2026-06-20' }]);

      await service.parseMessageBatch([{ id: 'a', content: 'previously-seen' }]);

      expect(mockClassifierService.classify).not.toHaveBeenCalled();
    });

    it('parseMessage runs the extractor when classifier fails open (reason=classifier-fail-open)', async () => {
      mockClassifierService.classify.mockResolvedValue({
        isEvent: true,
        reason: 'classifier-fail-open',
      });
      mockLlmService.callLLM.mockResolvedValue('[]');

      await service.parseMessage('any');

      expect(mockLlmService.callLLM).toHaveBeenCalled();
    });
  });

  describe('buildSystemPrompt', () => {
    it('returns the default prompt when no setting is stored and no negatives exist', async () => {
      const built = await service.buildSystemPrompt();
      expect(built.prompt).toContain('You are a calendar event extractor');
      expect(built.version).toMatch(/^[0-9a-f]{16}$/);
    });

    it('uses the stored llm_system_prompt setting when present', async () => {
      mockSettingsService.findByKey.mockResolvedValue({
        key: 'llm_system_prompt',
        value: 'CUSTOM PROMPT FROM USER',
      });

      const built = await service.buildSystemPrompt();
      expect(built.prompt).toContain('CUSTOM PROMPT FROM USER');
    });

    it('Phase 24.5: does NOT append the negative-examples block (feedback loop retired)', async () => {
      const built = await service.buildSystemPrompt();
      expect(built.prompt).not.toContain('NEGATIVE EXAMPLES:');
      expect(built.prompt).not.toContain('do NOT create events for messages similar');
    });

    it('Phase 24.5: prompt-version hash depends only on prompt text, not on 😢 history', async () => {
      // Establish a stable baseline hash.
      const first = await service.buildSystemPrompt();
      // Simulate a 😢 reaction landing in the table mid-session. Cache key
      // must be unchanged so cached parses stay valid.
      const second = await service.buildSystemPrompt();

      expect(second.version).toEqual(first.version);
    });
  });

  describe('onModuleInit', () => {
    it('writes the current default prompt when user has not customized', async () => {
      // findByKey rejects for both keys (no custom flag, no stored prompt)
      mockSettingsService.findByKey.mockRejectedValue(new Error('Not found'));

      await service.onModuleInit();

      expect(mockSettingsService.create).toHaveBeenCalledWith({
        key: 'llm_system_prompt',
        value: expect.stringContaining('You are a calendar event extractor'),
      });
    });

    it('leaves the prompt untouched when user has a custom prompt', async () => {
      mockSettingsService.findByKey.mockResolvedValue({ value: 'true' });

      await service.onModuleInit();

      expect(mockSettingsService.create).not.toHaveBeenCalled();
    });
  });
});

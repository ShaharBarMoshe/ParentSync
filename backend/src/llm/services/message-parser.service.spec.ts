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
});

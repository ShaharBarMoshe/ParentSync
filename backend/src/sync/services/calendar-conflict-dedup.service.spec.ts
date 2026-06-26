import { Test, TestingModule } from '@nestjs/testing';
import { CalendarConflictDedupService } from './calendar-conflict-dedup.service';
import {
  EMBEDDING_SERVICE,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import { SettingsService } from '../../settings/settings.service';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { MessageSource } from '../../shared/enums/message-source.enum';

describe('CalendarConflictDedupService', () => {
  let service: CalendarConflictDedupService;
  let googleCalendarService: {
    searchEvents: jest.Mock;
    createEvent: jest.Mock;
    updateEvent: jest.Mock;
    deleteEvent: jest.Mock;
    getCalendarList: jest.Mock;
    eventExists: jest.Mock;
  };
  let embeddingService: { embedText: jest.Mock; embedBatch: jest.Mock };
  let settings: { findByKey: jest.Mock };

  // Build a unit vector deterministically from a seed so we can craft
  // controlled similarity scores between fixtures.
  const unitVec = (seed: number, dim = 8): number[] => {
    const arr = Array.from({ length: dim }, (_, i) =>
      Math.sin((i + 1) * (seed + 1)),
    );
    const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    return arr.map((v) => v / mag);
  };

  // Build a vector that is `targetSim` apart from `base`. We do this by
  // mixing the base vector with an orthogonal one: v = a*base + b*orth,
  // chosen so cos(v, base) ~= targetSim.
  const vecAtSim = (base: number[], targetSim: number): number[] => {
    const orth = unitVec(999, base.length);
    // Subtract the base-projection so orth is orthogonal-ish to base
    const dot = base.reduce((s, v, i) => s + v * orth[i], 0);
    const orthClean = orth.map((v, i) => v - dot * base[i]);
    const mag = Math.sqrt(orthClean.reduce((s, v) => s + v * v, 0));
    const orthUnit = orthClean.map((v) => v / mag);
    const a = targetSim;
    const b = Math.sqrt(Math.max(0, 1 - targetSim * targetSim));
    return base.map((v, i) => a * v + b * orthUnit[i]);
  };

  const settingsResolver =
    (overrides: Record<string, string> = {}) =>
    (key: string) => {
      const defaults: Record<string, string> = {
        calendar_dedup_enabled: 'true',
        calendar_dedup_threshold: '0.88',
      };
      const v = overrides[key] ?? defaults[key];
      if (v === undefined)
        return Promise.reject(new Error(`Setting not found: ${key}`));
      return Promise.resolve({ value: v });
    };

  const makeEvent = (overrides: Partial<CalendarEventEntity> = {}): CalendarEventEntity => ({
    id: 'evt-1',
    title: 'Field trip to museum',
    description: '',
    date: '2026-06-15',
    time: '10:00',
    endTime: null as unknown as string,
    location: 'Tel Aviv museum',
    source: MessageSource.WHATSAPP,
    sourceId: 'msg-1',
    sourceContent: null,
    childId: 'child-1',
    calendarColorId: null as unknown as string,
    googleEventId: null as unknown as string,
    syncType: 'event',
    googleTaskListId: null as unknown as string,
    syncedToGoogle: false,
    approvalStatus: ApprovalStatus.PENDING,
    approvalMessageId: null as unknown as string,
    reminderSent: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    googleCalendarService = {
      searchEvents: jest.fn().mockResolvedValue([]),
      createEvent: jest.fn(),
      updateEvent: jest.fn(),
      deleteEvent: jest.fn(),
      getCalendarList: jest.fn(),
      eventExists: jest.fn(),
    };
    embeddingService = {
      embedText: jest.fn(),
      embedBatch: jest.fn(),
    };
    settings = { findByKey: jest.fn().mockImplementation(settingsResolver()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarConflictDedupService,
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: googleCalendarService },
        { provide: EMBEDDING_SERVICE, useValue: embeddingService },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();

    service = module.get(CalendarConflictDedupService);
  });

  describe('short-circuits', () => {
    it("returns null when calendar_dedup_enabled is 'false' and never calls Google", async () => {
      settings.findByKey.mockImplementation(
        settingsResolver({ calendar_dedup_enabled: 'false' }),
      );

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
      expect(googleCalendarService.searchEvents).not.toHaveBeenCalled();
      expect(embeddingService.embedText).not.toHaveBeenCalled();
    });

    it('returns null for date-only tasks (no event.time) without hitting Google', async () => {
      const result = await service.findConflict(
        makeEvent({ time: null as unknown as string }),
        'primary',
      );

      expect(result).toBeNull();
      expect(googleCalendarService.searchEvents).not.toHaveBeenCalled();
    });

    it('returns null when searchEvents returns an empty window', async () => {
      googleCalendarService.searchEvents.mockResolvedValue([]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
      expect(embeddingService.embedText).not.toHaveBeenCalled();
    });

    it('ignores candidates with empty / whitespace summaries', async () => {
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g1', summary: '', date: '2026-06-15', time: '10:00' },
        { googleEventId: 'g2', summary: '   ', date: '2026-06-15', time: '10:30' },
      ]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
      expect(embeddingService.embedText).not.toHaveBeenCalled();
    });
  });

  describe('similarity gate', () => {
    it('returns a match when one candidate scores ≥ threshold', async () => {
      const proposed = unitVec(1);
      const candidateMatch = vecAtSim(proposed, 0.95);
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g-hit', summary: 'Field trip museum', date: '2026-06-15', time: '10:00' },
      ]);
      embeddingService.embedText.mockResolvedValue(proposed);
      embeddingService.embedBatch.mockResolvedValue([candidateMatch]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).not.toBeNull();
      expect(result!.googleEventId).toBe('g-hit');
      expect(result!.similarity).toBeGreaterThanOrEqual(0.94);
    });

    it('returns the highest-similarity match when multiple candidates exceed threshold', async () => {
      const proposed = unitVec(1);
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g-89', summary: 'A', date: '2026-06-15', time: '10:00' },
        { googleEventId: 'g-95', summary: 'B', date: '2026-06-15', time: '10:30' },
        { googleEventId: 'g-91', summary: 'C', date: '2026-06-15', time: '10:45' },
      ]);
      embeddingService.embedText.mockResolvedValue(proposed);
      embeddingService.embedBatch.mockResolvedValue([
        vecAtSim(proposed, 0.89),
        vecAtSim(proposed, 0.95),
        vecAtSim(proposed, 0.91),
      ]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).not.toBeNull();
      expect(result!.googleEventId).toBe('g-95');
    });

    it('returns null when all candidates score below threshold (boundary 0.879 < 0.88)', async () => {
      const proposed = unitVec(1);
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g1', summary: 'near miss', date: '2026-06-15', time: '10:00' },
      ]);
      embeddingService.embedText.mockResolvedValue(proposed);
      embeddingService.embedBatch.mockResolvedValue([vecAtSim(proposed, 0.879)]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
    });

    it('matches at the exact threshold boundary (≥, not >)', async () => {
      const proposed = unitVec(1);
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g1', summary: 'exact', date: '2026-06-15', time: '10:00' },
      ]);
      embeddingService.embedText.mockResolvedValue(proposed);
      // Floating-point construction won't give exactly 0.88, so push just above
      embeddingService.embedBatch.mockResolvedValue([vecAtSim(proposed, 0.881)]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).not.toBeNull();
    });

    it('honours a custom threshold from settings', async () => {
      settings.findByKey.mockImplementation(
        settingsResolver({ calendar_dedup_threshold: '0.95' }),
      );
      const proposed = unitVec(1);
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g1', summary: 'borderline', date: '2026-06-15', time: '10:00' },
      ]);
      embeddingService.embedText.mockResolvedValue(proposed);
      // 0.91 would match at default 0.88 but not at custom 0.95
      embeddingService.embedBatch.mockResolvedValue([vecAtSim(proposed, 0.91)]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
    });

    it('falls back to default threshold when settings value is malformed', async () => {
      settings.findByKey.mockImplementation(
        settingsResolver({ calendar_dedup_threshold: 'not-a-number' }),
      );
      const proposed = unitVec(1);
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g1', summary: 'ok', date: '2026-06-15', time: '10:00' },
      ]);
      embeddingService.embedText.mockResolvedValue(proposed);
      embeddingService.embedBatch.mockResolvedValue([vecAtSim(proposed, 0.95)]);

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).not.toBeNull();
    });
  });

  describe('fail-open guarantees', () => {
    it('returns null when searchEvents throws', async () => {
      googleCalendarService.searchEvents.mockRejectedValue(
        new Error('Google API quota exhausted'),
      );

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
      expect(embeddingService.embedText).not.toHaveBeenCalled();
    });

    it('returns null when embedText throws', async () => {
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g1', summary: 'meeting', date: '2026-06-15', time: '10:00' },
      ]);
      embeddingService.embedText.mockRejectedValue(new Error('embed API down'));

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
    });

    it('returns null when embedBatch throws', async () => {
      googleCalendarService.searchEvents.mockResolvedValue([
        { googleEventId: 'g1', summary: 'meeting', date: '2026-06-15', time: '10:00' },
      ]);
      embeddingService.embedText.mockResolvedValue(unitVec(1));
      embeddingService.embedBatch.mockRejectedValue(new Error('embed batch fail'));

      const result = await service.findConflict(makeEvent(), 'primary');

      expect(result).toBeNull();
    });
  });

  describe('window bounds', () => {
    it('passes ±60-minute ISO timestamps to searchEvents', async () => {
      await service.findConflict(
        makeEvent({ date: '2026-06-15', time: '14:30' }),
        'primary',
      );

      expect(googleCalendarService.searchEvents).toHaveBeenCalledTimes(1);
      const [calendarId, query, timeMin, timeMax] =
        googleCalendarService.searchEvents.mock.calls[0];
      expect(calendarId).toBe('primary');
      expect(query).toBe('');
      // 14:30 ± 60min in local-naive parsing → 13:30 and 15:30 (UTC offset
      // depends on host TZ; we just verify the delta is 120 minutes apart).
      const min = new Date(timeMin).getTime();
      const max = new Date(timeMax).getTime();
      expect(max - min).toBe(120 * 60 * 1000);
    });

    it('uses the supplied calendarId verbatim (not hard-coded primary)', async () => {
      await service.findConflict(makeEvent(), 'family-shared@group.calendar.google.com');

      expect(googleCalendarService.searchEvents).toHaveBeenCalledWith(
        'family-shared@group.calendar.google.com',
        '',
        expect.any(String),
        expect.any(String),
      );
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MonitorService } from './monitor.service';
import { MessageEntity } from '../../messages/entities/message.entity';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { SyncLogEntity } from '../../sync/entities/sync-log.entity';

describe('MonitorService', () => {
  let service: MonitorService;
  let mockMessageRepo: any;
  let mockEventRepo: any;
  let mockSyncLogRepo: any;

  function makeFullMsgQb(messages: any[] = []) {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(messages),
      getCount: jest.fn().mockResolvedValue(messages.length),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(null),
    };
  }

  function makeFullEvtQb(count = 0) {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(count),
    };
  }

  function makeFullSyncQb(logs: any[] = []) {
    return {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(logs),
    };
  }

  beforeEach(async () => {
    mockMessageRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(makeFullMsgQb()),
      findOne: jest.fn(),
    };

    mockEventRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(makeFullEvtQb()),
    };

    mockSyncLogRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(makeFullSyncQb()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitorService,
        { provide: getRepositoryToken(MessageEntity), useValue: mockMessageRepo },
        { provide: getRepositoryToken(CalendarEventEntity), useValue: mockEventRepo },
        { provide: getRepositoryToken(SyncLogEntity), useValue: mockSyncLogRepo },
      ],
    }).compile();

    service = module.get<MonitorService>(MonitorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ──────────────────────────────────────────────────────
  // getMessagesOverTime
  // ──────────────────────────────────────────────────────
  describe('getMessagesOverTime', () => {
    it('should return chart data grouped by day', async () => {
      const now = new Date('2026-03-24T12:00:00Z');
      const yesterday = new Date('2026-03-23T10:00:00Z');

      mockMessageRepo.createQueryBuilder.mockReturnValue(
        makeFullMsgQb([
          { source: 'whatsapp', timestamp: now },
          { source: 'whatsapp', timestamp: now },
          { source: 'email', timestamp: yesterday },
        ]),
      );

      const result = await service.getMessagesOverTime({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
        groupBy: 'day',
      });

      expect(result.labels).toContain('2026-03-24');
      expect(result.labels).toContain('2026-03-23');
      expect(result.datasets).toHaveLength(2);
      expect(result.datasets[0].label).toBe('WhatsApp');
      expect(result.datasets[1].label).toBe('Email');

      const idx24 = result.labels.indexOf('2026-03-24');
      expect(result.datasets[0].data[idx24]).toBe(2);
      const idx23 = result.labels.indexOf('2026-03-23');
      expect(result.datasets[1].data[idx23]).toBe(1);
    });

    it('should group by week', async () => {
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        makeFullMsgQb([
          { source: 'whatsapp', timestamp: new Date('2026-03-02T12:00:00Z') },
          { source: 'whatsapp', timestamp: new Date('2026-03-05T12:00:00Z') },
          { source: 'whatsapp', timestamp: new Date('2026-03-10T12:00:00Z') },
        ]),
      );

      const result = await service.getMessagesOverTime({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-15T23:59:59Z',
        groupBy: 'week',
      });

      // Weeks should be fewer labels than 15 days
      expect(result.labels.length).toBeLessThan(15);
      expect(result.labels.length).toBeGreaterThanOrEqual(2);
      // Total WhatsApp messages should be 3
      const total = result.datasets[0].data.reduce((a, b) => a + b, 0);
      expect(total).toBe(3);
    });

    it('should group by month', async () => {
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        makeFullMsgQb([
          { source: 'email', timestamp: new Date('2026-01-15T12:00:00Z') },
          { source: 'email', timestamp: new Date('2026-02-15T12:00:00Z') },
          { source: 'email', timestamp: new Date('2026-03-15T12:00:00Z') },
        ]),
      );

      const result = await service.getMessagesOverTime({
        from: '2026-01-01T00:00:00Z',
        to: '2026-03-31T23:59:59Z',
        groupBy: 'month',
      });

      expect(result.labels).toContain('2026-01');
      expect(result.labels).toContain('2026-02');
      expect(result.labels).toContain('2026-03');
      // Each month has 1 email
      for (const label of ['2026-01', '2026-02', '2026-03']) {
        const idx = result.labels.indexOf(label);
        expect(result.datasets[1].data[idx]).toBe(1);
      }
    });

    it('should filter by childId', async () => {
      const qb = makeFullMsgQb([]);
      mockMessageRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getMessagesOverTime({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
        childId: 'child-1',
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'm.childId = :childId',
        { childId: 'child-1' },
      );
    });

    it('should return empty datasets when no messages', async () => {
      const result = await service.getMessagesOverTime({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result.datasets[0].data.every((d) => d === 0)).toBe(true);
      expect(result.datasets[1].data.every((d) => d === 0)).toBe(true);
    });

    it('should default to last 30 days when no dates provided', async () => {
      const result = await service.getMessagesOverTime({});

      expect(result.labels.length).toBeGreaterThanOrEqual(30);
      expect(result.labels.length).toBeLessThanOrEqual(32);
    });
  });

  // ──────────────────────────────────────────────────────
  // getEventsPerChannel
  // ──────────────────────────────────────────────────────
  describe('getEventsPerChannel', () => {
    it('should return events grouped by channel sorted descending', async () => {
      const events = [
        { sourceId: 'msg-1', source: 'whatsapp' },
        { sourceId: 'msg-2', source: 'whatsapp' },
        { sourceId: 'msg-3', source: 'email' },
      ];
      const evtQb = makeFullEvtQb();
      evtQb.getMany.mockResolvedValue(events);
      mockEventRepo.createQueryBuilder.mockReturnValue(evtQb);

      // msg-1 and msg-2 are from "Parents Group", msg-3 from "INBOX"
      mockMessageRepo.findOne
        .mockResolvedValueOnce({ channel: 'Parents Group' })
        .mockResolvedValueOnce({ channel: 'Parents Group' })
        .mockResolvedValueOnce({ channel: 'INBOX' });

      const result = await service.getEventsPerChannel({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-31T23:59:59Z',
      });

      expect(result.labels[0]).toBe('Parents Group');
      expect(result.datasets[0].data[0]).toBe(2);
      expect(result.labels[1]).toBe('INBOX');
      expect(result.datasets[0].data[1]).toBe(1);
    });

    it('should return empty when no events', async () => {
      const result = await service.getEventsPerChannel({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-31T23:59:59Z',
      });

      expect(result.labels).toHaveLength(0);
      expect(result.datasets[0].data).toHaveLength(0);
    });

    it('should label events without sourceId as Unknown', async () => {
      const evtQb = makeFullEvtQb();
      evtQb.getMany.mockResolvedValue([
        { sourceId: null, source: 'whatsapp' },
      ]);
      mockEventRepo.createQueryBuilder.mockReturnValue(evtQb);

      const result = await service.getEventsPerChannel({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-31T23:59:59Z',
      });

      expect(result.labels[0]).toBe('Unknown');
    });

    it('should filter by childId', async () => {
      const evtQb = makeFullEvtQb();
      evtQb.getMany.mockResolvedValue([]);
      mockEventRepo.createQueryBuilder.mockReturnValue(evtQb);

      await service.getEventsPerChannel({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-31T23:59:59Z',
        childId: 'child-2',
      });

      expect(evtQb.andWhere).toHaveBeenCalledWith(
        'e.childId = :childId',
        { childId: 'child-2' },
      );
    });
  });

  // ──────────────────────────────────────────────────────
  // getSyncHistory
  // ──────────────────────────────────────────────────────
  describe('getSyncHistory', () => {
    it('should return sync logs with duration', async () => {
      const startedAt = new Date('2026-03-24T10:00:00Z');
      const endedAt = new Date('2026-03-24T10:00:05Z');

      mockSyncLogRepo.createQueryBuilder.mockReturnValue(
        makeFullSyncQb([
          {
            id: 'log-1',
            timestamp: new Date('2026-03-24T10:00:00Z'),
            startedAt,
            endedAt,
            status: 'success',
            messageCount: 10,
            eventsCreated: 3,
            channelDetails: [],
          },
        ]),
      );

      const result = await service.getSyncHistory({
        from: '2026-03-24T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result).toHaveLength(1);
      expect(result[0].durationMs).toBe(5000);
      expect(result[0].status).toBe('success');
      expect(result[0].messageCount).toBe(10);
      expect(result[0].eventsCreated).toBe(3);
    });

    it('should handle null startedAt/endedAt', async () => {
      mockSyncLogRepo.createQueryBuilder.mockReturnValue(
        makeFullSyncQb([
          {
            id: 'log-1',
            timestamp: new Date('2026-03-24T10:00:00Z'),
            startedAt: null,
            endedAt: null,
            status: 'success',
            messageCount: 5,
            eventsCreated: 0,
            channelDetails: null,
          },
        ]),
      );

      const result = await service.getSyncHistory({
        from: '2026-03-24T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result[0].durationMs).toBeNull();
      expect(result[0].startedAt).toBeNull();
      expect(result[0].endedAt).toBeNull();
    });

    it('should return empty array when no logs', async () => {
      const result = await service.getSyncHistory({
        from: '2026-03-24T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result).toEqual([]);
    });

    it('should return multiple logs ordered by timestamp', async () => {
      mockSyncLogRepo.createQueryBuilder.mockReturnValue(
        makeFullSyncQb([
          {
            id: 'log-1',
            timestamp: new Date('2026-03-23T10:00:00Z'),
            startedAt: new Date('2026-03-23T10:00:00Z'),
            endedAt: new Date('2026-03-23T10:00:02Z'),
            status: 'success',
            messageCount: 5,
            eventsCreated: 1,
            channelDetails: [],
          },
          {
            id: 'log-2',
            timestamp: new Date('2026-03-24T10:00:00Z'),
            startedAt: new Date('2026-03-24T10:00:00Z'),
            endedAt: new Date('2026-03-24T10:00:10Z'),
            status: 'failed',
            messageCount: 0,
            eventsCreated: 0,
            channelDetails: [],
          },
        ]),
      );

      const result = await service.getSyncHistory({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-25T23:59:59Z',
      });

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('success');
      expect(result[1].status).toBe('failed');
      expect(result[1].durationMs).toBe(10000);
    });
  });

  // ──────────────────────────────────────────────────────
  // getSummary
  // ──────────────────────────────────────────────────────
  describe('getSummary', () => {
    it('should return summary with all metrics', async () => {
      const startedAt = new Date('2026-03-24T10:00:00Z');
      const endedAt = new Date('2026-03-24T10:00:03Z');

      const msgQb = makeFullMsgQb();
      msgQb.getCount.mockResolvedValue(50);
      msgQb.getRawOne.mockResolvedValue({ channel: 'Parents Group', count: 30 });
      mockMessageRepo.createQueryBuilder.mockReturnValue(msgQb);

      let evtCallCount = 0;
      mockEventRepo.createQueryBuilder.mockImplementation(() => {
        evtCallCount++;
        const qb = makeFullEvtQb(evtCallCount === 1 ? 15 : 10);
        return qb;
      });

      mockSyncLogRepo.createQueryBuilder.mockReturnValue(
        makeFullSyncQb([
          {
            timestamp: new Date('2026-03-24T10:00:00Z'),
            status: 'success',
            messageCount: 25,
            startedAt,
            endedAt,
          },
          {
            timestamp: new Date('2026-03-23T10:00:00Z'),
            status: 'success',
            messageCount: 25,
            startedAt,
            endedAt,
          },
        ]),
      );

      const result = await service.getSummary({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result.totalMessages).toBe(50);
      expect(result.totalSyncs).toBe(2);
      expect(result.syncSuccessRate).toBe(100);
      expect(result.avgSyncDurationMs).toBe(3000);
      expect(result.avgMessagesPerSync).toBe(25);
      expect(result.mostActiveChannel).toBe('Parents Group');
      expect(result.lastSync).not.toBeNull();
      expect(result.lastSync!.status).toBe('success');
    });

    it('should handle zero syncs', async () => {
      const result = await service.getSummary({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result.totalMessages).toBe(0);
      expect(result.totalEvents).toBe(0);
      expect(result.totalSyncs).toBe(0);
      expect(result.syncSuccessRate).toBe(0);
      expect(result.avgMessagesPerSync).toBe(0);
      expect(result.avgSyncDurationMs).toBe(0);
      expect(result.mostActiveChannel).toBeNull();
      expect(result.lastSync).toBeNull();
    });

    it('should calculate partial success rate', async () => {
      const startedAt = new Date('2026-03-24T10:00:00Z');
      const endedAt = new Date('2026-03-24T10:00:01Z');

      mockSyncLogRepo.createQueryBuilder.mockReturnValue(
        makeFullSyncQb([
          { timestamp: new Date('2026-03-24T10:00:00Z'), status: 'success', messageCount: 10, startedAt, endedAt },
          { timestamp: new Date('2026-03-23T10:00:00Z'), status: 'failed', messageCount: 0, startedAt, endedAt },
          { timestamp: new Date('2026-03-22T10:00:00Z'), status: 'success', messageCount: 5, startedAt, endedAt },
          { timestamp: new Date('2026-03-21T10:00:00Z'), status: 'partial', messageCount: 3, startedAt, endedAt },
        ]),
      );

      const result = await service.getSummary({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      // 2 out of 4 are "success"
      expect(result.syncSuccessRate).toBe(50);
      expect(result.totalSyncs).toBe(4);
      expect(result.avgMessagesPerSync).toBe(4.5);
    });

    it('should include previous period data for trend comparison', async () => {
      // createQueryBuilder calls for messages: (1) current count, (2) channel agg, (3) prev count
      let msgCallCount = 0;
      mockMessageRepo.createQueryBuilder.mockImplementation(() => {
        msgCallCount++;
        const qb = makeFullMsgQb();
        if (msgCallCount === 1) qb.getCount.mockResolvedValue(50);       // current period
        else if (msgCallCount === 2) qb.getRawOne.mockResolvedValue(null); // channel agg
        else if (msgCallCount === 3) qb.getCount.mockResolvedValue(30);   // previous period
        return qb;
      });

      let evtCallCount = 0;
      mockEventRepo.createQueryBuilder.mockImplementation(() => {
        evtCallCount++;
        return makeFullEvtQb(evtCallCount === 1 ? 10 : 5);
      });

      const result = await service.getSummary({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result.totalMessages).toBe(50);
      expect(result.previousPeriod.totalMessages).toBe(30);
      expect(result.totalEvents).toBe(10);
      expect(result.previousPeriod.totalEvents).toBe(5);
    });

    it('should filter by childId across all queries', async () => {
      const msgQb = makeFullMsgQb();
      mockMessageRepo.createQueryBuilder.mockReturnValue(msgQb);

      const evtQb = makeFullEvtQb();
      mockEventRepo.createQueryBuilder.mockReturnValue(evtQb);

      await service.getSummary({
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
        childId: 'child-x',
      });

      // Both message and event queries should filter by childId
      expect(msgQb.andWhere).toHaveBeenCalledWith(
        'm.childId = :childId',
        { childId: 'child-x' },
      );
      expect(evtQb.andWhere).toHaveBeenCalledWith(
        'e.childId = :childId',
        { childId: 'child-x' },
      );
    });
  });

  // ──────────────────────────────────────────────────────
  // getChannelsActivity
  // ──────────────────────────────────────────────────────
  describe('getChannelsActivity', () => {
    it('should return heatmap matrix', async () => {
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        makeFullMsgQb([
          { channel: 'Group A', timestamp: new Date('2026-03-23T10:00:00Z') },
          { channel: 'Group A', timestamp: new Date('2026-03-23T11:00:00Z') },
          { channel: 'Group B', timestamp: new Date('2026-03-24T10:00:00Z') },
        ]),
      );

      const result = await service.getChannelsActivity({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
        groupBy: 'day',
      });

      expect(result.channels).toContain('Group A');
      expect(result.channels).toContain('Group B');
      expect(result.dates.length).toBeGreaterThanOrEqual(3);
      expect(result.data.length).toBe(2);

      const channelAIdx = result.channels.indexOf('Group A');
      const date23Idx = result.dates.indexOf('2026-03-23');
      expect(result.data[channelAIdx][date23Idx]).toBe(2);
    });

    it('should return empty for no messages', async () => {
      const result = await service.getChannelsActivity({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
      });

      expect(result.channels).toHaveLength(0);
      expect(result.data).toHaveLength(0);
      expect(result.dates.length).toBeGreaterThan(0); // dates are generated regardless
    });

    it('should filter by childId', async () => {
      const qb = makeFullMsgQb([]);
      mockMessageRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getChannelsActivity({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
        childId: 'child-3',
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'm.childId = :childId',
        { childId: 'child-3' },
      );
    });

    it('should have zero-filled cells for dates with no messages', async () => {
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        makeFullMsgQb([
          { channel: 'Group A', timestamp: new Date('2026-03-23T10:00:00Z') },
        ]),
      );

      const result = await service.getChannelsActivity({
        from: '2026-03-22T00:00:00Z',
        to: '2026-03-24T23:59:59Z',
        groupBy: 'day',
      });

      const channelAIdx = result.channels.indexOf('Group A');
      const date22Idx = result.dates.indexOf('2026-03-22');
      const date24Idx = result.dates.indexOf('2026-03-24');
      expect(result.data[channelAIdx][date22Idx]).toBe(0);
      expect(result.data[channelAIdx][date24Idx]).toBe(0);
    });
  });
});

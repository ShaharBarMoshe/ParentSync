import { Test, TestingModule } from '@nestjs/testing';
import { ScreenEventsNode } from './screen-events.node';
import { EVENT_REPOSITORY } from '../../../shared/constants/injection-tokens';
import { MessageParserService } from '../../../llm/services/message-parser.service';
import { CalendarConflictDedupService } from '../../services/calendar-conflict-dedup.service';
import { SyncSettings } from '../sync-settings.service';
import { ApprovalStatus } from '../../../shared/enums/approval-status.enum';
import type { EventSyncState } from '../event-sync.state';
import { daysFromNow, daysAgo } from '../../../../test/helpers/relative-dates';

describe('ScreenEventsNode', () => {
  let node: ScreenEventsNode;
  let eventRepository: any;
  let parser: { eventsAreIdentical: jest.Mock };
  let conflictDedup: { findConflict: jest.Mock };
  let syncSettings: { calendarId: jest.Mock; incrementMetric: jest.Mock };

  const future = daysFromNow(7);
  const past = daysAgo(3).toISOString().split('T')[0];

  const event = (over: Record<string, unknown> = {}) =>
    ({
      id: 'evt-1',
      title: 'Trip',
      date: future,
      time: '09:00',
      childId: 'child-1',
      location: null,
      description: null,
      ...over,
    }) as any;

  /** Only `savedEvents` matters to this node; the rest is graph scaffolding. */
  const stateWith = (savedEvents: any[]) =>
    ({ savedEvents }) as unknown as EventSyncState;

  beforeEach(async () => {
    eventRepository = {
      update: jest.fn().mockResolvedValue({}),
      findSameSlotForChild: jest.fn().mockResolvedValue([]),
      findSameDayForChild: jest.fn().mockResolvedValue([]),
    };
    parser = { eventsAreIdentical: jest.fn().mockResolvedValue(false) };
    conflictDedup = { findConflict: jest.fn().mockResolvedValue(null) };
    syncSettings = {
      calendarId: jest.fn().mockResolvedValue('primary'),
      incrementMetric: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScreenEventsNode,
        { provide: EVENT_REPOSITORY, useValue: eventRepository },
        { provide: MessageParserService, useValue: parser },
        { provide: CalendarConflictDedupService, useValue: conflictDedup },
        { provide: SyncSettings, useValue: syncSettings },
      ],
    }).compile();

    node = module.get(ScreenEventsNode);
  });

  it('queues a clean event for approval', async () => {
    const result = await node.run(stateWith([event()]));
    expect(result.approvalCandidates).toHaveLength(1);
    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  it('auto-approves a past event instead of asking about it', async () => {
    const result = await node.run(stateWith([event({ date: past })]));
    expect(result.approvalCandidates).toHaveLength(0);
    expect(eventRepository.update).toHaveBeenCalledWith('evt-1', {
      approvalStatus: ApprovalStatus.NONE,
    });
  });

  describe('duplicate of a sibling', () => {
    it('rejects the newcomer when the judge says they are the same', async () => {
      eventRepository.findSameSlotForChild.mockResolvedValue([
        event({ id: 'evt-0', title: 'School trip' }),
      ]);
      parser.eventsAreIdentical.mockResolvedValue(true);

      const result = await node.run(stateWith([event()]));

      expect(result.approvalCandidates).toHaveLength(0);
      expect(eventRepository.update).toHaveBeenCalledWith('evt-1', {
        approvalStatus: ApprovalStatus.REJECTED,
      });
      expect(syncSettings.incrementMetric).toHaveBeenCalledWith(
        'metric.event_dedup_llm_fires',
      );
    });

    it('checks same-day siblings too, not just the exact slot', async () => {
      eventRepository.findSameDayForChild.mockResolvedValue([
        event({ id: 'evt-0', time: '18:00' }),
      ]);
      parser.eventsAreIdentical.mockResolvedValue(true);
      const result = await node.run(stateWith([event({ time: '16:45' })]));
      expect(result.approvalCandidates).toHaveLength(0);
    });

    it('compares each sibling only once when both queries return it', async () => {
      const sibling = event({ id: 'evt-0' });
      eventRepository.findSameSlotForChild.mockResolvedValue([sibling]);
      eventRepository.findSameDayForChild.mockResolvedValue([sibling]);
      await node.run(stateWith([event()]));
      expect(parser.eventsAreIdentical).toHaveBeenCalledTimes(1);
    });

    it('keeps the event when the judge says they differ', async () => {
      eventRepository.findSameSlotForChild.mockResolvedValue([
        event({ id: 'evt-0' }),
      ]);
      parser.eventsAreIdentical.mockResolvedValue(false);
      const result = await node.run(stateWith([event()]));
      expect(result.approvalCandidates).toHaveLength(1);
    });
  });

  describe('calendar conflict', () => {
    it('binds to the existing Google event rather than creating a second', async () => {
      conflictDedup.findConflict.mockResolvedValue({
        googleEventId: 'g-99',
        summary: 'Class trip',
        similarity: 0.93,
      });

      const result = await node.run(stateWith([event()]));

      expect(result.approvalCandidates).toHaveLength(0);
      expect(eventRepository.update).toHaveBeenCalledWith('evt-1', {
        approvalStatus: ApprovalStatus.REJECTED,
        googleEventId: 'g-99',
        syncedToGoogle: true,
      });
      expect(syncSettings.incrementMetric).toHaveBeenCalledWith(
        'metric.calendar_dedup_fires',
      );
    });

    it('proceeds to approval when the conflict check throws', async () => {
      conflictDedup.findConflict.mockRejectedValue(new Error('calendar down'));
      const result = await node.run(stateWith([event()]));
      expect(result.approvalCandidates).toHaveLength(1);
    });
  });

  /**
   * The reason screening is its own node. Under the old mega-node a throw here
   * flipped the whole message group from parsed to failed; now it costs one
   * event, and that event still reaches the user.
   */
  describe('fail-open per event', () => {
    it('still queues an event whose duplicate check throws', async () => {
      eventRepository.findSameSlotForChild.mockRejectedValue(
        new Error('db went away'),
      );
      const result = await node.run(stateWith([event()]));
      expect(result.approvalCandidates).toHaveLength(1);
    });

    it('does not let one bad event cost the others', async () => {
      eventRepository.findSameSlotForChild
        .mockRejectedValueOnce(new Error('db went away'))
        .mockResolvedValue([]);

      const result = await node.run(
        stateWith([event({ id: 'evt-1' }), event({ id: 'evt-2' })]),
      );

      expect(result.approvalCandidates!.map((e) => e.id)).toEqual([
        'evt-1',
        'evt-2',
      ]);
    });
  });

  it('fetches the calendar id once for the whole batch', async () => {
    await node.run(stateWith([event({ id: 'a' }), event({ id: 'b' })]));
    expect(syncSettings.calendarId).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing saved', async () => {
    const result = await node.run(stateWith([]));
    expect(result.approvalCandidates).toEqual([]);
    expect(conflictDedup.findConflict).not.toHaveBeenCalled();
  });
});

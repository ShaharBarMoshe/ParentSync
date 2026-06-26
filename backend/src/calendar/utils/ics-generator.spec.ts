import { generateICS } from './ics-generator';
import { CalendarEventEntity } from '../entities/calendar-event.entity';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { MessageSource } from '../../shared/enums/message-source.enum';

describe('generateICS', () => {
  const makeEvent = (
    overrides: Partial<CalendarEventEntity> = {},
  ): CalendarEventEntity => ({
    id: 'evt-uuid',
    title: 'Sample event',
    description: 'desc',
    date: '2026-06-15',
    time: '14:00',
    endTime: null as unknown as string,
    location: 'Hall A',
    source: MessageSource.WHATSAPP,
    sourceId: 'msg-1',
    sourceContent: null,
    childId: null as unknown as string,
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

  // The `ics` library emits times in UTC anchored on the host TZ. We assert
  // structure (DTEND vs DURATION) and don't pin specific UTC values.

  it('emits DTEND (not DURATION) when both time and endTime are set', () => {
    const ics = generateICS(makeEvent({ time: '14:00', endTime: '15:30' }));

    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).toMatch(/DTEND:\d{8}T\d{6}Z/);
    expect(ics).not.toMatch(/DURATION:/);
  });

  it('uses default 1-hour DURATION when endTime is absent (regression)', () => {
    const ics = generateICS(makeEvent({ time: '14:00', endTime: null as unknown as string }));

    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).toMatch(/DURATION:PT1H/);
    expect(ics).not.toMatch(/DTEND:/);
  });

  it('emits no DTEND for all-day events with no endTime (regression)', () => {
    const ics = generateICS(makeEvent({ time: null as unknown as string, endTime: null as unknown as string }));

    expect(ics).toMatch(/DTSTART:/);
    expect(ics).not.toMatch(/DTEND:/);
  });

  it('ignores stray endTime when time is missing (no DTEND leaks through)', () => {
    const ics = generateICS(makeEvent({ time: null as unknown as string, endTime: '15:00' }));

    expect(ics).not.toMatch(/DTEND:/);
  });
});

import { CalendarEventEntity } from '../entities/calendar-event.entity';

export interface IEventRepository {
  findAll(): Promise<CalendarEventEntity[]>;
  findInDateRange(from: string, to: string): Promise<CalendarEventEntity[]>;
  /**
   * Other events that occupy the same date+time slot for the given child.
   * Used to detect duplicates before sending an approval message.
   * Excludes a given event id (the one being checked) and rejected events.
   */
  findSameSlotForChild(
    date: string,
    time: string | null,
    childId: string | null | undefined,
    excludeId: string,
  ): Promise<CalendarEventEntity[]>;
  findById(id: string): Promise<CalendarEventEntity | null>;
  findUnsynced(): Promise<CalendarEventEntity[]>;
  create(event: Partial<CalendarEventEntity>): Promise<CalendarEventEntity>;
  update(
    id: string,
    event: Partial<CalendarEventEntity>,
  ): Promise<CalendarEventEntity>;
  delete(id: string): Promise<void>;
  findByTitleDateTimeChild(
    title: string,
    date: string,
    time?: string,
    childId?: string,
  ): Promise<CalendarEventEntity | null>;
  findByApprovalMessageId(
    messageId: string,
  ): Promise<CalendarEventEntity | null>;
  findDueForReminder(now: Date): Promise<CalendarEventEntity[]>;
  findByTitleSubstringAndChild(
    titleSubstring: string,
    childId?: string,
    date?: string,
  ): Promise<CalendarEventEntity[]>;
}

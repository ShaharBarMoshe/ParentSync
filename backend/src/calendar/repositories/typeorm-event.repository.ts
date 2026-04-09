import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { CalendarEventEntity } from '../entities/calendar-event.entity';
import { IEventRepository } from '../interfaces/event-repository.interface';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';

@Injectable()
export class TypeOrmEventRepository implements IEventRepository {
  constructor(
    @InjectRepository(CalendarEventEntity)
    private readonly repo: Repository<CalendarEventEntity>,
  ) {}

  findAll(): Promise<CalendarEventEntity[]> {
    return this.repo.find({ order: { date: 'ASC' } });
  }

  findById(id: string): Promise<CalendarEventEntity | null> {
    return this.repo.findOneBy({ id });
  }

  findUnsynced(): Promise<CalendarEventEntity[]> {
    return this.repo.find({
      where: {
        syncedToGoogle: false,
        approvalStatus: In([ApprovalStatus.NONE, ApprovalStatus.APPROVED]),
      },
      order: { date: 'ASC' },
    });
  }

  async create(
    event: Partial<CalendarEventEntity>,
  ): Promise<CalendarEventEntity> {
    const entity = this.repo.create(event);
    return this.repo.save(entity);
  }

  async update(
    id: string,
    event: Partial<CalendarEventEntity>,
  ): Promise<CalendarEventEntity> {
    await this.repo.update(id, event);
    return this.repo.findOneByOrFail({ id });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async findDueForReminder(now: Date): Promise<CalendarEventEntity[]> {
    // Events created more than 24h ago that are still synced to Google,
    // not yet reminded, with start time in the next 24 hours.
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const candidates = await this.repo.find({
      where: {
        reminderSent: false,
        syncedToGoogle: true,
        googleEventId: Not(IsNull()),
        createdAt: LessThan(oneDayAgo),
      },
    });

    return candidates.filter((event) => {
      const startIso = event.time
        ? `${event.date}T${event.time}:00`
        : `${event.date}T00:00:00`;
      const start = new Date(startIso);
      return start.getTime() >= now.getTime() && start.getTime() <= in24h.getTime();
    });
  }

  findByApprovalMessageId(
    messageId: string,
  ): Promise<CalendarEventEntity | null> {
    return this.repo.findOneBy({ approvalMessageId: messageId });
  }

  findByTitleDateTimeChild(
    title: string,
    date: string,
    time?: string,
    childId?: string,
  ): Promise<CalendarEventEntity | null> {
    const where: Record<string, unknown> = { title, date };
    if (time) {
      where.time = time;
    } else {
      where.time = IsNull();
    }
    if (childId) {
      where.childId = childId;
    }
    return this.repo.findOneBy(where);
  }
}

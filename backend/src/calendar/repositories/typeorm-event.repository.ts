import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Not, Repository } from 'typeorm';
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

  findInDateRange(from: string, to: string): Promise<CalendarEventEntity[]> {
    return this.repo.find({
      where: { date: Between(from, to) },
      order: { date: 'ASC' },
    });
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
    // Find events scheduled for tomorrow that haven't been reminded yet.
    // "Tomorrow" is the next calendar day in local time (Asia/Jerusalem).
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

    return this.repo.find({
      where: {
        reminderSent: false,
        syncedToGoogle: true,
        googleEventId: Not(IsNull()),
        date: tomorrowDate,
      },
    });
  }

  findByApprovalMessageId(
    messageId: string,
  ): Promise<CalendarEventEntity | null> {
    return this.repo.findOneBy({ approvalMessageId: messageId });
  }

  async findByTitleSubstringAndChild(
    titleSubstring: string,
    childId?: string,
    date?: string,
  ): Promise<CalendarEventEntity[]> {
    const qb = this.repo
      .createQueryBuilder('event')
      .where('event.title LIKE :title', { title: `%${titleSubstring}%` })
      .andWhere('event.syncedToGoogle = :synced', { synced: true })
      .andWhere('event.approvalStatus != :rejected', {
        rejected: ApprovalStatus.REJECTED,
      });

    if (childId) {
      qb.andWhere('event.childId = :childId', { childId });
    }
    if (date) {
      qb.andWhere('event.date = :date', { date });
    }

    qb.orderBy('event.date', 'DESC').limit(10);

    return qb.getMany();
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

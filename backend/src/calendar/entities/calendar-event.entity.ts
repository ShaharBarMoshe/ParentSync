import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { MessageSource } from '../../shared/enums/message-source.enum';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';

export type SyncType = 'event' | 'task';

@Entity('calendar_events')
export class CalendarEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'date' })
  @Index()
  date: string;

  @Column({ type: 'varchar', nullable: true })
  time: string;

  @Column({ type: 'varchar', nullable: true })
  location: string;

  @Column({ type: 'varchar', nullable: true, enum: MessageSource })
  source: MessageSource;

  @Column({ type: 'varchar', nullable: true })
  @Index()
  sourceId: string;

  /**
   * Snapshot of the exact text the LLM saw when extracting this event.
   * For batched proximity groups this is the merged content of all messages
   * in the group — not just the first message — so a 😢 reject captures the
   * right negative example. Null on legacy events created before this column
   * existed; the rejection path falls back to looking up sourceId.
   */
  @Column({ type: 'text', nullable: true })
  sourceContent: string | null;

  @Column({ type: 'varchar', nullable: true })
  @Index()
  childId: string;

  @Column({ type: 'varchar', nullable: true })
  calendarColorId: string;

  @Column({ type: 'varchar', nullable: true, unique: true })
  googleEventId: string;

  @Column({ type: 'varchar', default: 'event' })
  syncType: SyncType;

  @Column({ type: 'varchar', nullable: true })
  googleTaskListId: string;

  @Column({ type: 'boolean', default: false })
  @Index()
  syncedToGoogle: boolean;

  @Column({ type: 'varchar', default: ApprovalStatus.NONE })
  @Index()
  approvalStatus: ApprovalStatus;

  @Column({ type: 'varchar', nullable: true })
  approvalMessageId: string;

  @Column({ type: 'boolean', default: false })
  @Index()
  reminderSent: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

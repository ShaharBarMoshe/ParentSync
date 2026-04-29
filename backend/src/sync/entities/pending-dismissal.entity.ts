import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export type DismissalAction = 'cancel' | 'delay';

@Entity('pending_dismissals')
export class PendingDismissalEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  action: DismissalAction;

  @Column({ type: 'varchar', nullable: true })
  targetEventId: string;

  @Column({ type: 'varchar', nullable: true })
  targetGoogleEventId: string;

  @Column({ type: 'varchar', nullable: true })
  targetGoogleTaskListId: string;

  @Column({ type: 'varchar', default: 'event' })
  targetSyncType: string;

  @Column({ type: 'varchar', nullable: true })
  calendarId: string;

  @Column({ type: 'varchar', nullable: true })
  newDate: string;

  @Column({ type: 'varchar', nullable: true })
  newTime: string;

  @Column({ type: 'varchar', nullable: true })
  approvalMessageId: string;

  @Column({ type: 'varchar', default: 'pending_approval' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;
}

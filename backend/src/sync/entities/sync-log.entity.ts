import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { SyncStatus } from '../../shared/enums/sync-status.enum';

export interface ChannelSyncDetail {
  childName: string;
  channelName: string;
  messagesFound: number;
  skipped: boolean;
  skipReason?: string;
  startedAt: string;
  endedAt: string;
  messages?: { sender: string; content: string; timestamp: string }[];
}

@Entity('sync_logs')
export class SyncLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn()
  timestamp: Date;

  @Column({ type: 'varchar', enum: SyncStatus })
  status: SyncStatus;

  @Column({ type: 'int', default: 0 })
  messageCount: number;

  @Column({ type: 'int', default: 0 })
  eventsCreated: number;

  @Column({ type: 'datetime', nullable: true })
  startedAt: Date;

  @Column({ type: 'datetime', nullable: true })
  endedAt: Date;

  @Column({ type: 'simple-json', nullable: true })
  channelDetails: ChannelSyncDetail[];
}

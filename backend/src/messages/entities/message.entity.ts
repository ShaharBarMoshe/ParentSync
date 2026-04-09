import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { MessageSource } from '../../shared/enums/message-source.enum';

@Entity('messages')
export class MessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', enum: MessageSource })
  @Index()
  source: MessageSource;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'datetime' })
  @Index()
  timestamp: Date;

  @Column({ type: 'varchar' })
  channel: string;

  @Column({ type: 'varchar', nullable: true })
  sender: string;

  @Column({ type: 'boolean', default: false })
  @Index()
  parsed: boolean;

  @Column({ type: 'varchar', nullable: true })
  @Index()
  childId: string;

  @CreateDateColumn()
  createdAt: Date;
}

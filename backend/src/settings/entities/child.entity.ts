import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('children')
export class ChildEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  channelNames: string;

  @Column({ type: 'text', nullable: true })
  teacherEmails: string;

  @Column({ type: 'varchar', nullable: true })
  calendarColor: string;

  @Column({ type: 'datetime', nullable: true })
  lastScanAt: Date;

  @Column({ type: 'integer', default: 0 })
  order: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

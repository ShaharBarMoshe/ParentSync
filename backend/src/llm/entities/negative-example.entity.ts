import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * A message the user explicitly told us was NOT an event (via 😢 reaction
 * on an extracted event). MessageParserService appends recent rows to the
 * system prompt so the LLM stops repeating the same mistake.
 *
 * `contentHash` is sha256(messageContent) and exists only to enforce
 * uniqueness — the same message can't produce two negatives.
 */
@Entity('negative_examples')
export class NegativeExampleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  contentHash: string;

  @Column({ type: 'text' })
  messageContent: string;

  @Column({ type: 'varchar' })
  extractedTitle: string;

  @Column({ type: 'varchar', nullable: true })
  extractedDate: string | null;

  @Column({ type: 'varchar', nullable: true })
  channel: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

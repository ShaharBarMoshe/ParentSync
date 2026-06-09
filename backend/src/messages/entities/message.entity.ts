import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { MessageSource } from '../../shared/enums/message-source.enum';

export interface MessageImage {
  mimeType: string;
  data: string; // base64-encoded
}

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

  // Inline images attached to the source message (WhatsApp media, Gmail
  // attachments). Stored as JSON so the parser can re-feed them to a
  // multimodal LLM without re-downloading. Null when the message is text-only.
  @Column({ type: 'simple-json', nullable: true })
  images: MessageImage[] | null;

  // Gemini text-embedding-004 vector of the merged-group content at parse
  // time. Used by MessageDeduplicationService to short-circuit forwards of
  // the same flyer across multiple WhatsApp groups. Null for historical
  // messages parsed before Phase 20 — they are excluded from similarity.
  @Column({ type: 'simple-json', nullable: true })
  embedding: number[] | null;

  // SHA-256 of the merged-group content. Set in the same write as `embedding`
  // and used for the byte-identical fast path that skips the embedding API.
  @Column({ type: 'varchar', nullable: true })
  @Index()
  contentHash: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

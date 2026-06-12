import { MessageEntity } from '../entities/message.entity';
import { MessageSource } from '../../shared/enums/message-source.enum';

/** Lean projection used by semantic-dedup similarity scans. */
export type ParsedMessageEmbeddingRow = Pick<
  MessageEntity,
  'id' | 'embedding' | 'contentHash'
>;

export interface IMessageRepository {
  findAll(): Promise<MessageEntity[]>;
  findById(id: string): Promise<MessageEntity | null>;
  findBySource(source: MessageSource): Promise<MessageEntity[]>;
  findUnparsed(): Promise<MessageEntity[]>;
  /**
   * Fetch parsed messages with embeddings in `[since, now]`, ordered newest
   * first. **Lean projection** — only `id`, `embedding`, `contentHash` are
   * selected. The `images` blob (up to 4 MB per row) is deliberately excluded
   * to keep similarity scans memory-bounded.
   */
  findParsedWithEmbeddings(
    since: Date,
    limit?: number,
  ): Promise<ParsedMessageEmbeddingRow[]>;
  getLastTimestamp(channel: string, childId: string): Promise<Date | null>;
  existsByChannelTimestampContent(channel: string, childId: string, timestamp: Date, content: string): Promise<boolean>;
  create(message: Partial<MessageEntity>): Promise<MessageEntity>;
  update(id: string, message: Partial<MessageEntity>): Promise<MessageEntity>;
  delete(id: string): Promise<void>;
  pruneOldest(maxCount: number): Promise<number>;
  resetAllParsed(): Promise<number>;
  /** NULL out `embedding` + `contentHash` for messages older than `beforeDate`. Returns affected row count. */
  clearStaleEmbeddings(beforeDate: Date): Promise<number>;
}

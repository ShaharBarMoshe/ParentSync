import { MessageEntity } from '../entities/message.entity';
import { MessageSource } from '../../shared/enums/message-source.enum';

export interface IMessageRepository {
  findAll(): Promise<MessageEntity[]>;
  findById(id: string): Promise<MessageEntity | null>;
  findBySource(source: MessageSource): Promise<MessageEntity[]>;
  findUnparsed(): Promise<MessageEntity[]>;
  getLastTimestamp(channel: string, childId: string): Promise<Date | null>;
  create(message: Partial<MessageEntity>): Promise<MessageEntity>;
  update(id: string, message: Partial<MessageEntity>): Promise<MessageEntity>;
  delete(id: string): Promise<void>;
  pruneOldest(maxCount: number): Promise<number>;
}

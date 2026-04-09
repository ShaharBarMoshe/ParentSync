import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageEntity } from '../entities/message.entity';
import { MessageSource } from '../../shared/enums/message-source.enum';
import { IMessageRepository } from '../interfaces/message-repository.interface';

@Injectable()
export class TypeOrmMessageRepository implements IMessageRepository {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly repo: Repository<MessageEntity>,
  ) {}

  findAll(): Promise<MessageEntity[]> {
    return this.repo.find({ order: { timestamp: 'DESC' } });
  }

  findById(id: string): Promise<MessageEntity | null> {
    return this.repo.findOneBy({ id });
  }

  findBySource(source: MessageSource): Promise<MessageEntity[]> {
    return this.repo.find({ where: { source }, order: { timestamp: 'DESC' } });
  }

  findUnparsed(): Promise<MessageEntity[]> {
    return this.repo.find({
      where: { parsed: false },
      order: { timestamp: 'ASC' },
    });
  }

  async getLastTimestamp(channel: string, childId: string): Promise<Date | null> {
    const result = await this.repo.findOne({
      where: { channel, childId },
      order: { timestamp: 'DESC' },
    });
    return result?.timestamp ?? null;
  }

  async create(message: Partial<MessageEntity>): Promise<MessageEntity> {
    const entity = this.repo.create(message);
    return this.repo.save(entity);
  }

  async update(
    id: string,
    message: Partial<MessageEntity>,
  ): Promise<MessageEntity> {
    await this.repo.update(id, message);
    return this.repo.findOneByOrFail({ id });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async pruneOldest(maxCount: number): Promise<number> {
    const total = await this.repo.count();
    if (total <= maxCount) return 0;

    const toKeep = await this.repo.find({
      order: { timestamp: 'DESC' },
      take: maxCount,
      select: ['id'],
    });
    const keepIds = toKeep.map((m) => m.id);

    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('id NOT IN (:...keepIds)', { keepIds })
      .execute();

    return result.affected ?? 0;
  }
}

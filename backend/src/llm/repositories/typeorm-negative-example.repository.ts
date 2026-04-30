import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { NegativeExampleEntity } from '../entities/negative-example.entity';
import {
  INegativeExampleRepository,
  CreateNegativeExampleInput,
} from '../interfaces/negative-example-repository.interface';

@Injectable()
export class TypeOrmNegativeExampleRepository
  implements INegativeExampleRepository
{
  constructor(
    @InjectRepository(NegativeExampleEntity)
    private readonly repo: Repository<NegativeExampleEntity>,
  ) {}

  async create(
    input: CreateNegativeExampleInput,
  ): Promise<NegativeExampleEntity> {
    const contentHash = crypto
      .createHash('sha256')
      .update(input.messageContent)
      .digest('hex');

    const existing = await this.repo.findOne({ where: { contentHash } });
    if (existing) return existing;

    const entity = this.repo.create({
      contentHash,
      messageContent: input.messageContent,
      extractedTitle: input.extractedTitle,
      extractedDate: input.extractedDate ?? null,
      channel: input.channel ?? null,
    });
    return this.repo.save(entity);
  }

  findRecent(limit: number): Promise<NegativeExampleEntity[]> {
    return this.repo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  findAll(): Promise<NegativeExampleEntity[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async deleteByMessageContent(messageContent: string): Promise<boolean> {
    const contentHash = crypto
      .createHash('sha256')
      .update(messageContent)
      .digest('hex');
    const result = await this.repo.delete({ contentHash });
    return (result.affected ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.repo.clear();
  }

  count(): Promise<number> {
    return this.repo.count();
  }
}

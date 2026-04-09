import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncLogEntity } from '../entities/sync-log.entity';
import { ISyncLogRepository } from '../interfaces/sync-log-repository.interface';

@Injectable()
export class TypeOrmSyncLogRepository implements ISyncLogRepository {
  constructor(
    @InjectRepository(SyncLogEntity)
    private readonly repository: Repository<SyncLogEntity>,
  ) {}

  async findAll(): Promise<SyncLogEntity[]> {
    return this.repository.find({ order: { timestamp: 'DESC' } });
  }

  async findRecent(limit: number): Promise<SyncLogEntity[]> {
    return this.repository.find({
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  async create(log: Partial<SyncLogEntity>): Promise<SyncLogEntity> {
    const entity = this.repository.create(log);
    return this.repository.save(entity);
  }
}

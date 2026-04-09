import { SyncLogEntity } from '../entities/sync-log.entity';

export interface ISyncLogRepository {
  findAll(): Promise<SyncLogEntity[]>;
  findRecent(limit: number): Promise<SyncLogEntity[]>;
  create(log: Partial<SyncLogEntity>): Promise<SyncLogEntity>;
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PendingDismissalEntity } from '../entities/pending-dismissal.entity';
import { IDismissalRepository } from '../interfaces/dismissal-repository.interface';
import { isUsableApprovalMessageId } from '../../shared/utils/approval-message-id';

@Injectable()
export class TypeOrmDismissalRepository implements IDismissalRepository {
  constructor(
    @InjectRepository(PendingDismissalEntity)
    private readonly repo: Repository<PendingDismissalEntity>,
  ) {}

  async create(
    data: Partial<PendingDismissalEntity>,
  ): Promise<PendingDismissalEntity> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  findByApprovalMessageId(
    messageId: string,
  ): Promise<PendingDismissalEntity | null> {
    // See TypeOrmEventRepository.findByApprovalMessageId — an unusable id must
    // never match the legacy rows that stored it verbatim.
    if (!isUsableApprovalMessageId(messageId)) {
      return Promise.resolve(null);
    }
    return this.repo.findOneBy({ approvalMessageId: messageId });
  }

  async update(
    id: string,
    data: Partial<PendingDismissalEntity>,
  ): Promise<PendingDismissalEntity> {
    await this.repo.update(id, data);
    return this.repo.findOneByOrFail({ id });
  }
}

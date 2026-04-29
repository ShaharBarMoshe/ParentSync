import { PendingDismissalEntity } from '../entities/pending-dismissal.entity';

export interface IDismissalRepository {
  create(
    data: Partial<PendingDismissalEntity>,
  ): Promise<PendingDismissalEntity>;
  findByApprovalMessageId(
    messageId: string,
  ): Promise<PendingDismissalEntity | null>;
  update(
    id: string,
    data: Partial<PendingDismissalEntity>,
  ): Promise<PendingDismissalEntity>;
}

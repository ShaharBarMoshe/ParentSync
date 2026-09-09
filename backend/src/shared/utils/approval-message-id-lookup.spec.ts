import { Repository } from 'typeorm';
import { TypeOrmEventRepository } from '../../calendar/repositories/typeorm-event.repository';
import { TypeOrmDismissalRepository } from '../../sync/repositories/typeorm-dismissal.repository';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { PendingDismissalEntity } from '../../sync/entities/pending-dismissal.entity';
import { UNUSABLE_APPROVAL_MESSAGE_ID } from './approval-message-id';

/**
 * Driver-free counterpart to the in-memory repository specs: asserts the guard
 * short-circuits before TypeORM is ever asked, so no query can match one of the
 * legacy rows that stored "[object Object]" in approvalMessageId.
 */
describe('findByApprovalMessageId guard', () => {
  const VALID =
    'true_120363407443598263@g.us_3EB0A87880D02F4D93C750_255524885028964@lid';
  const unusable = [UNUSABLE_APPROVAL_MESSAGE_ID, '', '   '];

  function eventRepo() {
    const findOneBy = jest.fn().mockResolvedValue(null);
    const repo = new TypeOrmEventRepository({
      findOneBy,
    } as unknown as Repository<CalendarEventEntity>);
    return { repo, findOneBy };
  }

  function dismissalRepo() {
    const findOneBy = jest.fn().mockResolvedValue(null);
    const repo = new TypeOrmDismissalRepository({
      findOneBy,
    } as unknown as Repository<PendingDismissalEntity>);
    return { repo, findOneBy };
  }

  it.each(unusable)('event repository skips the query for %p', async (bad) => {
    const { repo, findOneBy } = eventRepo();
    await expect(repo.findByApprovalMessageId(bad)).resolves.toBeNull();
    expect(findOneBy).not.toHaveBeenCalled();
  });

  it.each(unusable)('dismissal repository skips the query for %p', async (bad) => {
    const { repo, findOneBy } = dismissalRepo();
    await expect(repo.findByApprovalMessageId(bad)).resolves.toBeNull();
    expect(findOneBy).not.toHaveBeenCalled();
  });

  it('still queries for a real WhatsApp message key', async () => {
    const { repo, findOneBy } = eventRepo();
    await repo.findByApprovalMessageId(VALID);
    expect(findOneBy).toHaveBeenCalledWith({ approvalMessageId: VALID });

    const dismissal = dismissalRepo();
    await dismissal.repo.findByApprovalMessageId(VALID);
    expect(dismissal.findOneBy).toHaveBeenCalledWith({
      approvalMessageId: VALID,
    });
  });
});

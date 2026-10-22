import { Injectable, Logger } from '@nestjs/common';
import { ApprovalService } from '../../services/approval.service';
import type { EventSyncState, EventSyncUpdate } from '../event-sync.state';

/**
 * Send an approval card for every event that survived screening.
 *
 * Deliberately *not* a LangGraph `interrupt()`, tempting as that is — this is
 * textbook human-in-the-loop. Resuming from an interrupt needs a durable
 * checkpointer and a graph thread held open for as long as a parent takes to
 * answer a WhatsApp message, which is hours or never. Worse, LangGraph re-runs
 * a resumed node from the top, and by then this node has already written to
 * SQLite — a resume would send every card twice.
 *
 * The `PENDING` row in SQLite *is* the durable interrupt, and unlike an
 * in-memory thread it survives an app restart.
 */
@Injectable()
export class RequestApprovalNode {
  private readonly logger = new Logger(RequestApprovalNode.name);

  constructor(private readonly approvalService: ApprovalService) {}

  async run(state: EventSyncState): Promise<EventSyncUpdate> {
    for (const event of state.approvalCandidates) {
      try {
        await this.approvalService.sendForApproval(event);
      } catch (error) {
        // The row stays PENDING, so the next pass can offer it again. Failing
        // the whole sync over one undelivered card would be worse.
        this.logger.error(
          `Failed to send approval for "${event.title}": ${(error as Error).message}`,
        );
      }
    }
    return {};
  }
}

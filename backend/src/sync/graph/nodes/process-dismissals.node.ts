import { Injectable, Logger } from '@nestjs/common';
import { EventDismissalService } from '../../services/event-dismissal.service';
import type { EventSyncState, EventSyncUpdate } from '../event-sync.state';

/**
 * Apply the cancel/delay instructions this pass extracted.
 *
 * Runs after approval so a "trip is cancelled" message can act on an event
 * created earlier in the same pass — the original code processed dismissals
 * per group, which meant a cancellation could arrive before the event it
 * cancels had been written.
 *
 * One failed dismissal is logged and skipped, never rethrown: the rest of the
 * pass is still worth completing.
 */
@Injectable()
export class ProcessDismissalsNode {
  private readonly logger = new Logger(ProcessDismissalsNode.name);

  constructor(private readonly eventDismissalService: EventDismissalService) {}

  async run(state: EventSyncState): Promise<EventSyncUpdate> {
    for (const { event, childId, childName, messageId } of state.dismissals) {
      try {
        await this.eventDismissalService.processDismissal(
          event,
          childId,
          childName,
          messageId,
        );
      } catch (error) {
        this.logger.error(
          `Failed to process dismissal "${event.title}": ${(error as Error).message}`,
        );
      }
    }
    return {};
  }
}

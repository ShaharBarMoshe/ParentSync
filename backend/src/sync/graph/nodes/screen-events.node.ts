import { Injectable, Logger, Inject } from '@nestjs/common';
import { EVENT_REPOSITORY } from '../../../shared/constants/injection-tokens';
import type { IEventRepository } from '../../../calendar/interfaces/event-repository.interface';
import { CalendarEventEntity } from '../../../calendar/entities/calendar-event.entity';
import { MessageParserService } from '../../../llm/services/message-parser.service';
import {
  CalendarConflictDedupService,
  type CalendarConflictMatch,
} from '../../services/calendar-conflict-dedup.service';
import { ApprovalStatus } from '../../../shared/enums/approval-status.enum';
import { SyncSettings, isDateInPast } from '../sync-settings.service';
import type { EventSyncState, EventSyncUpdate } from '../event-sync.state';

/**
 * Decide which freshly persisted events actually deserve to interrupt the user.
 *
 * Three filters, cheapest first:
 *
 * 1. **Already past** — auto-approve silently; asking about last Tuesday is
 *    pure noise.
 * 2. **Duplicate of a sibling** (layer 3) — another event for the same child
 *    on the same day that the model judges to be the same gathering. Reject
 *    the newcomer; the existing row is the canonical record.
 * 3. **Already on Google Calendar** (layer 4) — a semantically matching entry
 *    within ±60 minutes, typically added by hand or from another source. Bind
 *    to it rather than creating a second one.
 *
 * Every filter fails *open*: an error leaves the event in the approval queue.
 * The user dismissing a duplicate card is a mild annoyance; an event silently
 * suppressed by a transient failure is a missed school trip.
 */
@Injectable()
export class ScreenEventsNode {
  private readonly logger = new Logger(ScreenEventsNode.name);

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    private readonly messageParserService: MessageParserService,
    private readonly calendarConflictDedup: CalendarConflictDedupService,
    private readonly syncSettings: SyncSettings,
  ) {}

  async run(state: EventSyncState): Promise<EventSyncUpdate> {
    const calendarId = await this.syncSettings.calendarId();
    const now = new Date();
    const approvalCandidates: CalendarEventEntity[] = [];

    for (const event of state.savedEvents) {
      try {
        if (isDateInPast(event.date, event.time, now)) {
          this.logger.log(
            `Skipping approval for past event "${event.title}" ` +
              `(${event.date}${event.time ? ' ' + event.time : ''}) — auto-approving`,
          );
          await this.eventRepository.update(event.id, {
            approvalStatus: ApprovalStatus.NONE,
          });
          continue;
        }

        if (await this.duplicatesASibling(event)) {
          this.logger.log(
            `Suppressing approval for duplicate event "${event.title}" — ` +
              `matches an existing event at ${event.date}${event.time ? ' ' + event.time : ''}`,
          );
          await this.eventRepository.update(event.id, {
            approvalStatus: ApprovalStatus.REJECTED,
          });
          continue;
        }

        const conflict = await this.findCalendarConflict(event, calendarId);
        if (conflict) {
          this.logger.log(
            `Calendar dedup fired: "${event.title}" matches existing ` +
              `"${conflict.summary}" (similarity=${conflict.similarity.toFixed(3)})`,
          );
          await this.eventRepository.update(event.id, {
            approvalStatus: ApprovalStatus.REJECTED,
            googleEventId: conflict.googleEventId,
            syncedToGoogle: true,
          });
          await this.syncSettings.incrementMetric('metric.calendar_dedup_fires');
          continue;
        }

        approvalCandidates.push(event);
      } catch (error) {
        // Fail open — see the class comment. One event's screening failure
        // must not cost the whole pass.
        this.logger.warn(
          `Screening threw for "${event.title}" (queuing it for approval anyway): ` +
            `${(error as Error).message}`,
        );
        approvalCandidates.push(event);
      }
    }

    return { approvalCandidates };
  }

  /**
   * Whether a sibling event for the same child describes the same gathering.
   *
   * Checks both the exact time slot and the whole day: related messages often
   * yield different times for one event (16:45 in one, 18:00 in another), and
   * only the day-wide sweep catches that.
   */
  private async duplicatesASibling(
    candidate: CalendarEventEntity,
  ): Promise<boolean> {
    const [slotSiblings, daySiblings] = await Promise.all([
      this.eventRepository.findSameSlotForChild(
        candidate.date,
        candidate.time,
        candidate.childId,
        candidate.id,
      ),
      this.eventRepository.findSameDayForChild(
        candidate.date,
        candidate.childId,
        candidate.id,
      ),
    ]);

    const seen = new Set<string>();
    const siblings = [...slotSiblings, ...daySiblings].filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    if (siblings.length === 0) return false;

    for (const sibling of siblings) {
      const same = await this.messageParserService.eventsAreIdentical(
        {
          title: candidate.title,
          date: candidate.date,
          time: candidate.time,
          location: candidate.location,
          description: candidate.description,
        },
        {
          title: sibling.title,
          date: sibling.date,
          time: sibling.time,
          location: sibling.location,
          description: sibling.description,
        },
      );
      if (same) {
        this.logger.debug(
          `LLM event dedup fired candidateTitle="${candidate.title}" ` +
            `siblingTitle="${sibling.title}" date=${candidate.date} time=${candidate.time}`,
        );
        await this.syncSettings.incrementMetric('metric.event_dedup_llm_fires');
        return true;
      }
    }
    return false;
  }

  private async findCalendarConflict(
    event: CalendarEventEntity,
    calendarId: string,
  ): Promise<CalendarConflictMatch | null> {
    try {
      return await this.calendarConflictDedup.findConflict(event, calendarId);
    } catch (error) {
      this.logger.warn(
        `Calendar conflict check threw (proceeding with approval): ${(error as Error).message}`,
      );
      return null;
    }
  }
}

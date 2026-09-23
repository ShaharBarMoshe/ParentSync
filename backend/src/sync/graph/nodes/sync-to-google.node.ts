import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
} from '../../../shared/constants/injection-tokens';
import type { IEventRepository } from '../../../calendar/interfaces/event-repository.interface';
import type { IGoogleCalendarService } from '../../../calendar/interfaces/google-calendar-service.interface';
import type { IGoogleTasksService } from '../../../calendar/interfaces/google-tasks-service.interface';
import { GoogleTasksScopeError } from '../../../calendar/services/google-tasks.service';
import { CalendarEventEntity } from '../../../calendar/entities/calendar-event.entity';
import { AppErrorEmitterService } from '../../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../../shared/errors/app-error-codes';
import { SyncSettings } from '../sync-settings.service';
import type { EventSyncUpdate } from '../event-sync.state';

/**
 * Push everything still unsynced to Google Calendar or Google Tasks.
 *
 * Runs on every path through the graph, including the short-circuits: events
 * approved in an earlier pass, or left behind by a failed push, are still
 * waiting whether or not this pass found new messages.
 *
 * A failure never marks the event synced, so the next pass retries it.
 */
@Injectable()
export class SyncToGoogleNode {
  private readonly logger = new Logger(SyncToGoogleNode.name);

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    @Inject(GOOGLE_TASKS_SERVICE)
    private readonly googleTasksService: IGoogleTasksService,
    private readonly eventEmitter: EventEmitter2,
    private readonly appErrorEmitter: AppErrorEmitterService,
    private readonly syncSettings: SyncSettings,
  ) {}

  async run(): Promise<EventSyncUpdate> {
    const calendarId = await this.syncSettings.calendarId();
    const unsynced = await this.eventRepository.findUnsynced();
    this.logger.log(`Found ${unsynced.length} unsynced events`);

    let eventsSynced = 0;
    for (const event of unsynced) {
      try {
        if (event.syncType === 'task') {
          await this.syncAsTask(event, calendarId);
        } else {
          await this.syncAsCalendarEvent(event, calendarId);
        }
        eventsSynced++;
        this.eventEmitter.emit('event.synced', {
          eventId: event.id,
          googleEventId: event.googleEventId,
        });
      } catch (error) {
        const message = (error as Error).message;
        this.logger.error(`Failed to sync event ${event.id} to Google: ${message}`);
        // OAuth failures already emit OAUTH_REFRESH_FAILED from OAuthService;
        // don't double-notify. Surface other Google API failures separately.
        if (!/re-authenticate with Google/i.test(message)) {
          this.appErrorEmitter.emit({
            source: 'calendar',
            code: AppErrorCodes.EVENT_SYNC_GOOGLE_FAILED,
            message: `Failed to push events to Google Calendar. ${message}`,
          });
        }
        // Left unsynced deliberately — the next pass retries it.
      }
    }

    return { counters: { eventsSynced } };
  }

  async syncAsCalendarEvent(
    event: CalendarEventEntity,
    calendarId: string,
  ): Promise<void> {
    const googleEventId = await this.googleCalendarService.createEvent(
      event,
      calendarId,
      event.calendarColorId || undefined,
    );
    await this.eventRepository.update(event.id, {
      googleEventId,
      syncedToGoogle: true,
    });
  }

  /**
   * Date-only events become Google Tasks, which is where an undated "bring a
   * costume" reminder actually belongs.
   *
   * Without the Tasks OAuth scope this falls back to an all-day calendar
   * event, so a missing scope degrades the event rather than losing it.
   */
  async syncAsTask(
    event: CalendarEventEntity,
    calendarId: string,
  ): Promise<void> {
    try {
      const childName = SyncToGoogleNode.extractChildName(event);
      const taskListId = childName
        ? await this.googleTasksService.findOrCreateChildTaskList(childName)
        : '@default';

      const googleTaskId = await this.googleTasksService.createTask(
        event.title,
        event.description || undefined,
        event.date,
        taskListId,
      );

      await this.eventRepository.update(event.id, {
        googleEventId: googleTaskId,
        googleTaskListId: taskListId,
        syncedToGoogle: true,
      });
    } catch (error) {
      if (error instanceof GoogleTasksScopeError) {
        this.logger.warn(
          `Tasks scope not granted for event ${event.id}, falling back to all-day calendar event`,
        );
        await this.eventRepository.update(event.id, { syncType: 'event' });
        await this.syncAsCalendarEvent(event, calendarId);
        return;
      }
      throw error;
    }
  }

  /** Titles are "ChildName: actual title" when a child is set. */
  private static extractChildName(event: CalendarEventEntity): string | null {
    if (event.childId && event.title.includes(': ')) {
      return event.title.split(': ')[0];
    }
    return null;
  }
}

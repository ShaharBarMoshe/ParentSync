import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IEventRepository } from '../../calendar/interfaces/event-repository.interface';
import type { IGoogleCalendarService } from '../../calendar/interfaces/google-calendar-service.interface';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { EventSyncGraph } from '../graph/event-sync.graph';
import { SyncToGoogleNode } from '../graph/nodes/sync-to-google.node';
import { SyncSettings } from '../graph/sync-settings.service';

/** Outcome of one event-sync pass. */
export interface EventSyncResult {
  /** Messages whose group completed successfully (includes dedup skips). */
  messagesParsed: number;
  /** Messages whose group threw and was marked parsed to avoid a retry loop. */
  messagesFailed: number;
  eventsCreated: number;
  eventsSynced: number;
}

/**
 * The entry point to event sync.
 *
 * The pipeline itself lives in `EventSyncGraph` and its nodes; what is left
 * here is what a graph is a bad shape for: the in-flight guard, and the two
 * single-event operations the approval flow calls directly.
 */
@Injectable()
export class EventSyncService {
  private readonly logger = new Logger(EventSyncService.name);

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    private readonly graph: EventSyncGraph,
    private readonly syncToGoogleNode: SyncToGoogleNode,
    private readonly syncSettings: SyncSettings,
  ) {}

  /**
   * In-flight pass, so two callers can never parse the same messages at once.
   *
   * `syncAll()` emits `sync.completed`, whose @OnEvent handler runs
   * `syncEvents()` without being awaited, and the Dashboard then calls
   * `POST /api/sync/events` right after `POST /api/sync/manual`. That started a
   * second pass ~90ms behind the first; both had already called
   * `findUnparsed()` before either marked anything parsed, so both parsed the
   * same messages and both created events — near-identical duplicates from one
   * source message. The scheduled sync overlapping a manual one does the same.
   *
   * Callers join the running pass instead of starting a rival one, which also
   * gives the Dashboard the behaviour it wanted: wait for events to be built.
   */
  private inFlightPass: Promise<EventSyncResult> | null = null;

  async syncEvents(): Promise<EventSyncResult> {
    if (this.inFlightPass) {
      this.logger.log(
        'Event sync already running — joining the in-flight pass instead of starting a second one',
      );
      return this.inFlightPass;
    }

    const pass = this.runEventSync();
    this.inFlightPass = pass;
    try {
      return await pass;
    } finally {
      this.inFlightPass = null;
    }
  }

  private async runEventSync(): Promise<EventSyncResult> {
    this.logger.log('Starting event sync...');

    const { quotaExhausted, ...counters } = await this.graph.run();

    const failedNote =
      counters.messagesFailed > 0 ? `, ${counters.messagesFailed} failed` : '';
    const skippedNote = quotaExhausted
      ? ' — parse pass aborted (LLM quota exhausted), messages left for the next sync'
      : '';
    this.logger.log(
      `Event sync completed: ${counters.messagesParsed} messages parsed${failedNote}, ` +
        `${counters.eventsCreated} events created, ${counters.eventsSynced} events synced${skippedNote}`,
    );

    return counters;
  }

  @OnEvent('sync.completed')
  async handleSyncCompleted(): Promise<void> {
    try {
      await this.syncEvents();
    } catch (error) {
      this.logger.error(
        `Event sync after message sync failed: ${(error as Error).message}`,
      );
    }
  }

  /** Push one approved event, outside a full pass. Used by the approval flow. */
  async syncSingleEventToGoogle(event: CalendarEventEntity): Promise<void> {
    const calendarId = await this.syncSettings.calendarId();
    if (event.syncType === 'task') {
      await this.syncToGoogleNode.syncAsTask(event, calendarId);
    } else {
      await this.syncToGoogleNode.syncAsCalendarEvent(event, calendarId);
    }
  }

  /**
   * Inverse of `syncSingleEventToGoogle`: remove the event from Google
   * Calendar (if it was ever pushed) and clear the local sync flags. Called
   * when a 👍 approval reaction is removed — see `ApprovalService.unapproveEvent`.
   *
   * Best-effort: if the Google delete fails (an expired token, say) the local
   * flags are cleared anyway so the event can be re-approved cleanly later.
   */
  async unsyncEventFromGoogle(event: CalendarEventEntity): Promise<void> {
    if (event.googleEventId && event.syncType !== 'task') {
      try {
        await this.googleCalendarService.deleteEvent(
          event.googleEventId,
          await this.syncSettings.calendarId(),
        );
      } catch (error) {
        this.logger.warn(
          `Failed to delete event ${event.id} from Google Calendar (continuing anyway): ${(error as Error).message}`,
        );
      }
    }
    await this.eventRepository.update(event.id, {
      syncedToGoogle: false,
      // Cast to never: the entity declares googleEventId as string but the
      // column is nullable; we want to clear it on un-approve.
      googleEventId: null as unknown as string,
    });
  }
}

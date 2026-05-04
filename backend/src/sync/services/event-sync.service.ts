import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import {
  MESSAGE_REPOSITORY,
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import type { IEventRepository } from '../../calendar/interfaces/event-repository.interface';
import type { IGoogleCalendarService } from '../../calendar/interfaces/google-calendar-service.interface';
import type { IGoogleTasksService } from '../../calendar/interfaces/google-tasks-service.interface';
import { GoogleTasksScopeError } from '../../calendar/services/google-tasks.service';
import { MessageParserService } from '../../llm/services/message-parser.service';
import type { ParsedEvent } from '../../llm/dto/parsed-event.dto';
import { SettingsService } from '../../settings/settings.service';
import { ChildService } from '../../settings/child.service';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { MessageEntity } from '../../messages/entities/message.entity';
import { ApprovalService } from './approval.service';
import { EventDismissalService } from './event-dismissal.service';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

@Injectable()
export class EventSyncService {
  private readonly logger = new Logger(EventSyncService.name);

  constructor(
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    @Inject(GOOGLE_TASKS_SERVICE)
    private readonly googleTasksService: IGoogleTasksService,
    private readonly messageParserService: MessageParserService,
    private readonly settingsService: SettingsService,
    private readonly childService: ChildService,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => ApprovalService))
    private readonly approvalService: ApprovalService,
    private readonly eventDismissalService: EventDismissalService,
    private readonly appErrorEmitter: AppErrorEmitterService,
  ) {}

  async syncSingleEventToGoogle(event: CalendarEventEntity): Promise<void> {
    const calendarId = await this.getCalendarId();
    if (event.syncType === 'task') {
      await this.syncAsTask(event, calendarId);
    } else {
      await this.syncAsCalendarEvent(event, calendarId);
    }
  }

  /**
   * Inverse of `syncSingleEventToGoogle`: remove the event from the user's
   * Google Calendar (if it was ever pushed) and clear the local sync flags.
   * Called when a 👍 approval reaction is removed from WhatsApp — see
   * ApprovalService.unapproveEvent().
   *
   * Best-effort: if the Google delete fails (e.g. token expired) we still
   * clear the local flags so the event can be re-approved cleanly later.
   */
  async unsyncEventFromGoogle(event: CalendarEventEntity): Promise<void> {
    if (event.googleEventId && event.syncType !== 'task') {
      try {
        const calendarId = await this.getCalendarId();
        await this.googleCalendarService.deleteEvent(
          event.googleEventId,
          calendarId,
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

  @OnEvent('sync.completed')
  async handleSyncCompleted(): Promise<void> {
    try {
      await this.syncEvents();
    } catch (error) {
      this.logger.error(
        `Event sync after message sync failed: ${error.message}`,
      );
    }
  }

  async syncEvents(): Promise<{
    messagesParsed: number;
    eventsCreated: number;
    eventsSynced: number;
  }> {
    this.logger.log('Starting event sync...');

    let messagesParsed = 0;
    let eventsCreated = 0;
    let eventsSynced = 0;

    // Step 1: Parse unparsed messages using transactions
    const unparsedMessages = await this.messageRepository.findUnparsed();
    this.logger.log(`Found ${unparsedMessages.length} unparsed messages`);

    // Group nearby messages from the same channel to reduce LLM calls
    const messageGroups = this.groupMessagesByProximity(unparsedMessages);
    this.logger.log(
      `Grouped ${unparsedMessages.length} messages into ${messageGroups.length} groups`,
    );

    // Prepare batch: merge each group's content and look up child info
    const groupMeta: {
      group: MessageEntity[];
      childName?: string;
      childId?: string;
      calendarColorId?: string;
      mergedContent: string;
      messageDate: string;
    }[] = [];

    for (const group of messageGroups) {
      const firstMessage = group[0];
      let childName: string | undefined;
      let calendarColorId: string | undefined;

      if (firstMessage.childId) {
        try {
          const child = await this.childService.findById(firstMessage.childId);
          childName = child.name;
          calendarColorId = child.calendarColor || undefined;
        } catch {
          this.logger.warn(
            `Child with id "${firstMessage.childId}" not found for message ${firstMessage.id}`,
          );
        }
      }

      // Use the latest message timestamp as date context for the LLM
      // so relative dates ("tomorrow", "next week") resolve correctly
      const latestTimestamp = group.reduce((latest, msg) => {
        const msgTime = new Date(msg.timestamp).getTime();
        return msgTime > latest ? msgTime : latest;
      }, 0);
      const messageDate = new Date(latestTimestamp).toISOString().split('T')[0];

      groupMeta.push({
        group,
        childName,
        childId: firstMessage.childId,
        calendarColorId,
        mergedContent: this.mergeGroupContent(group),
        messageDate,
      });
    }

    // Batch parse all groups in a single LLM call
    // Each group's content includes its own date context (based on message timestamps)
    // so relative dates like "tomorrow" resolve relative to when the message was sent
    const batchInput = groupMeta.map((meta, i) => ({
      id: String(i),
      content: meta.mergedContent,
    }));
    const fallbackDate = new Date().toISOString().split('T')[0];
    const batchResult = await this.messageParserService.parseMessageBatch(
      batchInput,
      fallbackDate,
      groupMeta.map((meta) => meta.messageDate),
    );

    const approvalEnabled = await this.approvalService.isApprovalEnabled();

    // Process each group's parsed events
    for (let i = 0; i < groupMeta.length; i++) {
      const meta = groupMeta[i];
      const parsedEvents = batchResult.get(String(i)) || [];

      // Split into creation events and dismissal events
      const createEvents = parsedEvents.filter(
        (e) => !e.action || e.action === 'create',
      );
      const dismissalEvents = parsedEvents.filter(
        (e) => e.action === 'cancel' || e.action === 'delay',
      );

      try {
        // Process creation events (also marks messages as parsed in the transaction)
        const result = await this.createEventsInTransaction(
          meta.group,
          createEvents,
          meta.childName,
          meta.childId,
          meta.calendarColorId,
          approvalEnabled,
          meta.mergedContent,
        );
        eventsCreated += result.eventsCreated;

        // Send newly created events for approval if enabled (skip past events)
        if (approvalEnabled) {
          const now = new Date();
          for (const savedEvent of result.savedEvents) {
            if (this.isEventInPast(savedEvent, now)) {
              this.logger.log(
                `Skipping approval for past event "${savedEvent.title}" (${savedEvent.date}${savedEvent.time ? ' ' + savedEvent.time : ''}) — auto-approving`,
              );
              await this.eventRepository.update(savedEvent.id, {
                approvalStatus: ApprovalStatus.NONE,
              });
              continue;
            }

            // Duplicate-detection: if there's already a non-rejected event
            // for the same child at the same date+time, ask the LLM whether
            // the two refer to the same gathering. If yes, suppress the
            // approval message and mark this one rejected so it doesn't
            // resurface — the existing event is the canonical record.
            const isDup = await this.detectDuplicateOfExisting(savedEvent);
            if (isDup) {
              this.logger.log(
                `Suppressing approval for duplicate event "${savedEvent.title}" — matches an existing event at ${savedEvent.date}${savedEvent.time ? ' ' + savedEvent.time : ''}`,
              );
              await this.eventRepository.update(savedEvent.id, {
                approvalStatus: ApprovalStatus.REJECTED,
              });
              continue;
            }

            await this.approvalService.sendForApproval(savedEvent);
          }
        }

        // Process dismissal events
        for (const dismissal of dismissalEvents) {
          try {
            await this.eventDismissalService.processDismissal(
              dismissal,
              meta.childId,
              meta.childName,
              meta.group[0].id,
            );
          } catch (error) {
            this.logger.error(
              `Failed to process dismissal "${dismissal.title}": ${error.message}`,
            );
          }
        }

        messagesParsed += meta.group.length;
      } catch (error) {
        this.logger.error(
          `Failed to process message group (${meta.group.length} messages): ${error.message}`,
        );
        // Mark all as parsed to avoid infinite retry
        for (const msg of meta.group) {
          await this.messageRepository.update(msg.id, { parsed: true });
        }
      }
    }

    // Step 2: Sync unsynced events to Google Calendar / Google Tasks
    const calendarId = await this.getCalendarId();
    const unsyncedEvents = await this.eventRepository.findUnsynced();
    this.logger.log(`Found ${unsyncedEvents.length} unsynced events`);

    for (const event of unsyncedEvents) {
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
        this.logger.error(
          `Failed to sync event ${event.id} to Google: ${error.message}`,
        );
        const isOAuthFailure = /re-authenticate with Google/i.test(error.message);
        if (!isOAuthFailure) {
          // OAuth failures already emit OAUTH_REFRESH_FAILED from OAuthService;
          // don't double-notify. Surface other Google API failures separately.
          this.appErrorEmitter.emit({
            source: 'calendar',
            code: AppErrorCodes.EVENT_SYNC_GOOGLE_FAILED,
            message: `Failed to push events to Google Calendar. ${error.message}`,
          });
        }
        // Don't mark as synced - will retry on next run
      }
    }

    this.logger.log(
      `Event sync completed: ${messagesParsed} messages parsed, ${eventsCreated} events created, ${eventsSynced} events synced`,
    );

    return { messagesParsed, eventsCreated, eventsSynced };
  }

  private static readonly MERGE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

  /**
   * Groups messages from the same channel that are within 10 minutes of each
   * other into a single group. Each group will be sent as one merged message
   * to the LLM.
   */
  private groupMessagesByProximity(
    messages: MessageEntity[],
  ): MessageEntity[][] {
    // Group by channel first
    const byChannel = new Map<string, MessageEntity[]>();
    for (const msg of messages) {
      const key = msg.channel;
      if (!byChannel.has(key)) byChannel.set(key, []);
      byChannel.get(key)!.push(msg);
    }

    const groups: MessageEntity[][] = [];

    for (const channelMessages of byChannel.values()) {
      // Sort by timestamp ascending
      channelMessages.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      let currentGroup: MessageEntity[] = [channelMessages[0]];

      for (let i = 1; i < channelMessages.length; i++) {
        const prev = new Date(channelMessages[i - 1].timestamp).getTime();
        const curr = new Date(channelMessages[i].timestamp).getTime();

        if (curr - prev <= EventSyncService.MERGE_WINDOW_MS) {
          currentGroup.push(channelMessages[i]);
        } else {
          groups.push(currentGroup);
          currentGroup = [channelMessages[i]];
        }
      }
      groups.push(currentGroup);
    }

    return groups;
  }

  /**
   * Merges a group of messages into a single content string with clear
   * separation between messages (timestamp + sender prefix per message).
   */
  private mergeGroupContent(group: MessageEntity[]): string {
    if (group.length === 1) return group[0].content;

    return group
      .map((msg) => {
        const ts = new Date(msg.timestamp);
        const time = ts.toLocaleTimeString('he-IL', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const date = ts.toLocaleDateString('he-IL');
        const sender = msg.sender || 'unknown';
        return `[${time}, ${date}] ${sender}: ${msg.content}`;
      })
      .join('\n');
  }

  private async createEventsInTransaction(
    group: MessageEntity[],
    parsedEvents: ParsedEvent[],
    childName?: string,
    childId?: string,
    calendarColorId?: string,
    approvalEnabled = false,
    mergedContent?: string,
  ): Promise<{ eventsCreated: number; savedEvents: CalendarEventEntity[] }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let eventsCreated = 0;
    const savedEvents: CalendarEventEntity[] = [];

    try {
      for (const msg of group) {
        this.eventEmitter.emit('message.parsed', {
          messageId: msg.id,
          eventsFound: parsedEvents.length,
        });
      }

      const firstMessage = group[0];

      const now = new Date();

      for (const parsed of parsedEvents) {
        // Skip events with dates in the past
        if (parsed.date && this.isDateInPast(parsed.date, parsed.time, now)) {
          this.logger.log(
            `Skipping past event "${parsed.title}" (${parsed.date}${parsed.time ? ' ' + parsed.time : ''})`,
          );
          continue;
        }

        const title = childName
          ? `${childName}: ${parsed.title}`
          : parsed.title;

        // Check for duplicate event (same title, date, time, child)
        const existing = await this.eventRepository.findByTitleDateTimeChild(
          title,
          parsed.date,
          parsed.time,
          childId,
        );
        if (existing) {
          this.logger.debug(
            `Skipping duplicate event "${title}" on ${parsed.date}${parsed.time ? ` at ${parsed.time}` : ''}`,
          );
          continue;
        }

        const eventData: Partial<CalendarEventEntity> = {
          title,
          description: parsed.description,
          date: parsed.date,
          time: parsed.time,
          location: parsed.location,
          source: firstMessage.source,
          sourceId: firstMessage.id,
          // Snapshot what the LLM actually saw — the merged group text —
          // so a 😢 rejection captures the right negative example, even
          // when the event came from a later message in the proximity group.
          sourceContent: mergedContent ?? null,
          childId: childId || undefined,
          calendarColorId: calendarColorId || undefined,
          syncType: parsed.time ? 'event' : 'task',
          syncedToGoogle: false,
          approvalStatus: approvalEnabled
            ? ApprovalStatus.PENDING
            : ApprovalStatus.NONE,
        };
        const calendarEvent = queryRunner.manager.create(
          CalendarEventEntity,
          eventData,
        );

        const saved = await queryRunner.manager.save(calendarEvent);
        eventsCreated++;
        savedEvents.push(saved);

        this.eventEmitter.emit('event.created', {
          eventId: saved.id,
          messageId: firstMessage.id,
        });
      }

      // Mark all messages in the group as parsed
      for (const msg of group) {
        await queryRunner.manager.update(MessageEntity, msg.id, {
          parsed: true,
        });
      }

      await queryRunner.commitTransaction();

      return { eventsCreated, savedEvents };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async syncAsCalendarEvent(
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

  private async syncAsTask(
    event: CalendarEventEntity,
    calendarId: string,
  ): Promise<void> {
    try {
      // Determine the child name from the event title (format: "ChildName: title")
      const childName = this.extractChildName(event);
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
        // Fallback: create as all-day calendar event instead
        await this.eventRepository.update(event.id, { syncType: 'event' });
        await this.syncAsCalendarEvent(event, calendarId);
        return;
      }
      throw error;
    }
  }

  private extractChildName(event: CalendarEventEntity): string | null {
    // Event titles are formatted as "ChildName: actual title" when child is set
    if (event.childId && event.title.includes(': ')) {
      return event.title.split(': ')[0];
    }
    return null;
  }

  private isEventInPast(
    event: CalendarEventEntity,
    now: Date,
  ): boolean {
    return this.isDateInPast(event.date, event.time, now);
  }

  /**
   * Returns true if `candidate` shares date+time with another event for the
   * same child and the LLM judges them to be the same gathering. The check
   * is skipped for events without a time (date-only tasks) — they're noisy
   * to compare and we'd rather over-approve than over-suppress.
   */
  private async detectDuplicateOfExisting(
    candidate: CalendarEventEntity,
  ): Promise<boolean> {
    if (!candidate.time) return false;
    const siblings = await this.eventRepository.findSameSlotForChild(
      candidate.date,
      candidate.time,
      candidate.childId,
      candidate.id,
    );
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
      if (same) return true;
    }
    return false;
  }

  private isDateInPast(
    date: string,
    time: string | undefined,
    now: Date,
  ): boolean {
    const dateStr = time
      ? `${date}T${time}:00`
      : `${date}T23:59:59`;
    const eventDate = new Date(dateStr);
    return eventDate.getTime() < now.getTime();
  }

  private async getCalendarId(): Promise<string> {
    try {
      const setting =
        await this.settingsService.findByKey('google_calendar_id');
      return setting.value;
    } catch {
      return 'primary';
    }
  }
}

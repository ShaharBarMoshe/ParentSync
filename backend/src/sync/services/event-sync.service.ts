import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';

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
    private readonly approvalService: ApprovalService,
  ) {}

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

    const currentDate = new Date().toISOString().split('T')[0];

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

      groupMeta.push({
        group,
        childName,
        childId: firstMessage.childId,
        calendarColorId,
        mergedContent: this.mergeGroupContent(group),
      });
    }

    // Batch parse all groups in a single LLM call
    const batchInput = groupMeta.map((meta, i) => ({
      id: String(i),
      content: meta.mergedContent,
    }));
    const batchResult = await this.messageParserService.parseMessageBatch(
      batchInput,
      currentDate,
    );

    const approvalEnabled = await this.approvalService.isApprovalEnabled();

    // Process each group's parsed events
    for (let i = 0; i < groupMeta.length; i++) {
      const meta = groupMeta[i];
      const parsedEvents = batchResult.get(String(i)) || [];

      try {
        const result = await this.createEventsInTransaction(
          meta.group,
          parsedEvents,
          meta.childName,
          meta.childId,
          meta.calendarColorId,
          approvalEnabled,
        );
        messagesParsed += meta.group.length;
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
            await this.approvalService.sendForApproval(savedEvent);
          }
        }
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
        // Don't mark as synced - will retry on next run
      }
    }

    this.logger.log(
      `Event sync completed: ${messagesParsed} messages parsed, ${eventsCreated} events created, ${eventsSynced} events synced`,
    );

    return { messagesParsed, eventsCreated, eventsSynced };
  }

  private static readonly MERGE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

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

      for (const parsed of parsedEvents) {
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
    const eventDateStr = event.time
      ? `${event.date}T${event.time}:00`
      : `${event.date}T23:59:59`;
    const eventDate = new Date(eventDateStr);
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

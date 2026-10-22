import { Injectable, Logger, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EVENT_REPOSITORY,
  MESSAGE_REPOSITORY,
} from '../../../shared/constants/injection-tokens';
import type { IEventRepository } from '../../../calendar/interfaces/event-repository.interface';
import type { IMessageRepository } from '../../../messages/interfaces/message-repository.interface';
import { CalendarEventEntity } from '../../../calendar/entities/calendar-event.entity';
import { MessageEntity } from '../../../messages/entities/message.entity';
import type { ParsedEvent } from '../../../llm/dto/parsed-event.dto';
import { ApprovalStatus } from '../../../shared/enums/approval-status.enum';
import type { DedupResult } from '../../services/message-deduplication.service';
import { SyncSettings, isDateInPast } from '../sync-settings.service';
import type {
  EventSyncState,
  EventSyncUpdate,
  GroupMeta,
  PendingDismissal,
} from '../event-sync.state';

/**
 * Turn each fresh group's extraction into rows, and mark its messages parsed.
 *
 * **This node is the pipeline's error boundary.** One transaction per group:
 * either the events and the parsed flags land together, or neither does. When
 * a group throws, its messages are still marked parsed — a message that cannot
 * be processed must not be retried forever — and it is counted failed rather
 * than parsed, so the completion log tells the truth.
 *
 * That per-group boundary is why persistence is its own node and not folded in
 * with screening: a screening failure should cost one event, not a whole
 * group's accounting.
 */
@Injectable()
export class PersistEventsNode {
  private readonly logger = new Logger(PersistEventsNode.name);

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly syncSettings: SyncSettings,
  ) {}

  async run(state: EventSyncState): Promise<EventSyncUpdate> {
    const freshGroups = state.freshIndices.map((i) => state.groups[i]);
    const savedEvents: CalendarEventEntity[] = [];
    const dismissals: PendingDismissal[] = [];
    let messagesParsed = 0;
    let messagesFailed = 0;
    let eventsCreated = 0;

    for (let i = 0; i < freshGroups.length; i++) {
      const meta = freshGroups[i];
      const parsedEvents = state.parsed.get(String(i)) || [];
      const creates = parsedEvents.filter(
        (e) => !e.action || e.action === 'create',
      );
      const cancels = parsedEvents.filter(
        (e) => e.action === 'cancel' || e.action === 'delay',
      );

      try {
        const result = await this.createEventsInTransaction(
          meta,
          creates,
          state.approvalEnabled,
        );
        eventsCreated += result.eventsCreated;
        savedEvents.push(...result.savedEvents);
        for (let n = 0; n < result.eventsCreated; n++) {
          await this.syncSettings.incrementMetric('metric.events_created_total');
        }

        for (const event of cancels) {
          dismissals.push({
            event,
            childId: meta.childId,
            childName: meta.childName,
            messageId: meta.group[0].id,
          });
        }

        messagesParsed += meta.group.length;
      } catch (error) {
        this.logger.error(
          `Failed to process message group (${meta.group.length} messages): ${(error as Error).message}`,
        );
        messagesFailed += meta.group.length;
        // Mark parsed anyway so a poison message cannot loop forever. Counted
        // as failed, never as parsed — see the completion log.
        for (const msg of meta.group) {
          await this.messageRepository.update(msg.id, { parsed: true });
        }
      }
    }

    return {
      savedEvents,
      dismissals,
      counters: { messagesParsed, messagesFailed, eventsCreated },
    };
  }

  /**
   * Create one group's events and mark its messages parsed, atomically.
   *
   * The `QueryRunner` is opened and released entirely within this method, and
   * therefore within this node. Holding one across a graph edge would keep a
   * SQLite write transaction open while the runtime awaits, locking the
   * database file for every other caller.
   */
  private async createEventsInTransaction(
    meta: GroupMeta,
    parsedEvents: ParsedEvent[],
    approvalEnabled: boolean,
  ): Promise<{ eventsCreated: number; savedEvents: CalendarEventEntity[] }> {
    const { group, childName, childId, calendarColorId, mergedContent } = meta;
    const dedup: DedupResult | undefined = meta.dedup;

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
      const today = now.toISOString().split('T')[0];

      for (const parsed of parsedEvents) {
        // Too late to act on — an event today or earlier is noise by the time
        // a sync notices it.
        if (
          parsed.date &&
          (parsed.date === today || isDateInPast(parsed.date, parsed.time, now))
        ) {
          this.logger.log(
            `Skipping ${parsed.date === today ? 'today' : 'past'} event ` +
              `"${parsed.title}" (${parsed.date}${parsed.time ? ' ' + parsed.time : ''})`,
          );
          continue;
        }

        const title = childName ? `${childName}: ${parsed.title}` : parsed.title;

        const existing = await this.eventRepository.findByTitleDateTimeChild(
          title,
          parsed.date,
          parsed.time,
          childId,
        );
        if (existing) {
          this.logger.debug(
            `Skipping duplicate event "${title}" on ${parsed.date}` +
              `${parsed.time ? ` at ${parsed.time}` : ''}`,
          );
          continue;
        }

        const calendarEvent = queryRunner.manager.create(CalendarEventEntity, {
          title,
          description: parsed.description,
          date: parsed.date,
          time: parsed.time,
          endTime: parsed.endTime,
          location: parsed.location,
          source: firstMessage.source,
          sourceId: firstMessage.id,
          // Snapshot what the model actually saw — the merged group text — so
          // a 😢 rejection captures the right negative example even when the
          // event came from a later message in the group.
          sourceContent: mergedContent ?? null,
          childId: childId || undefined,
          calendarColorId: calendarColorId || undefined,
          syncType: parsed.time ? 'event' : 'task',
          syncedToGoogle: false,
          approvalStatus: approvalEnabled
            ? ApprovalStatus.PENDING
            : ApprovalStatus.NONE,
        } as Partial<CalendarEventEntity>);

        const saved = await queryRunner.manager.save(calendarEvent);
        eventsCreated++;
        savedEvents.push(saved);

        this.eventEmitter.emit('event.created', {
          eventId: saved.id,
          messageId: firstMessage.id,
        });
      }

      // Persist the dedup embedding and hash on every message in the group, so
      // a future forward matches through the cheap hash path.
      const embedding = dedup?.embedding ?? null;
      const contentHash = dedup?.contentHash ?? null;
      for (const msg of group) {
        await queryRunner.manager.update(MessageEntity, msg.id, {
          parsed: true,
          embedding,
          contentHash,
        });
      }

      await queryRunner.commitTransaction();

      if (embedding && contentHash) {
        this.logger.log(`Persisted embeddings on ${group.length} message rows`);
      }
      return { eventsCreated, savedEvents };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

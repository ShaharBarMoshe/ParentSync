import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENT_REPOSITORY,
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  DISMISSAL_REPOSITORY,
  NEGATIVE_EXAMPLE_REPOSITORY,
} from '../../shared/constants/injection-tokens';
import type { INegativeExampleRepository } from '../../llm/interfaces/negative-example-repository.interface';
import type { IEventRepository } from '../../calendar/interfaces/event-repository.interface';
import type { IWhatsAppService } from '../../messages/interfaces/whatsapp-service.interface';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import type { IDismissalRepository } from '../interfaces/dismissal-repository.interface';
import { SettingsService } from '../../settings/settings.service';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { APP_MESSAGE_MARKER } from '../../shared/constants/app-marker';
import type { WhatsAppReaction } from '../../messages/interfaces/whatsapp-service.interface';
import { generateICS } from '../../calendar/utils/ics-generator';
import { EventDismissalService } from './event-dismissal.service';
import { EventSyncService } from './event-sync.service';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(WHATSAPP_SERVICE)
    private readonly whatsappService: IWhatsAppService,
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    @Inject(DISMISSAL_REPOSITORY)
    private readonly dismissalRepository: IDismissalRepository,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => EventDismissalService))
    private readonly eventDismissalService: EventDismissalService,
    @Inject(forwardRef(() => EventSyncService))
    private readonly eventSyncService: EventSyncService,
    private readonly appErrorEmitter: AppErrorEmitterService,
    @Inject(NEGATIVE_EXAMPLE_REPOSITORY)
    private readonly negativeExampleRepository: INegativeExampleRepository,
  ) {}

  async isApprovalEnabled(): Promise<boolean> {
    const channel = await this.getApprovalChannel();
    return channel !== null;
  }

  async getApprovalChannel(): Promise<string | null> {
    try {
      const setting =
        await this.settingsService.findByKey('approval_channel');
      return setting.value?.trim() || null;
    } catch {
      return null;
    }
  }

  async sendForApproval(event: CalendarEventEntity): Promise<void> {
    const channel = await this.getApprovalChannel();
    if (!channel) {
      return;
    }

    if (!this.whatsappService.isConnected()) {
      this.logger.warn(
        `WhatsApp not connected, cannot send approval for event ${event.id}`,
      );
      this.appErrorEmitter.emit({
        source: 'approval',
        code: AppErrorCodes.APPROVAL_WHATSAPP_DISCONNECTED,
        message:
          'WhatsApp is disconnected — pending events cannot be sent for approval. Reconnect from Settings → WhatsApp.',
      });
      return;
    }

    try {
      // Look up source channel from the original message
      let sourceChannel = 'Unknown';
      if (event.sourceId) {
        try {
          const message = await this.messageRepository.findById(event.sourceId);
          if (message) {
            sourceChannel = message.channel || 'Unknown';
          }
        } catch {
          // Ignore lookup failure
        }
      }

      const text = this.formatApprovalMessage(event, sourceChannel);
      const icsContent = generateICS(event);
      const icsBase64 = Buffer.from(icsContent).toString('base64');

      const messageId = await this.whatsappService.sendMessage(channel, text, {
        mimetype: 'text/calendar',
        data: icsBase64,
        filename: `${event.title.replace(/[^a-zA-Z0-9\u0590-\u05FF ]/g, '_')}.ics`,
      });

      await this.eventRepository.update(event.id, {
        approvalStatus: ApprovalStatus.PENDING,
        approvalMessageId: messageId,
      });

      this.logger.log(
        `Sent event "${event.title}" for approval in channel "${channel}"`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send event ${event.id} for approval: ${error.message}`,
      );
      // Event remains with its current approval status for retry on next sync
    }
  }

  @OnEvent('whatsapp.reaction')
  async handleReaction(payload: WhatsAppReaction): Promise<void> {
    if (!payload.msgId) {
      return;
    }

    // Check regular event approval first
    const event = await this.eventRepository.findByApprovalMessageId(
      payload.msgId,
    );
    if (event) {
      if (event.approvalStatus !== ApprovalStatus.PENDING) {
        this.logger.debug(
          `Ignoring reaction on event ${event.id} — already ${event.approvalStatus}`,
        );
        return;
      }

      if (payload.reaction === '👍') {
        await this.approveEvent(event);
      } else if (payload.reaction === '😢') {
        await this.rejectEvent(event);
      }
      return;
    }

    // Check dismissal approval
    const dismissal = await this.dismissalRepository.findByApprovalMessageId(
      payload.msgId,
    );
    if (!dismissal || dismissal.status !== 'pending_approval') {
      return;
    }

    if (payload.reaction === '👍') {
      await this.eventDismissalService.approveDismissal(dismissal);
    } else if (payload.reaction === '😢') {
      await this.eventDismissalService.rejectDismissal(dismissal);
    }
  }

  /**
   * Public approve entry-point used by HTTP requests from the in-app button.
   * Idempotent: if the event is already approved/rejected, returns the
   * current state without re-running the approval side effects.
   */
  async approveEventById(id: string): Promise<CalendarEventEntity> {
    const event = await this.eventRepository.findById(id);
    if (!event) {
      throw new Error(`Event ${id} not found`);
    }
    if (event.approvalStatus !== ApprovalStatus.PENDING) {
      this.logger.debug(
        `approveEventById no-op for ${id} — already ${event.approvalStatus}`,
      );
      return event;
    }
    await this.approveEvent(event);
    return (await this.eventRepository.findById(id)) ?? event;
  }

  /**
   * Public reject entry-point used by HTTP requests from the in-app button.
   * Idempotent — see approveEventById.
   */
  async rejectEventById(id: string): Promise<CalendarEventEntity> {
    const event = await this.eventRepository.findById(id);
    if (!event) {
      throw new Error(`Event ${id} not found`);
    }
    if (event.approvalStatus !== ApprovalStatus.PENDING) {
      this.logger.debug(
        `rejectEventById no-op for ${id} — already ${event.approvalStatus}`,
      );
      return event;
    }
    await this.rejectEvent(event);
    return (await this.eventRepository.findById(id)) ?? event;
  }

  private async approveEvent(event: CalendarEventEntity): Promise<void> {
    this.logger.log(`Event "${event.title}" approved`);

    const updated = await this.eventRepository.update(event.id, {
      approvalStatus: ApprovalStatus.APPROVED,
    });

    try {
      await this.eventSyncService.syncSingleEventToGoogle(updated);
      this.logger.log(
        `Event "${event.title}" synced to Google after approval`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to sync approved event ${event.id} to Google: ${error.message}. Will retry on next sync.`,
      );
      // Event is marked approved; findUnsynced() will pick it up on next sync
    }
  }

  private async rejectEvent(event: CalendarEventEntity): Promise<void> {
    this.logger.log(`Event "${event.title}" rejected`);

    await this.eventRepository.update(event.id, {
      approvalStatus: ApprovalStatus.REJECTED,
    });

    // Capture as a negative example so the LLM stops repeating the mistake.
    // Best-effort: the source message may have been pruned, in which case
    // we just skip — the event is still marked rejected.
    if (!event.sourceId) return;
    try {
      const sourceMessage = await this.messageRepository.findById(event.sourceId);
      if (!sourceMessage?.content) return;
      await this.negativeExampleRepository.create({
        messageContent: sourceMessage.content,
        extractedTitle: event.title,
        extractedDate: event.date ?? null,
        channel: sourceMessage.channel ?? null,
      });
      this.logger.log(
        `Captured negative example for rejected event "${event.title}"`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to capture negative example for event ${event.id}: ${(error as Error).message}`,
      );
    }
  }

  private formatApprovalMessage(
    event: CalendarEventEntity,
    sourceChannel: string,
  ): string {
    const lines = [
      `📅 New Event for Approval`,
      ``,
      `Title: ${event.title}`,
      `Date: ${event.date}`,
      `Time: ${event.time || 'All day'}`,
    ];

    if (event.location) {
      lines.push(`Location: ${event.location}`);
    }
    if (event.description) {
      lines.push(`Description: ${event.description}`);
    }

    lines.push(`Source: ${event.source} — ${sourceChannel}`);
    lines.push(``);
    lines.push(`React 👍 to approve or 😢 to reject`);

    return lines.join('\n') + APP_MESSAGE_MARKER;
  }
}

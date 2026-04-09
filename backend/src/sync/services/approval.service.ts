import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENT_REPOSITORY,
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IEventRepository } from '../../calendar/interfaces/event-repository.interface';
import type { IWhatsAppService } from '../../messages/interfaces/whatsapp-service.interface';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import type { IGoogleCalendarService } from '../../calendar/interfaces/google-calendar-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import type { WhatsAppReaction } from '../../messages/interfaces/whatsapp-service.interface';
import { generateICS } from '../../calendar/utils/ics-generator';

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
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    private readonly settingsService: SettingsService,
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

    const event = await this.eventRepository.findByApprovalMessageId(
      payload.msgId,
    );
    if (!event) {
      return; // Reaction on an unrelated message
    }

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
    // Ignore other reactions
  }

  private async approveEvent(event: CalendarEventEntity): Promise<void> {
    this.logger.log(`Event "${event.title}" approved`);

    await this.eventRepository.update(event.id, {
      approvalStatus: ApprovalStatus.APPROVED,
    });

    // Immediately sync to Google Calendar
    try {
      let calendarId = 'primary';
      try {
        const setting =
          await this.settingsService.findByKey('google_calendar_id');
        calendarId = setting.value;
      } catch {
        // Use primary
      }

      const googleEventId = await this.googleCalendarService.createEvent(
        { ...event, approvalStatus: ApprovalStatus.APPROVED },
        calendarId,
        event.calendarColorId || undefined,
      );

      await this.eventRepository.update(event.id, {
        googleEventId,
        syncedToGoogle: true,
      });

      this.logger.log(
        `Event "${event.title}" synced to Google Calendar after approval`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to sync approved event ${event.id} to Google Calendar: ${error.message}. Will retry on next sync.`,
      );
      // Event is marked approved, findUnsynced() will pick it up on next sync
    }
  }

  private async rejectEvent(event: CalendarEventEntity): Promise<void> {
    this.logger.log(`Event "${event.title}" rejected`);

    await this.eventRepository.update(event.id, {
      approvalStatus: ApprovalStatus.REJECTED,
    });
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

    return lines.join('\n');
  }
}

import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  DISMISSAL_REPOSITORY,
} from '../../shared/constants/injection-tokens';
import type { IEventRepository } from '../../calendar/interfaces/event-repository.interface';
import type {
  IGoogleCalendarService,
  GoogleCalendarEventResult,
} from '../../calendar/interfaces/google-calendar-service.interface';
import type { IGoogleTasksService } from '../../calendar/interfaces/google-tasks-service.interface';
import type { IWhatsAppService } from '../../messages/interfaces/whatsapp-service.interface';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import type { IDismissalRepository } from '../interfaces/dismissal-repository.interface';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { PendingDismissalEntity } from '../entities/pending-dismissal.entity';
import type { ParsedEvent } from '../../llm/dto/parsed-event.dto';
import { SettingsService } from '../../settings/settings.service';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { APP_MESSAGE_MARKER } from '../../shared/constants/app-marker';

interface MatchedEvent {
  localEvent?: CalendarEventEntity;
  googleResult?: GoogleCalendarEventResult;
  calendarId: string;
}

@Injectable()
export class EventDismissalService {
  private readonly logger = new Logger(EventDismissalService.name);

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    @Inject(GOOGLE_TASKS_SERVICE)
    private readonly googleTasksService: IGoogleTasksService,
    @Inject(WHATSAPP_SERVICE)
    private readonly whatsappService: IWhatsAppService,
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    @Inject(DISMISSAL_REPOSITORY)
    private readonly dismissalRepository: IDismissalRepository,
    private readonly settingsService: SettingsService,
  ) {}

  async processDismissal(
    parsed: ParsedEvent,
    childId?: string,
    childName?: string,
    sourceMessageId?: string,
  ): Promise<void> {
    const action = parsed.action as 'cancel' | 'delay';
    const sourceChannel = await this.getSourceChannel(sourceMessageId);

    try {
      const match = await this.findMatchingEvent(parsed, childId, childName);

      if (!match) {
        await this.sendFailureNotification(
          parsed,
          'No matching event found in calendar',
          sourceChannel,
        );
        return;
      }

      await this.sendDismissalApproval(match, action, parsed, sourceChannel);
    } catch (error) {
      this.logger.error(
        `Failed to process dismissal for "${parsed.title}": ${error.message}`,
      );
      await this.sendFailureNotification(
        parsed,
        error.message,
        sourceChannel,
      );
    }
  }

  async findMatchingEvent(
    parsed: ParsedEvent,
    childId?: string,
    childName?: string,
  ): Promise<MatchedEvent | null> {
    const calendarId = await this.getCalendarId();
    const searchTitle = parsed.originalTitle || parsed.title;

    // Try with child-prefixed title first if childName is set
    const searchVariants = childName
      ? [`${childName}: ${searchTitle}`, searchTitle]
      : [searchTitle];

    // Search local DB
    for (const title of searchVariants) {
      const localResults =
        await this.eventRepository.findByTitleSubstringAndChild(
          title,
          childId,
          parsed.date || undefined,
        );

      if (localResults.length > 0) {
        // If date was provided, prefer exact date match
        const bestMatch = parsed.date
          ? localResults.find((e) => e.date === parsed.date) ||
            localResults[0]
          : localResults[0];

        this.logger.log(
          `Found local DB match for "${searchTitle}": "${bestMatch.title}" (${bestMatch.date})`,
        );
        return { localEvent: bestMatch, calendarId };
      }
    }

    // If no date constraint was given, try local DB without date
    if (parsed.date) {
      for (const title of searchVariants) {
        const localResults =
          await this.eventRepository.findByTitleSubstringAndChild(
            title,
            childId,
          );

        if (localResults.length > 0) {
          this.logger.log(
            `Found local DB match (without date) for "${searchTitle}": "${localResults[0].title}"`,
          );
          return { localEvent: localResults[0], calendarId };
        }
      }
    }

    // Fall back to Google Calendar search
    try {
      const googleResults = await this.googleCalendarService.searchEvents(
        calendarId,
        searchTitle,
      );

      if (googleResults.length > 0) {
        // Try to match Google result with local DB by googleEventId
        for (const gResult of googleResults) {
          const allEvents = await this.eventRepository.findAll();
          const localMatch = allEvents.find(
            (e) => e.googleEventId === gResult.googleEventId,
          );
          if (localMatch) {
            this.logger.log(
              `Found Google Calendar match linked to local event: "${localMatch.title}"`,
            );
            return { localEvent: localMatch, calendarId };
          }
        }

        // Return Google-only match
        this.logger.log(
          `Found Google Calendar match (no local link): "${googleResults[0].summary}"`,
        );
        return { googleResult: googleResults[0], calendarId };
      }
    } catch (error) {
      this.logger.warn(
        `Google Calendar search failed for "${searchTitle}": ${error.message}`,
      );
    }

    return null;
  }

  async approveDismissal(dismissal: PendingDismissalEntity): Promise<void> {
    this.logger.log(
      `Dismissal approved: ${dismissal.action} for event ${dismissal.targetEventId || dismissal.targetGoogleEventId}`,
    );

    try {
      if (dismissal.action === 'cancel') {
        await this.executeCancellation(dismissal);
      } else if (dismissal.action === 'delay') {
        await this.executeDelay(dismissal);
      }

      await this.dismissalRepository.update(dismissal.id, {
        status: 'approved',
      });
    } catch (error) {
      this.logger.error(
        `Failed to execute dismissal ${dismissal.id}: ${error.message}`,
      );
      await this.dismissalRepository.update(dismissal.id, {
        status: 'approved',
      });

      await this.sendFailureNotificationDirect(
        `Failed to ${dismissal.action} event: ${error.message}`,
      );
    }
  }

  async rejectDismissal(dismissal: PendingDismissalEntity): Promise<void> {
    this.logger.log(`Dismissal rejected: ${dismissal.id}`);
    await this.dismissalRepository.update(dismissal.id, {
      status: 'rejected',
    });
  }

  async sendFailureNotification(
    parsed: ParsedEvent,
    reason: string,
    sourceChannel: string,
  ): Promise<void> {
    const channel = await this.getApprovalChannel();
    if (!channel || !this.whatsappService.isConnected()) {
      this.logger.warn(
        `Cannot send failure notification: ${!channel ? 'no approval channel' : 'WhatsApp not connected'}`,
      );
      return;
    }

    const lines = [
      `\u26a0\ufe0f Event Dismissal Failed`,
      ``,
      `Could not find matching event for: "${parsed.originalTitle || parsed.title}"`,
      `Reason: ${reason}`,
    ];

    if (parsed.date) {
      lines.push(`Original date: ${parsed.date}`);
    }

    lines.push(`Source: ${sourceChannel}`);

    const text = lines.join('\n') + APP_MESSAGE_MARKER;

    try {
      await this.whatsappService.sendMessage(channel, text);
    } catch (error) {
      this.logger.error(
        `Failed to send failure notification: ${error.message}`,
      );
    }
  }

  private async sendDismissalApproval(
    match: MatchedEvent,
    action: 'cancel' | 'delay',
    parsed: ParsedEvent,
    sourceChannel: string,
  ): Promise<void> {
    const channel = await this.getApprovalChannel();
    if (!channel) {
      this.logger.warn(
        'Cannot send dismissal approval: no approval channel configured',
      );
      return;
    }

    if (!this.whatsappService.isConnected()) {
      this.logger.warn(
        'Cannot send dismissal approval: WhatsApp not connected',
      );
      return;
    }

    const eventTitle =
      match.localEvent?.title || match.googleResult?.summary || 'Unknown';
    const eventDate =
      match.localEvent?.date || match.googleResult?.date || 'Unknown';
    const eventTime =
      match.localEvent?.time || match.googleResult?.time || undefined;

    let lines: string[];
    if (action === 'cancel') {
      lines = [
        `\ud83d\uddd1\ufe0f Event Cancellation Request`,
        ``,
        `Found event: "${eventTitle}"`,
        `Date: ${eventDate}`,
        `Time: ${eventTime || 'All day'}`,
        ``,
        `Action: Cancel event`,
      ];
    } else {
      lines = [
        `\ud83d\udcc5 Event Reschedule Request`,
        ``,
        `Found event: "${eventTitle}"`,
        `Original: ${eventDate}${eventTime ? ' ' + eventTime : ''}`,
        `New date: ${parsed.newDate || 'Not specified'}${parsed.newTime ? ' ' + parsed.newTime : ''}`,
        ``,
        `Action: Reschedule event`,
      ];
    }

    lines.push(`Source: ${sourceChannel}`);
    lines.push(``);
    lines.push(`React \ud83d\udc4d to approve or \ud83d\ude22 to reject`);

    const text = lines.join('\n') + APP_MESSAGE_MARKER;

    try {
      const messageId = await this.whatsappService.sendMessage(channel, text);

      // Create pending dismissal record
      await this.dismissalRepository.create({
        action,
        targetEventId: match.localEvent?.id || undefined,
        targetGoogleEventId:
          match.localEvent?.googleEventId ||
          match.googleResult?.googleEventId ||
          undefined,
        targetGoogleTaskListId: match.localEvent?.googleTaskListId || undefined,
        targetSyncType: match.localEvent?.syncType || 'event',
        calendarId: match.calendarId,
        newDate: parsed.newDate || undefined,
        newTime: parsed.newTime || undefined,
        approvalMessageId: messageId,
        status: 'pending_approval',
      });

      this.logger.log(
        `Sent dismissal approval for "${eventTitle}" in channel "${channel}"`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send dismissal approval: ${error.message}`,
      );
    }
  }

  private async executeCancellation(
    dismissal: PendingDismissalEntity,
  ): Promise<void> {
    // Delete from Google Calendar or Tasks
    if (
      dismissal.targetSyncType === 'task' &&
      dismissal.targetGoogleEventId &&
      dismissal.targetGoogleTaskListId
    ) {
      await this.googleTasksService.deleteTask(
        dismissal.targetGoogleEventId,
        dismissal.targetGoogleTaskListId,
      );
      this.logger.log(
        `Deleted Google Task: ${dismissal.targetGoogleEventId}`,
      );
    } else if (dismissal.targetGoogleEventId && dismissal.calendarId) {
      await this.googleCalendarService.deleteEvent(
        dismissal.targetGoogleEventId,
        dismissal.calendarId,
      );
      this.logger.log(
        `Deleted Google Calendar event: ${dismissal.targetGoogleEventId}`,
      );
    }

    // Mark local event as rejected
    if (dismissal.targetEventId) {
      await this.eventRepository.update(dismissal.targetEventId, {
        approvalStatus: ApprovalStatus.REJECTED,
      });
    }
  }

  private async executeDelay(
    dismissal: PendingDismissalEntity,
  ): Promise<void> {
    if (dismissal.targetEventId) {
      // Update local event
      const updateData: Partial<CalendarEventEntity> = {};
      if (dismissal.newDate) updateData.date = dismissal.newDate;
      if (dismissal.newTime) updateData.time = dismissal.newTime;

      const updatedEvent = await this.eventRepository.update(
        dismissal.targetEventId,
        updateData,
      );

      // Update Google Calendar
      if (updatedEvent.googleEventId) {
        await this.googleCalendarService.updateEvent(updatedEvent);
        this.logger.log(
          `Updated Google Calendar event: ${updatedEvent.googleEventId}`,
        );
      }
    } else if (dismissal.targetGoogleEventId && dismissal.calendarId) {
      // Google-only event: delete old and note that manual recreation may be needed
      await this.googleCalendarService.deleteEvent(
        dismissal.targetGoogleEventId,
        dismissal.calendarId,
      );
      this.logger.warn(
        `Deleted Google-only event ${dismissal.targetGoogleEventId} for delay — no local event to reschedule`,
      );
    }
  }

  private async sendFailureNotificationDirect(
    reason: string,
  ): Promise<void> {
    const channel = await this.getApprovalChannel();
    if (!channel || !this.whatsappService.isConnected()) return;

    const text =
      `\u26a0\ufe0f Event Dismissal Error\n\n${reason}` +
      APP_MESSAGE_MARKER;

    try {
      await this.whatsappService.sendMessage(channel, text);
    } catch (error) {
      this.logger.error(
        `Failed to send error notification: ${error.message}`,
      );
    }
  }

  private async getSourceChannel(
    sourceMessageId?: string,
  ): Promise<string> {
    if (!sourceMessageId) return 'Unknown';
    try {
      const message = await this.messageRepository.findById(sourceMessageId);
      return message?.channel || 'Unknown';
    } catch {
      return 'Unknown';
    }
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

  private async getApprovalChannel(): Promise<string | null> {
    try {
      const setting =
        await this.settingsService.findByKey('approval_channel');
      return setting.value?.trim() || null;
    } catch {
      return null;
    }
  }
}

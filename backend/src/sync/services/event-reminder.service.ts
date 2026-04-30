import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  EVENT_REPOSITORY,
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IEventRepository } from '../../calendar/interfaces/event-repository.interface';
import type { IWhatsAppService } from '../../messages/interfaces/whatsapp-service.interface';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import type { IGoogleCalendarService } from '../../calendar/interfaces/google-calendar-service.interface';
import type { IGoogleTasksService } from '../../calendar/interfaces/google-tasks-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import { APP_MESSAGE_MARKER } from '../../shared/constants/app-marker';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

@Injectable()
export class EventReminderService {
  private readonly logger = new Logger(EventReminderService.name);

  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(WHATSAPP_SERVICE)
    private readonly whatsappService: IWhatsAppService,
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    @Inject(GOOGLE_TASKS_SERVICE)
    private readonly googleTasksService: IGoogleTasksService,
    private readonly settingsService: SettingsService,
    private readonly appErrorEmitter: AppErrorEmitterService,
  ) {}

  @Cron('0 18 * * *', { timeZone: 'Asia/Jerusalem' })
  async runScheduled(): Promise<void> {
    try {
      await this.sendDueReminders();
    } catch (error) {
      this.logger.error(
        `Scheduled reminder run failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  async sendDueReminders(now: Date = new Date()): Promise<number> {
    const channel = await this.getReminderChannel();
    if (!channel) {
      this.logger.warn(
        'No WhatsApp reminder channel configured (approval_channel setting); skipping reminders',
      );
      return 0;
    }

    if (!this.whatsappService.isConnected()) {
      this.logger.warn('WhatsApp not connected; skipping reminders');
      return 0;
    }

    const calendarId = await this.getCalendarId();
    const due = await this.eventRepository.findDueForReminder(now);

    if (due.length === 0) {
      return 0;
    }

    this.logger.log(`Found ${due.length} event(s) due for reminder`);

    let sent = 0;
    for (const event of due) {
      try {
        // For calendar events, verify they still exist in Google Calendar
        // For tasks, skip this check (tasks are managed via Google Tasks API)
        if (event.syncType !== 'task') {
          const exists = await this.googleCalendarService.eventExists(
            event.googleEventId,
            calendarId,
          );
          if (!exists) {
            this.logger.log(
              `Event "${event.title}" (${event.id}) no longer exists in Google Calendar; marking reminder as sent to skip`,
            );
            await this.eventRepository.update(event.id, { reminderSent: true });
            continue;
          }
        }

        const text = await this.formatReminderMessage(event);
        await this.whatsappService.sendMessage(channel, text);
        await this.eventRepository.update(event.id, { reminderSent: true });
        sent++;
        this.logger.log(
          `Sent reminder for ${event.syncType || 'event'} "${event.title}" (${event.id}) to "${channel}"`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send reminder for event ${event.id}: ${(error as Error).message}`,
          (error as Error).stack,
        );
        this.appErrorEmitter.emit({
          source: 'reminder',
          code: AppErrorCodes.REMINDER_SEND_FAILED,
          message: `Could not send WhatsApp reminder for one or more events. Check WhatsApp connection and the reminder channel in Settings.`,
        });
      }
    }

    return sent;
  }

  private async getReminderChannel(): Promise<string | null> {
    try {
      const setting = await this.settingsService.findByKey('approval_channel');
      return setting.value?.trim() || null;
    } catch {
      return null;
    }
  }

  private async getCalendarId(): Promise<string> {
    try {
      const setting =
        await this.settingsService.findByKey('google_calendar_id');
      return setting.value || 'primary';
    } catch {
      return 'primary';
    }
  }

  private async formatReminderMessage(
    event: CalendarEventEntity,
  ): Promise<string> {
    let sourceChannel = 'Unknown';
    if (event.sourceId) {
      try {
        const message = await this.messageRepository.findById(event.sourceId);
        if (message) {
          sourceChannel = message.channel || 'Unknown';
        }
      } catch (error) {
        this.logger.warn(
          `Could not look up source message for event ${event.id}: ${(error as Error).message}`,
        );
      }
    }

    const isTask = event.syncType === 'task';
    const header = isTask
      ? `📋 Reminder: task due tomorrow`
      : `⏰ Reminder: event in ~24 hours`;

    const lines = [
      header,
      ``,
      `Title: ${event.title}`,
      `Date: ${event.date}`,
    ];
    if (event.time) {
      lines.push(`Time: ${event.time}`);
    }
    if (event.location) {
      lines.push(`Location: ${event.location}`);
    }
    if (event.description) {
      lines.push(``, `Details: ${event.description}`);
    }
    lines.push(`Source: ${event.source} — ${sourceChannel}`);
    return lines.join('\n') + APP_MESSAGE_MARKER;
  }
}

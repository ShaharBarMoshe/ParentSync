import { Injectable, Logger, Inject } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import {
  MESSAGE_REPOSITORY,
  WHATSAPP_SERVICE,
  GMAIL_SERVICE,
  SYNC_LOG_REPOSITORY,
} from '../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import type { IWhatsAppService } from '../../messages/interfaces/whatsapp-service.interface';
import type { IGmailService } from '../../messages/interfaces/gmail-service.interface';
import type { ISyncLogRepository } from '../interfaces/sync-log-repository.interface';
import { MessageSource } from '../../shared/enums/message-source.enum';
import { SyncStatus } from '../../shared/enums/sync-status.enum';
import { SettingsService } from '../../settings/settings.service';
import { ChildService } from '../../settings/child.service';
import { ChildEntity } from '../../settings/entities/child.entity';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { ChannelSyncDetail } from '../entities/sync-log.entity';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS =
  process.env.NODE_ENV === 'test' ? 10 : 5000;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    @Inject(WHATSAPP_SERVICE)
    private readonly whatsappService: IWhatsAppService,
    @Inject(GMAIL_SERVICE)
    private readonly gmailService: IGmailService,
    @Inject(SYNC_LOG_REPOSITORY)
    private readonly syncLogRepository: ISyncLogRepository,
    private readonly settingsService: SettingsService,
    private readonly childService: ChildService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadScheduleFromSettings();
  }

  async loadScheduleFromSettings(): Promise<void> {
    try {
      const setting = await this.settingsService.findByKey('check_schedule');
      this.updateScheduleFromHours(setting.value);
    } catch {
      // No schedule configured yet, use default hours
      this.updateScheduleFromHours('9,14,18');
    }
  }

  /**
   * Parse comma-separated hours (e.g. "9,14,18") and create a cron job
   * for each valid hour (0–23) to trigger syncAll().
   */
  updateScheduleFromHours(hoursString: string): void {
    // Remove all existing sync jobs
    const existingJobs = this.schedulerRegistry.getCronJobs();
    for (const [name] of existingJobs) {
      if (name.startsWith('message-sync')) {
        this.schedulerRegistry.deleteCronJob(name);
      }
    }

    const hours = hoursString
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((h) => !isNaN(h) && h >= 0 && h <= 23);

    if (hours.length === 0) {
      this.logger.warn('No valid sync hours configured, using default 9');
      hours.push(9);
    }

    for (const hour of hours) {
      const cronExpression = `0 ${hour} * * *`;
      const jobName = `message-sync-${hour}`;

      const job = new CronJob(cronExpression, () => {
        this.syncAll().catch((err) =>
          this.logger.error(`Scheduled sync failed: ${err.message}`),
        );
      });

      this.schedulerRegistry.addCronJob(jobName, job);
      job.start();
    }

    this.logger.log(
      `Sync scheduled at: ${hours.map((h) => `${h}:00`).join(', ')}`,
    );
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string; value: string }): void {
    if (payload.key === 'check_schedule') {
      this.logger.log('Check schedule setting changed, reloading schedule...');
      this.updateScheduleFromHours(payload.value);
    }
  }

  async syncAll(): Promise<{
    status: SyncStatus;
    messageCount: number;
  }> {
    const startedAt = new Date();
    this.logger.log('Starting sync...');

    // Allow one WhatsApp reconnect attempt per sync cycle
    this.whatsappService.resetReconnectFlag();

    const children = await this.childService.findAll();

    if (children.length === 0) {
      this.logger.warn('No children configured, skipping sync');
      const endedAt = new Date();
      const syncLog = await this.syncLogRepository.create({
        status: SyncStatus.SUCCESS,
        messageCount: 0,
        eventsCreated: 0,
        startedAt,
        endedAt,
        channelDetails: [],
      });
      this.eventEmitter.emit('sync.completed', {
        syncLogId: syncLog.id,
        status: SyncStatus.SUCCESS,
        messageCount: 0,
      });
      return { status: SyncStatus.SUCCESS, messageCount: 0 };
    }

    let totalMessages = 0;
    let successCount = 0;
    let failureCount = 0;
    const allChannelDetails: ChannelSyncDetail[] = [];

    for (const child of children) {
      try {
        const result = await this.withRetry(
          () => this.syncChild(child),
          `Sync child "${child.name}"`,
        );
        totalMessages += result.messageCount;
        allChannelDetails.push(...result.channelDetails);
        successCount++;
        this.logger.log(
          `Child "${child.name}" synced successfully: ${result.messageCount} messages`,
        );
      } catch (error) {
        failureCount++;
        this.logger.error(
          `Sync for child "${child.name}" failed after ${MAX_RETRIES} retries: ${error.message}`,
        );
      }
    }

    let status: SyncStatus;
    if (failureCount === 0) {
      status = SyncStatus.SUCCESS;
    } else if (successCount > 0) {
      status = SyncStatus.PARTIAL;
    } else {
      status = SyncStatus.FAILED;
    }

    const endedAt = new Date();
    const syncLog = await this.syncLogRepository.create({
      status,
      messageCount: totalMessages,
      eventsCreated: 0,
      startedAt,
      endedAt,
      channelDetails: allChannelDetails,
    });

    this.eventEmitter.emit('sync.completed', {
      syncLogId: syncLog.id,
      status,
      messageCount: totalMessages,
    });

    // Keep only the 100 most recent messages in the database
    const pruned = await this.messageRepository.pruneOldest(100);
    if (pruned > 0) {
      this.logger.log(`Pruned ${pruned} old messages (keeping latest 100)`);
    }

    this.logger.log(
      `Sync completed: ${status}, ${totalMessages} messages fetched (${successCount} children succeeded, ${failureCount} failed)`,
    );

    return { status, messageCount: totalMessages };
  }

  async syncChild(child: ChildEntity): Promise<{
    messageCount: number;
    channelDetails: ChannelSyncDetail[];
  }> {
    const scanSince = this.determineScanWindow(child);
    this.logger.log(
      `Syncing child "${child.name}": lastScanAt=${child.lastScanAt?.toISOString() ?? 'null'}, scanSince=${scanSince.toISOString()}`,
    );
    let totalMessages = 0;
    const channelDetails: ChannelSyncDetail[] = [];

    // Sync WhatsApp channels for this child
    const whatsappResult = await this.syncChildWhatsApp(child, scanSince);
    totalMessages += whatsappResult.messageCount;
    channelDetails.push(...whatsappResult.channelDetails);

    // Sync Gmail for this child
    const gmailResult = await this.syncChildGmail(child, scanSince);
    totalMessages += gmailResult.messageCount;
    channelDetails.push(...gmailResult.channelDetails);

    // Only skip lastScanAt update if ALL channels failed (total sync failure).
    // Individual channel errors (e.g. channel not found) are logged but
    // shouldn't block progress for the channels that succeeded.
    const allFailed =
      channelDetails.length > 0 &&
      channelDetails.every((ch) => ch.skipped);
    if (!allFailed) {
      await this.childService.update(child.id, { lastScanAt: new Date() });
    } else {
      this.logger.warn(
        `Not updating lastScanAt for child "${child.name}" — all channels failed`,
      );
    }

    return { messageCount: totalMessages, channelDetails };
  }

  private determineScanWindow(child: ChildEntity): Date {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now);
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    if (!child.lastScanAt) {
      return twentyFourHoursAgo;
    }

    const seventyTwoHoursAgo = new Date(now);
    seventyTwoHoursAgo.setHours(seventyTwoHoursAgo.getHours() - 72);

    if (child.lastScanAt < seventyTwoHoursAgo) {
      return twentyFourHoursAgo;
    }

    return child.lastScanAt;
  }

  private async syncChildWhatsApp(
    child: ChildEntity,
    since: Date,
  ): Promise<{ messageCount: number; channelDetails: ChannelSyncDetail[] }> {
    const channelDetails: ChannelSyncDetail[] = [];

    if (!child.channelNames) {
      return { messageCount: 0, channelDetails };
    }

    const channels = child.channelNames
      .split(',')
      .map((ch) => ch.trim())
      .filter((ch) => ch.length > 0);

    if (channels.length === 0) {
      return { messageCount: 0, channelDetails };
    }

    let isConnected = this.whatsappService.isConnected();
    if (!isConnected) {
      this.logger.log('WhatsApp not connected, attempting to initialize...');
      try {
        await this.whatsappService.initialize();
        isConnected = this.whatsappService.isConnected();
      } catch {
        this.logger.warn('WhatsApp initialization failed during sync');
      }
    }
    if (!isConnected) {
      this.logger.warn(
        `WhatsApp not connected, skipping WhatsApp sync for child "${child.name}"`,
      );
      const now = new Date().toISOString();
      for (const channel of channels) {
        channelDetails.push({
          childName: child.name,
          channelName: channel,
          messagesFound: 0,
          skipped: true,
          skipReason: 'WhatsApp not connected',
          startedAt: now,
          endedAt: now,
        });
      }
      return { messageCount: 0, channelDetails };
    }

    let totalMessages = 0;

    for (const channel of channels) {
      const channelStartedAt = new Date().toISOString();

      try {
        // Get the timestamp of the last scanned message for this channel
        const lastTimestamp =
          await this.messageRepository.getLastTimestamp(channel, child.id);
        const cutoff = lastTimestamp ?? since;

        const messages =
          await this.whatsappService.getChannelMessages(channel);

        this.logger.log(
          `Channel "${channel}" (child "${child.name}"): fetched ${messages.length} messages, cutoff=${cutoff.toISOString()}, lastTimestamp=${lastTimestamp?.toISOString() ?? 'null'}` +
          (messages.length > 0
            ? `, oldest=${messages[messages.length - 1]?.timestamp.toISOString()}, newest=${messages[0]?.timestamp.toISOString()}`
            : ''),
        );

        let channelMessageCount = 0;
        const channelMessages: { sender: string; content: string; timestamp: string }[] = [];
        // Count all relevant messages fetched (excluding app messages)
        const relevantMessages = messages.filter(
          (msg) => !msg.content.includes('— ParentSync'),
        );
        for (const msg of relevantMessages) {
          // Only store messages newer than the cutoff
          if (msg.timestamp < cutoff) {
            continue;
          }
          // Deduplicate: skip if exact same message already stored
          const isDuplicate = await this.messageRepository.existsByChannelTimestampContent(
            channel,
            child.id,
            msg.timestamp,
            msg.content,
          );
          if (!isDuplicate) {
            await this.messageRepository.create({
              source: MessageSource.WHATSAPP,
              content: msg.content,
              timestamp: msg.timestamp,
              sender: msg.sender,
              channel: msg.channel,
              childId: child.id,
              parsed: false,
            });
            channelMessageCount++;
            channelMessages.push({
              sender: msg.sender,
              content: msg.content,
              timestamp: msg.timestamp.toISOString(),
            });
          }
        }

        totalMessages += relevantMessages.length;
        channelDetails.push({
          childName: child.name,
          channelName: channel,
          messagesFound: relevantMessages.length,
          skipped: false,
          startedAt: channelStartedAt,
          endedAt: new Date().toISOString(),
          messages: channelMessages,
        });
      } catch (error) {
        channelDetails.push({
          childName: child.name,
          channelName: channel,
          messagesFound: 0,
          skipped: true,
          skipReason: `Error: ${error.message}`,
          startedAt: channelStartedAt,
          endedAt: new Date().toISOString(),
        });
        this.logger.warn(
          `Failed to sync WhatsApp channel "${channel}" for child "${child.name}": ${error.message}`,
        );
      }
    }

    return { messageCount: totalMessages, channelDetails };
  }

  private async syncChildGmail(
    child: ChildEntity,
    since: Date,
  ): Promise<{ messageCount: number; channelDetails: ChannelSyncDetail[] }> {
    const channelDetails: ChannelSyncDetail[] = [];

    if (!child.teacherEmails) {
      return { messageCount: 0, channelDetails };
    }

    const emails = child.teacherEmails
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);

    if (emails.length === 0) {
      return { messageCount: 0, channelDetails };
    }

    const channelStartedAt = new Date().toISOString();

    // Format the date as YYYY/MM/DD for Gmail query
    const year = since.getFullYear();
    const month = String(since.getMonth() + 1).padStart(2, '0');
    const day = String(since.getDate()).padStart(2, '0');
    const afterDate = `${year}/${month}/${day}`;

    const fromFilter = emails.join(' OR ');
    const query = `from:(${fromFilter}) after:${afterDate}`;

    const fetchedEmails = await this.gmailService.getEmails(undefined, query);
    let totalMessages = 0;
    const gmailMessages: { sender: string; content: string; timestamp: string }[] = [];

    for (const email of fetchedEmails) {
      // Get the timestamp of the last scanned email for this label
      const lastTimestamp =
        await this.messageRepository.getLastTimestamp(email.label, child.id);
      const cutoff = lastTimestamp ?? since;

      // Only store emails newer than the last scanned email
      if (email.timestamp > cutoff) {
        const content = `${email.subject}\n\n${email.body}`;
        await this.messageRepository.create({
          source: MessageSource.EMAIL,
          content,
          timestamp: email.timestamp,
          sender: email.sender,
          channel: email.label,
          childId: child.id,
          parsed: false,
        });
        totalMessages++;
        gmailMessages.push({
          sender: email.sender,
          content,
          timestamp: email.timestamp.toISOString(),
        });
      }
    }

    if (fetchedEmails.length > 0 || emails.length > 0) {
      channelDetails.push({
        childName: child.name,
        channelName: `Gmail (${emails.join(', ')})`,
        messagesFound: fetchedEmails.length,
        skipped: false,
        startedAt: channelStartedAt,
        endedAt: new Date().toISOString(),
        messages: gmailMessages,
      });
    }

    return { messageCount: fetchedEmails.length, channelDetails };
  }

  async getSyncLogs(limit = 20) {
    return this.syncLogRepository.findRecent(limit);
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `${label} attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS * attempt),
          );
        }
      }
    }

    throw lastError;
  }
}

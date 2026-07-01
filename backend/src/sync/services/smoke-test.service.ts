import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IWhatsAppService } from '../../messages/interfaces/whatsapp-service.interface';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import type { IEventRepository } from '../../calendar/interfaces/event-repository.interface';
import type { IGoogleCalendarService } from '../../calendar/interfaces/google-calendar-service.interface';
import { EventSyncService } from './event-sync.service';
import { ApprovalService } from './approval.service';
import { SettingsService } from '../../settings/settings.service';
import { MessageSource } from '../../shared/enums/message-source.enum';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';
import {
  SMOKE_TEST_MARKER,
  SMOKE_TEST_ENABLED_KEY,
  SMOKE_TEST_LAST_VERSION_KEY,
  SMOKE_TEST_CRON_JOB,
  SMOKE_TEST_CRON_EXPRESSION,
  SmokeTestResult,
  SmokeTestStep,
  SmokeTestTrigger,
} from '../../shared/constants/smoke-test';

/** How long after startup to fire the deploy-triggered run (WhatsApp/Google need to connect). */
const DEPLOY_RUN_DELAY_MS = 60_000;
/** Poll budget for the message to appear in the scrape after sending. */
const SCRAPE_POLL_MS = 12_000;
/** Poll budget for the 👍 reaction round-trip to approve + sync the event. */
const REACTION_POLL_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;

@Injectable()
export class SmokeTestService implements OnModuleInit {
  private readonly logger = new Logger(SmokeTestService.name);
  private running = false;

  // Timing knobs (overridable in tests to avoid real-time waits).
  protected deployRunDelayMs = DEPLOY_RUN_DELAY_MS;
  protected scrapePollMs = SCRAPE_POLL_MS;
  protected reactionPollMs = REACTION_POLL_MS;
  protected pollIntervalMs = POLL_INTERVAL_MS;

  constructor(
    @Inject(WHATSAPP_SERVICE)
    private readonly whatsappService: IWhatsAppService,
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    @Inject(forwardRef(() => EventSyncService))
    private readonly eventSyncService: EventSyncService,
    @Inject(forwardRef(() => ApprovalService))
    private readonly approvalService: ApprovalService,
    private readonly settingsService: SettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.settingsService.seedDefaultIfMissing(SMOKE_TEST_ENABLED_KEY, 'true');
    if (await this.isEnabled()) {
      this.registerCron();
    }
    await this.maybeScheduleDeployRun();
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string; value: string }): void {
    if (payload.key !== SMOKE_TEST_ENABLED_KEY) return;
    if (payload.value.toLowerCase() === 'true') {
      this.registerCron();
    } else {
      this.deregisterCron();
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private registerCron(): void {
    if (this.schedulerRegistry.doesExist('cron', SMOKE_TEST_CRON_JOB)) {
      return;
    }
    const job = new CronJob(SMOKE_TEST_CRON_EXPRESSION, () => {
      this.run('cron').catch((err) =>
        this.logger.error(`Scheduled smoke test failed: ${err.message}`),
      );
    });
    this.schedulerRegistry.addCronJob(SMOKE_TEST_CRON_JOB, job);
    job.start();
    this.logger.log(`Smoke test scheduled daily at 07:00`);
  }

  private deregisterCron(): void {
    if (this.schedulerRegistry.doesExist('cron', SMOKE_TEST_CRON_JOB)) {
      this.schedulerRegistry.deleteCronJob(SMOKE_TEST_CRON_JOB);
      this.logger.log('Smoke test cron removed (disabled)');
    }
  }

  /** Run once after a version change (new deployment). */
  private async maybeScheduleDeployRun(): Promise<void> {
    if (!(await this.isEnabled())) return;
    const currentVersion = process.env.APP_VERSION || 'unknown';
    let lastVersion: string | null = null;
    try {
      lastVersion = (
        await this.settingsService.findByKey(SMOKE_TEST_LAST_VERSION_KEY)
      ).value;
    } catch {
      lastVersion = null;
    }
    if (lastVersion === currentVersion) return;

    this.logger.log(
      `New deployment detected (${lastVersion ?? 'none'} → ${currentVersion}); smoke test will run in ${this.deployRunDelayMs / 1000}s`,
    );
    setTimeout(() => {
      this.run('deploy')
        .catch((err) =>
          this.logger.error(`Deploy smoke test failed: ${err.message}`),
        )
        .finally(() => {
          // Mark this version as tested regardless of pass/fail so we don't
          // re-run on the next restart of the same build.
          this.settingsService
            .create({ key: SMOKE_TEST_LAST_VERSION_KEY, value: currentVersion })
            .catch(() => undefined);
        });
    }, this.deployRunDelayMs).unref?.();
  }

  // ---------------------------------------------------------------------------
  // The test run
  // ---------------------------------------------------------------------------

  async run(trigger: SmokeTestTrigger): Promise<SmokeTestResult> {
    if (this.running) {
      return this.buildSkip(trigger, 'A smoke test is already running');
    }
    this.running = true;
    const runId = `smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date();
    const steps: SmokeTestStep[] = [];
    const result: SmokeTestResult = {
      runId,
      trigger,
      status: 'passed',
      startedAt: startedAt.toISOString(),
      endedAt: startedAt.toISOString(),
      steps,
    };

    this.logger.log(`Smoke test starting (trigger=${trigger}, runId=${runId})`);

    try {
      // --- Preconditions -----------------------------------------------------
      if (!(await this.isEnabled())) {
        return this.finish(result, 'skipped', 'Smoke test disabled');
      }
      const channel = await this.getApprovalChannel();
      if (!channel) {
        return this.finish(result, 'skipped', 'No approval_channel configured');
      }
      if (!this.whatsappService.isConnected()) {
        return this.finish(result, 'skipped', 'WhatsApp not connected');
      }

      const calendarId = await this.getCalendarId();
      const tomorrow = this.tomorrowDate();
      const sourceContent = this.buildTestMessage(runId, tomorrow);

      // --- Step 1: send the test message ------------------------------------
      result.sourceMessageId = await this.step(steps, 'send-message', () =>
        this.whatsappService.sendMessage(channel, sourceContent),
      );

      // --- Step 2: ingest (scrape back + store + run real event pipeline) ----
      await this.step(steps, 'ingest', async () => {
        await this.scrapeAndStore(channel, runId);
        await this.eventSyncService.syncEvents();
        return 'pipeline ran';
      });

      // --- Step 3: verify message stored ------------------------------------
      await this.step(steps, 'verify-message', async () => {
        const stored = await this.findStoredMessage(runId);
        if (!stored) throw new Error('Test message was not stored');
        return `messageId=${stored.id}`;
      });

      // --- Step 4: verify event created -------------------------------------
      let event!: CalendarEventEntity;
      await this.step(steps, 'verify-event', async () => {
        const ev = await this.findEventByRunId(runId);
        if (!ev) {
          throw new Error(
            'No event created from the test message — LLM parse / classifier / quota failure',
          );
        }
        if (!ev.approvalMessageId) {
          throw new Error(`Event ${ev.id} created but no approval card was sent`);
        }
        event = ev;
        result.eventId = ev.id;
        result.approvalMessageId = ev.approvalMessageId;
        return `eventId=${ev.id} status=${ev.approvalStatus} title="${ev.title}"`;
      });

      // --- Step 5: react 👍 and verify approval → calendar ------------------
      await this.step(steps, 'react-and-approve', async () => {
        await this.whatsappService.reactToMessage(event.approvalMessageId, '👍');
        let approved = await this.pollEventApproved(event.id, this.reactionPollMs);
        if (!approved) {
          // The self-reaction round-trip did not fire — drive the handler
          // directly so the approve → calendar path is still verified.
          this.logger.warn(
            'Self-reaction round-trip did not approve the event; invoking handler directly',
          );
          await this.approvalService.handleReaction({
            msgId: event.approvalMessageId,
            reaction: '👍',
            senderId: 'smoke-test',
            timestamp: Date.now(),
          });
          approved = await this.pollEventApproved(event.id, this.pollIntervalMs * 5);
        }
        if (!approved) {
          throw new Error('Event was not approved/synced after 👍 reaction');
        }
        event = approved;
        result.googleEventId = approved.googleEventId;
        return `googleEventId=${approved.googleEventId}`;
      });

      // --- Step 6: verify the event really exists in Google Calendar --------
      await this.step(steps, 'verify-calendar', async () => {
        if (!event.googleEventId) {
          throw new Error('Approved event has no googleEventId');
        }
        const exists = await this.googleCalendarService.eventExists(
          event.googleEventId,
          calendarId,
        );
        if (!exists) {
          throw new Error(
            `Google Calendar event ${event.googleEventId} not found`,
          );
        }
        return 'event present in Google Calendar';
      });

      return this.finish(result, 'passed');
    } catch (error) {
      result.failedStep = steps.find((s) => !s.ok)?.name;
      this.logger.error(
        `Smoke test FAILED at step "${result.failedStep}": ${(error as Error).message}`,
      );
      return this.finish(result, 'failed');
    } finally {
      await this.cleanup(result);
      // cleanup() runs after finish() already persisted the result, so
      // re-persist to capture the teardown outcomes (and any FAIL log).
      this.persistResult(result);
      this.running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Step helpers
  // ---------------------------------------------------------------------------

  private async step<T>(
    steps: SmokeTestStep[],
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    try {
      const value = await fn();
      steps.push({
        name,
        ok: true,
        durationMs: Date.now() - start,
        detail: typeof value === 'string' ? value : undefined,
      });
      return value;
    } catch (error) {
      steps.push({
        name,
        ok: false,
        durationMs: Date.now() - start,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /** Scrape the channel until the marked message shows up, then store it. */
  private async scrapeAndStore(channel: string, runId: string): Promise<void> {
    const deadline = Date.now() + this.scrapePollMs;
    while (Date.now() < deadline) {
      const messages = await this.whatsappService.getChannelMessages(channel);
      const match = messages.find((m) => m.content.includes(runId));
      if (match) {
        const exists =
          await this.messageRepository.existsByChannelTimestampContent(
            channel,
            '',
            match.timestamp,
            match.content,
          );
        if (!exists) {
          await this.messageRepository.create({
            source: MessageSource.WHATSAPP,
            content: match.content,
            timestamp: match.timestamp,
            sender: match.sender,
            channel: match.channel,
            childId: undefined,
            parsed: false,
          });
        }
        return;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error('Test message did not appear in the channel scrape');
  }

  private async findStoredMessage(runId: string) {
    const all = await this.messageRepository.findAll();
    return all.find((m) => m.content.includes(runId)) ?? null;
  }

  private async findEventByRunId(
    runId: string,
  ): Promise<CalendarEventEntity | null> {
    const all = await this.eventRepository.findAll();
    return all.find((e) => e.sourceContent?.includes(runId)) ?? null;
  }

  private async pollEventApproved(
    eventId: string,
    budgetMs: number,
  ): Promise<CalendarEventEntity | null> {
    const deadline = Date.now() + budgetMs;
    do {
      const ev = await this.eventRepository.findById(eventId);
      if (
        ev &&
        ev.approvalStatus === ApprovalStatus.APPROVED &&
        ev.googleEventId
      ) {
        return ev;
      }
      await this.sleep(this.pollIntervalMs);
    } while (Date.now() < deadline);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Cleanup — always runs, every step isolated and non-fatal.
  // ---------------------------------------------------------------------------

  private async cleanup(result: SmokeTestResult): Promise<void> {
    const steps: SmokeTestStep[] = [];
    result.cleanup = steps;
    const calendarId = await this.getCalendarId().catch(() => 'primary');

    if (result.googleEventId) {
      await this.tryCleanup(steps, 'delete-google-event', () =>
        this.googleCalendarService.deleteEvent(result.googleEventId!, calendarId),
      );
    }
    if (result.eventId) {
      await this.tryCleanup(steps, 'delete-local-event', () =>
        this.eventRepository.delete(result.eventId!),
      );
    }
    // Re-find the stored message by runId in case its id wasn't captured.
    const stored = await this.findStoredMessage(result.runId).catch(() => null);
    if (stored) {
      await this.tryCleanup(steps, 'delete-local-message', () =>
        this.messageRepository.delete(stored.id),
      );
    }
    if (result.approvalMessageId) {
      await this.tryCleanup(steps, 'delete-approval-message', () =>
        this.whatsappService.deleteMessage(result.approvalMessageId!),
      );
    }
    if (result.sourceMessageId) {
      await this.tryCleanup(steps, 'delete-source-message', () =>
        this.whatsappService.deleteMessage(result.sourceMessageId!),
      );
    }

    result.cleanupFailed = steps.some((s) => !s.ok);
    if (result.cleanupFailed) {
      const failed = steps.filter((s) => !s.ok).map((s) => s.name).join(', ');
      this.logger.warn(
        `Smoke test cleanup left artifacts behind (failed: ${failed})`,
      );
    }
  }

  private async tryCleanup(
    steps: SmokeTestStep[],
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    const start = Date.now();
    try {
      await fn();
      steps.push({ name, ok: true, durationMs: Date.now() - start });
    } catch (error) {
      steps.push({
        name,
        ok: false,
        durationMs: Date.now() - start,
        error: (error as Error).message,
      });
      this.logger.warn(`Cleanup "${name}" failed: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Result + persistence
  // ---------------------------------------------------------------------------

  private finish(
    result: SmokeTestResult,
    status: SmokeTestResult['status'],
    skipReason?: string,
  ): SmokeTestResult {
    result.status = status;
    result.endedAt = new Date().toISOString();
    if (skipReason) result.skipReason = skipReason;
    this.persistResult(result);
    this.logger.log(
      `Smoke test ${status.toUpperCase()} (runId=${result.runId}${skipReason ? `, ${skipReason}` : ''})`,
    );
    return result;
  }

  private buildSkip(
    trigger: SmokeTestTrigger,
    reason: string,
  ): SmokeTestResult {
    const now = new Date().toISOString();
    const result: SmokeTestResult = {
      runId: `smoke-${Date.now()}`,
      trigger,
      status: 'skipped',
      startedAt: now,
      endedAt: now,
      skipReason: reason,
      steps: [],
    };
    this.persistResult(result);
    return result;
  }

  private persistResult(result: SmokeTestResult): void {
    const dir = this.logDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'latest.json'),
        JSON.stringify(result, null, 2),
      );
      if (result.status === 'failed' || result.cleanupFailed) {
        const stamp = result.startedAt.replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(dir, `smoke-test-${stamp}-FAIL.log`),
          this.formatFailLog(result),
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to write smoke-test log: ${(error as Error).message}`,
      );
    }
  }

  private formatFailLog(result: SmokeTestResult): string {
    const headline =
      result.status === 'failed'
        ? 'FAILED'
        : 'PASSED but cleanup left artifacts behind';
    const lines = [
      `ParentSync smoke test — ${headline}`,
      `runId:        ${result.runId}`,
      `trigger:      ${result.trigger}`,
      `startedAt:    ${result.startedAt}`,
      `endedAt:      ${result.endedAt}`,
      `status:       ${result.status}`,
      `failedStep:   ${result.failedStep ?? '(none)'}`,
      `cleanupOk:    ${result.cleanupFailed ? 'NO' : 'yes'}`,
      `sourceMsgId:  ${result.sourceMessageId ?? '-'}`,
      `approvalMsg:  ${result.approvalMessageId ?? '-'}`,
      `eventId:      ${result.eventId ?? '-'}`,
      `googleEvent:  ${result.googleEventId ?? '-'}`,
      ``,
      `Steps:`,
    ];
    for (const s of result.steps) {
      lines.push(this.formatStepLine(s));
    }
    if (result.cleanup?.length) {
      lines.push('', 'Cleanup:');
      for (const s of result.cleanup) {
        lines.push(this.formatStepLine(s));
      }
    }
    lines.push('', 'Raw result:', JSON.stringify(result, null, 2));
    return lines.join('\n');
  }

  private formatStepLine(s: SmokeTestStep): string {
    return (
      `  [${s.ok ? 'OK ' : 'ERR'}] ${s.name} (${s.durationMs}ms)` +
      (s.detail ? ` — ${s.detail}` : '') +
      (s.error ? ` — ERROR: ${s.error}` : '')
    );
  }

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  getLastResult(): SmokeTestResult | null {
    try {
      const file = path.join(this.logDir(), 'latest.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as SmokeTestResult;
    } catch {
      return null;
    }
  }

  private logDir(): string {
    return path.join(process.env.LOG_DIR || os.tmpdir(), 'smoke-test');
  }

  private buildTestMessage(runId: string, date: string): string {
    // Crystal-clear single event so the classifier + extractor reliably fire.
    // Must NOT contain the "— ParentSync" app marker (it would be filtered).
    return (
      `בדיקת מערכת אוטומטית: אסיפת הורים לכיתת בדיקה ` +
      `בתאריך ${date} בשעה 17:00 בכיתה.\n` +
      `${SMOKE_TEST_MARKER} ${runId}`
    );
  }

  private tomorrowDate(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  private async isEnabled(): Promise<boolean> {
    try {
      const s = await this.settingsService.findByKey(SMOKE_TEST_ENABLED_KEY);
      return s.value.toLowerCase() !== 'false';
    } catch {
      return true;
    }
  }

  private async getApprovalChannel(): Promise<string | null> {
    try {
      const s = await this.settingsService.findByKey('approval_channel');
      return s.value?.trim() || null;
    } catch {
      return null;
    }
  }

  private async getCalendarId(): Promise<string> {
    try {
      const s = await this.settingsService.findByKey('google_calendar_id');
      return s.value || 'primary';
    } catch {
      return 'primary';
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

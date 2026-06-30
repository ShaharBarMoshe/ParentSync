import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SmokeTestService } from './smoke-test.service';
import { EventSyncService } from './event-sync.service';
import { ApprovalService } from './approval.service';
import { SettingsService } from '../../settings/settings.service';
import {
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';

describe('SmokeTestService', () => {
  let service: SmokeTestService;
  let whatsappService: any;
  let messageRepository: any;
  let eventRepository: any;
  let googleCalendarService: any;
  let eventSyncService: any;
  let approvalService: any;
  let settingsService: any;
  let logDir: string;

  // Captures the content of the last sent message so the scrape mock can echo
  // it back (the runId is generated inside run()).
  let lastSent = '';

  const settingsValues: Record<string, string> = {
    smoke_test_enabled: 'true',
    approval_channel: 'Test Channel',
  };

  beforeEach(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-smoke-'));
    process.env.LOG_DIR = logDir;
    lastSent = '';

    whatsappService = {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn().mockImplementation((_chan: string, text: string) => {
        lastSent = text;
        return Promise.resolve('src-msg-1');
      }),
      getChannelMessages: jest.fn().mockImplementation(() =>
        Promise.resolve([
          {
            content: lastSent,
            timestamp: new Date(),
            sender: 'me',
            channel: 'Test Channel',
          },
        ]),
      ),
      reactToMessage: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    messageRepository = {
      existsByChannelTimestampContent: jest.fn().mockResolvedValue(false),
      create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      findAll: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve([{ id: 'msg-1', content: lastSent }]),
        ),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // Default: the event is found PENDING, then approved on the first poll.
    eventRepository = {
      findAll: jest.fn().mockImplementation(() =>
        Promise.resolve([
          {
            id: 'ev-1',
            sourceContent: lastSent,
            title: 'אסיפת הורים',
            approvalStatus: ApprovalStatus.PENDING,
            approvalMessageId: 'appr-1',
          },
        ]),
      ),
      findById: jest.fn().mockResolvedValue({
        id: 'ev-1',
        approvalStatus: ApprovalStatus.APPROVED,
        googleEventId: 'g-1',
      }),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    googleCalendarService = {
      eventExists: jest.fn().mockResolvedValue(true),
      deleteEvent: jest.fn().mockResolvedValue(true),
    };

    eventSyncService = { syncEvents: jest.fn().mockResolvedValue(undefined) };
    approvalService = { handleReaction: jest.fn().mockResolvedValue(undefined) };

    settingsService = {
      seedDefaultIfMissing: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      findByKey: jest.fn().mockImplementation((key: string) => {
        if (settingsValues[key] !== undefined) {
          return Promise.resolve({ key, value: settingsValues[key] });
        }
        return Promise.reject(new Error(`not found: ${key}`));
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmokeTestService,
        { provide: WHATSAPP_SERVICE, useValue: whatsappService },
        { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
        { provide: EVENT_REPOSITORY, useValue: eventRepository },
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: googleCalendarService },
        { provide: EventSyncService, useValue: eventSyncService },
        { provide: ApprovalService, useValue: approvalService },
        { provide: SettingsService, useValue: settingsService },
        { provide: SchedulerRegistry, useValue: { doesExist: jest.fn() } },
      ],
    }).compile();

    service = module.get<SmokeTestService>(SmokeTestService);
    // Shrink timing so polls never wait on real wall-clock.
    (service as any).reactionPollMs = 20;
    (service as any).pollIntervalMs = 1;
    (service as any).scrapePollMs = 50;
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('passes the full happy-path and cleans up', async () => {
    const result = await service.run('manual');

    expect(result.status).toBe('passed');
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(whatsappService.sendMessage).toHaveBeenCalled();
    expect(whatsappService.reactToMessage).toHaveBeenCalledWith('appr-1', '👍');
    expect(eventSyncService.syncEvents).toHaveBeenCalled();
    expect(googleCalendarService.eventExists).toHaveBeenCalledWith('g-1', 'primary');

    // Cleanup ran for both calendar + whatsapp.
    expect(googleCalendarService.deleteEvent).toHaveBeenCalledWith('g-1', 'primary');
    expect(eventRepository.delete).toHaveBeenCalledWith('ev-1');
    expect(messageRepository.delete).toHaveBeenCalledWith('msg-1');
    expect(whatsappService.deleteMessage).toHaveBeenCalledWith('appr-1');
    expect(whatsappService.deleteMessage).toHaveBeenCalledWith('src-msg-1');

    // latest.json written, no FAIL log.
    expect(fs.existsSync(path.join(logDir, 'smoke-test', 'latest.json'))).toBe(true);
  });

  it('skips when disabled', async () => {
    settingsValues.smoke_test_enabled = 'false';
    const result = await service.run('manual');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toMatch(/disabled/i);
    expect(whatsappService.sendMessage).not.toHaveBeenCalled();
    settingsValues.smoke_test_enabled = 'true';
  });

  it('skips when no approval channel is configured', async () => {
    settingsService.findByKey.mockImplementation((key: string) =>
      key === 'smoke_test_enabled'
        ? Promise.resolve({ key, value: 'true' })
        : Promise.reject(new Error('not found')),
    );
    const result = await service.run('manual');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toMatch(/approval_channel/i);
  });

  it('skips when WhatsApp is disconnected', async () => {
    whatsappService.isConnected.mockReturnValue(false);
    const result = await service.run('manual');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toMatch(/not connected/i);
  });

  it('fails and writes a FAIL log when no event is created', async () => {
    eventRepository.findAll.mockResolvedValue([]);
    const result = await service.run('manual');

    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('verify-event');

    // Cleanup still ran (source message + stored message).
    expect(messageRepository.delete).toHaveBeenCalled();
    expect(whatsappService.deleteMessage).toHaveBeenCalledWith('src-msg-1');

    const failLogs = fs
      .readdirSync(path.join(logDir, 'smoke-test'))
      .filter((f) => f.endsWith('-FAIL.log'));
    expect(failLogs.length).toBe(1);
  });

  it('falls back to the reaction handler when the round-trip does not approve', async () => {
    let approved = false;
    approvalService.handleReaction.mockImplementation(() => {
      approved = true;
      return Promise.resolve();
    });
    eventRepository.findById.mockImplementation(() =>
      Promise.resolve(
        approved
          ? { id: 'ev-1', approvalStatus: ApprovalStatus.APPROVED, googleEventId: 'g-1' }
          : { id: 'ev-1', approvalStatus: ApprovalStatus.PENDING, googleEventId: null },
      ),
    );

    const result = await service.run('manual');

    expect(approvalService.handleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ msgId: 'appr-1', reaction: '👍' }),
    );
    expect(result.status).toBe('passed');
  });

  it('does not start a second run while one is in progress', async () => {
    (service as any).running = true;
    const result = await service.run('cron');
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toMatch(/already running/i);
  });
});

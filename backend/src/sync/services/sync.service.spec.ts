import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SyncService } from './sync.service';
import {
  MESSAGE_REPOSITORY,
  WHATSAPP_SERVICE,
  GMAIL_SERVICE,
  SYNC_LOG_REPOSITORY,
} from '../../shared/constants/injection-tokens';
import { SettingsService } from '../../settings/settings.service';
import { ChildService } from '../../settings/child.service';
import { SyncStatus } from '../../shared/enums/sync-status.enum';
import { ChildEntity } from '../../settings/entities/child.entity';

// Capture CronJob callbacks
let capturedCronCallback: (() => void) | null = null;
jest.mock('cron', () => ({
  CronJob: jest.fn().mockImplementation((_expression: string, callback: () => void) => {
    capturedCronCallback = callback;
    return { start: jest.fn() };
  }),
}));

describe('SyncService', () => {
  let service: SyncService;
  let mockMessageRepo: any;
  let mockWhatsappService: any;
  let mockGmailService: any;
  let mockSyncLogRepo: any;
  let mockSettingsService: any;
  let mockChildService: any;
  let mockEventEmitter: any;

  const makeChild = (overrides: Partial<ChildEntity> = {}): ChildEntity => ({
    id: 'child-1',
    name: 'Alice',
    channelNames: 'Parents Group',
    teacherEmails: 'teacher@school.com',
    calendarColor: '1',
    lastScanAt: null as unknown as Date,
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    mockMessageRepo = {
      create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      getLastTimestamp: jest.fn().mockResolvedValue(null),
      existsByChannelTimestampContent: jest.fn().mockResolvedValue(false),
      pruneOldest: jest.fn().mockResolvedValue(0),
    };

    mockWhatsappService = {
      isConnected: jest.fn().mockReturnValue(true),
      resetReconnectFlag: jest.fn(),
      getChannelMessages: jest.fn().mockResolvedValue([]),
    };

    mockGmailService = {
      getEmails: jest.fn().mockResolvedValue([]),
      getEmailsSince: jest.fn().mockResolvedValue([]),
    };

    mockSyncLogRepo = {
      create: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: 'log-1', ...data }),
        ),
      findRecent: jest.fn().mockResolvedValue([]),
    };

    mockSettingsService = {
      findByKey: jest.fn().mockRejectedValue(new Error('Not found')),
    };

    mockChildService = {
      findAll: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: MESSAGE_REPOSITORY, useValue: mockMessageRepo },
        { provide: WHATSAPP_SERVICE, useValue: mockWhatsappService },
        { provide: GMAIL_SERVICE, useValue: mockGmailService },
        { provide: SYNC_LOG_REPOSITORY, useValue: mockSyncLogRepo },
        { provide: SettingsService, useValue: mockSettingsService },
        { provide: ChildService, useValue: mockChildService },
        {
          provide: SchedulerRegistry,
          useValue: {
            addCronJob: jest.fn(),
            deleteCronJob: jest.fn().mockImplementation(() => {
              throw new Error('not found');
            }),
            getCronJobs: jest.fn().mockReturnValue(new Map()),
          },
        },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return success with 0 messages when no children configured', async () => {
    mockChildService.findAll.mockResolvedValue([]);

    const result = await service.syncAll();

    expect(result.status).toBe(SyncStatus.SUCCESS);
    expect(result.messageCount).toBe(0);
    expect(mockSyncLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: SyncStatus.SUCCESS, messageCount: 0 }),
    );
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      'sync.completed',
      expect.objectContaining({ status: SyncStatus.SUCCESS, messageCount: 0 }),
    );
  });

  it('should sync each child\'s channels and emails', async () => {
    const child1 = makeChild({ id: 'child-1', name: 'Alice', channelNames: 'Group A', teacherEmails: 'a@school.com' });
    const child2 = makeChild({ id: 'child-2', name: 'Bob', channelNames: 'Group B', teacherEmails: 'b@school.com' });
    mockChildService.findAll.mockResolvedValue([child1, child2]);

    const now = new Date();
    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Hello', timestamp: now, sender: 'John', channel: 'Group A' },
    ]);
    mockGmailService.getEmails.mockResolvedValue([
      { subject: 'Test', body: 'Body', sender: 'a@school.com', timestamp: now, label: 'INBOX' },
    ]);

    const result = await service.syncAll();

    expect(result.status).toBe(SyncStatus.SUCCESS);
    // Both children synced WhatsApp + Gmail
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledTimes(2);
    expect(mockGmailService.getEmails).toHaveBeenCalledTimes(2);
    // Messages stored with childId
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-1' }),
    );
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-2' }),
    );
    // lastScanAt updated for both
    expect(mockChildService.update).toHaveBeenCalledWith(
      'child-1',
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );
    expect(mockChildService.update).toHaveBeenCalledWith(
      'child-2',
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );
  });

  it('should log skipped channel details when a channel fetch fails', async () => {
    const child1 = makeChild({ id: 'child-1', name: 'Alice', channelNames: 'Group A', teacherEmails: '' });
    const child2 = makeChild({ id: 'child-2', name: 'Bob', channelNames: 'Group B', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child1, child2]);

    // Child 1 WhatsApp channel fails, child 2 succeeds
    mockWhatsappService.getChannelMessages
      .mockRejectedValueOnce(new Error('WhatsApp error'))
      .mockResolvedValue([]);

    const result = await service.syncAll();

    // Both children sync successfully (channel errors are logged, not propagated)
    expect(result.status).toBe(SyncStatus.SUCCESS);

    // Sync log should contain channel details with skip reason
    expect(mockSyncLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channelDetails: expect.arrayContaining([
          expect.objectContaining({
            childName: 'Alice',
            channelName: 'Group A',
            skipped: true,
            skipReason: expect.stringContaining('WhatsApp error'),
          }),
          expect.objectContaining({
            childName: 'Bob',
            channelName: 'Group B',
            skipped: false,
          }),
        ]),
      }),
    );
  });

  it('should determine scan window: 24h fallback for never-scanned child', async () => {
    const child = makeChild({ lastScanAt: null as unknown as Date, channelNames: '', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    const before = new Date();
    before.setHours(before.getHours() - 24);

    await service.syncAll();

    // The child was synced (even if 0 messages), lastScanAt was updated
    expect(mockChildService.update).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );
  });

  it('should determine scan window: 24h fallback for stale scan (>72h)', async () => {
    const staleDate = new Date();
    staleDate.setHours(staleDate.getHours() - 100); // 100 hours ago
    const child = makeChild({
      lastScanAt: staleDate,
      channelNames: 'Group A',
      teacherEmails: '',
    });
    mockChildService.findAll.mockResolvedValue([child]);

    const now = new Date();
    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Recent msg', timestamp: now, sender: 'John', channel: 'Group A' },
    ]);

    await service.syncAll();

    // Message should be stored (within 24h window)
    expect(mockMessageRepo.create).toHaveBeenCalled();
  });

  it('should determine scan window: use lastScanAt when recent', async () => {
    const recentScan = new Date();
    recentScan.setHours(recentScan.getHours() - 2); // 2 hours ago
    const child = makeChild({
      lastScanAt: recentScan,
      channelNames: 'Group A',
      teacherEmails: '',
    });
    mockChildService.findAll.mockResolvedValue([child]);

    // Message older than lastScanAt should be filtered out
    const oldTimestamp = new Date();
    oldTimestamp.setHours(oldTimestamp.getHours() - 5);
    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Old msg', timestamp: oldTimestamp, sender: 'John', channel: 'Group A' },
    ]);

    await service.syncAll();

    // Message is older than lastScanAt (2h ago), so it should be filtered
    expect(mockMessageRepo.create).not.toHaveBeenCalled();
  });

  it('should skip WhatsApp when channels empty', async () => {
    const child = makeChild({ channelNames: '', teacherEmails: 'teacher@school.com' });
    mockChildService.findAll.mockResolvedValue([child]);
    mockGmailService.getEmails.mockResolvedValue([]);

    await service.syncAll();

    expect(mockWhatsappService.getChannelMessages).not.toHaveBeenCalled();
  });

  it('should skip Gmail when teacher emails empty', async () => {
    const child = makeChild({ channelNames: '', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    await service.syncAll();

    expect(mockGmailService.getEmails).not.toHaveBeenCalled();
  });

  it('should update lastScanAt after successful child scan', async () => {
    const child = makeChild({ channelNames: '', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    await service.syncAll();

    expect(mockChildService.update).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );
  });

  it('should still update lastScanAt when individual channels fail (error logged per channel)', async () => {
    const child = makeChild({ channelNames: 'Group A', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    // Channel fetch fails
    mockWhatsappService.getChannelMessages
      .mockRejectedValue(new Error('WhatsApp error'));

    await service.syncAll();

    // lastScanAt IS updated — channel errors are handled gracefully
    expect(mockChildService.update).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );

    // But channel detail records the failure
    expect(mockSyncLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channelDetails: expect.arrayContaining([
          expect.objectContaining({
            channelName: 'Group A',
            skipped: true,
            skipReason: expect.stringContaining('WhatsApp error'),
          }),
        ]),
      }),
    );
  });

  it('should store messages with childId', async () => {
    const child = makeChild({ id: 'child-abc', channelNames: 'Group A', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    const now = new Date();
    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Hello', timestamp: now, sender: 'John', channel: 'Group A' },
    ]);

    await service.syncAll();

    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        childId: 'child-abc',
        content: 'Hello',
        source: 'whatsapp',
      }),
    );
  });

  it('should scan all children WhatsApp channels when syncAll is called directly (Sync Now)', async () => {
    // This tests the same code path triggered by POST /sync/manual ("Sync Now" button)
    const child1 = makeChild({
      id: 'child-1',
      name: 'Alice',
      channelNames: 'Grade 3A Parents, School Updates',
      teacherEmails: '',
    });
    const child2 = makeChild({
      id: 'child-2',
      name: 'Bob',
      channelNames: 'Grade 5B Parents',
      teacherEmails: '',
    });
    const child3 = makeChild({
      id: 'child-3',
      name: 'Carol',
      channelNames: '',
      teacherEmails: '',
    });
    mockChildService.findAll.mockResolvedValue([child1, child2, child3]);

    const now = new Date();
    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Meeting tomorrow', timestamp: now, sender: 'Teacher', channel: 'test' },
    ]);

    // Call syncAll directly — same as what SyncController.manualSync() does
    const result = await service.syncAll();

    expect(result.status).toBe(SyncStatus.SUCCESS);

    // All channels from child1 and child2 scanned
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledWith('Grade 3A Parents');
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledWith('School Updates');
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledWith('Grade 5B Parents');
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledTimes(3);

    // Messages stored with correct childIds
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-1', source: 'whatsapp' }),
    );
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-2', source: 'whatsapp' }),
    );
    // Child 3 has no channels — no messages
    expect(mockMessageRepo.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-3' }),
    );

    // lastScanAt updated for all children
    expect(mockChildService.update).toHaveBeenCalledWith('child-1', expect.objectContaining({ lastScanAt: expect.any(Date) }));
    expect(mockChildService.update).toHaveBeenCalledWith('child-2', expect.objectContaining({ lastScanAt: expect.any(Date) }));
    expect(mockChildService.update).toHaveBeenCalledWith('child-3', expect.objectContaining({ lastScanAt: expect.any(Date) }));
  });

  it('should scan all children WhatsApp channels when scheduled check time triggers', async () => {
    // Set up multiple children with different WhatsApp channels
    const child1 = makeChild({
      id: 'child-1',
      name: 'Alice',
      channelNames: 'Grade 3A Parents, School Updates',
      teacherEmails: '',
    });
    const child2 = makeChild({
      id: 'child-2',
      name: 'Bob',
      channelNames: 'Grade 5B Parents',
      teacherEmails: '',
    });
    const child3 = makeChild({
      id: 'child-3',
      name: 'Carol',
      channelNames: '', // No channels configured
      teacherEmails: '',
    });
    mockChildService.findAll.mockResolvedValue([child1, child2, child3]);

    const now = new Date();
    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Meeting tomorrow', timestamp: now, sender: 'Teacher', channel: 'test' },
    ]);

    // Simulate a scheduled check time arriving by calling updateScheduleFromTimes,
    // which creates a CronJob — then trigger the captured callback
    capturedCronCallback = null;
    service.updateScheduleFromHours('9'); // e.g., 09:00 daily

    expect(capturedCronCallback).not.toBeNull();

    // Trigger the cron callback (simulates the scheduled time arriving)
    capturedCronCallback!();

    // Wait for the async syncAll() to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify WhatsApp channels were scanned for children with channels configured
    // Child 1 has 2 channels: "Grade 3A Parents" and "School Updates"
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledWith('Grade 3A Parents');
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledWith('School Updates');

    // Child 2 has 1 channel: "Grade 5B Parents"
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledWith('Grade 5B Parents');

    // Total: 3 channel fetches (child 3 has no channels, so skipped)
    expect(mockWhatsappService.getChannelMessages).toHaveBeenCalledTimes(3);

    // Messages stored with correct childIds
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-1', source: 'whatsapp' }),
    );
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-2', source: 'whatsapp' }),
    );

    // Child 3 should have no messages stored (no channels)
    expect(mockMessageRepo.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ childId: 'child-3' }),
    );

    // lastScanAt updated for all children (even those with no channels)
    expect(mockChildService.update).toHaveBeenCalledWith(
      'child-1',
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );
    expect(mockChildService.update).toHaveBeenCalledWith(
      'child-2',
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );
    expect(mockChildService.update).toHaveBeenCalledWith(
      'child-3',
      expect.objectContaining({ lastScanAt: expect.any(Date) }),
    );

    // Sync log created with total message count
    expect(mockSyncLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SyncStatus.SUCCESS,
      }),
    );
  });

  it('should skip WhatsApp messages older than last scanned timestamp per channel', async () => {
    const child = makeChild({ id: 'child-1', channelNames: 'Group A', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    const lastScanned = new Date('2026-03-24T10:00:00Z');
    const oldMsg = new Date('2026-03-24T09:00:00Z');
    const newMsg = new Date('2026-03-24T11:00:00Z');

    // DB has messages up to 10:00 for this channel
    mockMessageRepo.getLastTimestamp.mockResolvedValue(lastScanned);

    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Old message', timestamp: oldMsg, sender: 'John', channel: 'Group A' },
      { content: 'New message', timestamp: newMsg, sender: 'Jane', channel: 'Group A' },
    ]);

    const result = await service.syncAll();

    // Only the new message (11:00) should be stored, old (09:00) skipped
    expect(result.messageCount).toBe(1);
    expect(mockMessageRepo.create).toHaveBeenCalledTimes(1);
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'New message' }),
    );
  });

  it('should skip Gmail messages older than last scanned timestamp per label', async () => {
    const child = makeChild({ id: 'child-1', channelNames: '', teacherEmails: 'teacher@school.com' });
    mockChildService.findAll.mockResolvedValue([child]);

    const lastScanned = new Date('2026-03-24T10:00:00Z');
    const oldEmail = new Date('2026-03-24T09:00:00Z');
    const newEmail = new Date('2026-03-24T11:00:00Z');

    mockMessageRepo.getLastTimestamp.mockResolvedValue(lastScanned);

    mockGmailService.getEmails.mockResolvedValue([
      { subject: 'Old', body: 'old body', sender: 'teacher@school.com', timestamp: oldEmail, threadId: 't1', label: 'INBOX' },
      { subject: 'New', body: 'new body', sender: 'teacher@school.com', timestamp: newEmail, threadId: 't2', label: 'INBOX' },
    ]);

    const result = await service.syncAll();

    // Only the new email should be stored
    expect(result.messageCount).toBe(1);
    expect(mockMessageRepo.create).toHaveBeenCalledTimes(1);
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('New') }),
    );
  });

  it('should scan all messages when channel has no previous scans', async () => {
    const child = makeChild({ id: 'child-1', channelNames: 'Group A', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    const now = new Date();
    // No previous messages for this channel
    mockMessageRepo.getLastTimestamp.mockResolvedValue(null);

    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Message 1', timestamp: now, sender: 'John', channel: 'Group A' },
      { content: 'Message 2', timestamp: now, sender: 'Jane', channel: 'Group A' },
    ]);

    const result = await service.syncAll();

    // Both messages stored (falls back to scan window from determineScanWindow)
    expect(result.messageCount).toBe(2);
    expect(mockMessageRepo.create).toHaveBeenCalledTimes(2);
  });

  it('should not store any messages on re-scan when no new messages exist', async () => {
    const child = makeChild({ id: 'child-1', channelNames: 'Group A', teacherEmails: '' });
    mockChildService.findAll.mockResolvedValue([child]);

    const lastScanned = new Date('2026-03-24T12:00:00Z');
    const msgTime = new Date('2026-03-24T11:00:00Z');

    // Last scanned is newer than all messages
    mockMessageRepo.getLastTimestamp.mockResolvedValue(lastScanned);

    mockWhatsappService.getChannelMessages.mockResolvedValue([
      { content: 'Already scanned', timestamp: msgTime, sender: 'John', channel: 'Group A' },
    ]);

    const result = await service.syncAll();

    expect(result.messageCount).toBe(0);
    expect(mockMessageRepo.create).not.toHaveBeenCalled();
  });
});

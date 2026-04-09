import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module';
import { MessageEntity } from '../src/messages/entities/message.entity';
import { SyncLogEntity } from '../src/sync/entities/sync-log.entity';
import { ChildEntity } from '../src/settings/entities/child.entity';
import { WHATSAPP_SERVICE } from '../src/shared/constants/injection-tokens';
import type { IWhatsAppService } from '../src/messages/interfaces/whatsapp-service.interface';

/**
 * E2E test that simulates clicking "Sync Now" in the app.
 *
 * Uses a mock WhatsApp service that reports connected and returns messages,
 * verifying the full sync flow: API → SyncService → message storage → sync log.
 */
describe('Sync Button (e2e)', () => {
  let app: INestApplication<App>;
  let messageRepo: Repository<MessageEntity>;
  let syncLogRepo: Repository<SyncLogEntity>;
  let childRepo: Repository<ChildEntity>;

  const whatsappMessages = [
    {
      content: 'יום כיף ביום חמישי 27.3 אנא אשרו הגעה',
      timestamp: new Date(),
      sender: 'Teacher Noa',
      channel: 'Parents Group 3A',
    },
    {
      content: 'תזכורת: מחר אין לימודים',
      timestamp: new Date(),
      sender: 'Admin',
      channel: 'Parents Group 3A',
    },
  ];

  const mockWhatsAppService: IWhatsAppService = {
    initialize: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getConnectionStatus: jest.fn().mockReturnValue('connected'),
    getChannelMessages: jest.fn().mockResolvedValue(whatsappMessages),
    sendMessage: jest.fn().mockResolvedValue('msg-id'),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WHATSAPP_SERVICE)
      .useValue(mockWhatsAppService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    messageRepo = moduleFixture.get(getRepositoryToken(MessageEntity));
    syncLogRepo = moduleFixture.get(getRepositoryToken(SyncLogEntity));
    childRepo = moduleFixture.get(getRepositoryToken(ChildEntity));

    // Clean slate
    await syncLogRepo.clear();
    await messageRepo.clear();

    // Delete any existing children
    const existing = await childRepo.find();
    for (const child of existing) {
      await childRepo.remove(child);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('should sync successfully when no children are configured', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sync/manual')
      .expect(201);

    expect(res.body.status).toBe('success');
    expect(res.body.messageCount).toBe(0);
  });

  it('should create a child with WhatsApp channels', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/children')
      .send({
        name: 'Alice',
        channelNames: 'Parents Group 3A',
      })
      .expect(201);

    expect(res.body.name).toBe('Alice');
    expect(res.body.channelNames).toBe('Parents Group 3A');
  });

  it('POST /api/sync/manual should fetch WhatsApp messages and store them', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sync/manual')
      .expect(201);

    expect(res.body.status).toBe('success');
    expect(res.body.messageCount).toBe(2);

    // Verify WhatsApp was called with the correct channel
    expect(mockWhatsAppService.getChannelMessages).toHaveBeenCalledWith(
      'Parents Group 3A',
    );
  });

  it('should have stored the messages in the database', async () => {
    const messages = await messageRepo.find({ order: { timestamp: 'DESC' } });

    expect(messages.length).toBeGreaterThanOrEqual(2);

    const waMessages = messages.filter((m) => m.source === 'whatsapp');
    expect(waMessages.length).toBeGreaterThanOrEqual(2);
    expect(waMessages.some((m) => m.content.includes('יום כיף'))).toBe(true);
    expect(waMessages.some((m) => m.content.includes('תזכורת'))).toBe(true);
    expect(waMessages.every((m) => m.channel === 'Parents Group 3A')).toBe(true);
    expect(waMessages.every((m) => m.childId !== null)).toBe(true);
  });

  it('should have created a sync log with channel details (no skips)', async () => {
    const logs = await syncLogRepo.find({ order: { timestamp: 'DESC' } });

    // Find the log with messageCount > 0 (the real sync, not the empty one)
    const syncLog = logs.find((l) => l.messageCount > 0);
    expect(syncLog).toBeDefined();
    expect(syncLog!.status).toBe('success');
    expect(syncLog!.messageCount).toBe(2);
    expect(syncLog!.startedAt).toBeDefined();
    expect(syncLog!.endedAt).toBeDefined();

    // Channel details should show the channel was synced, NOT skipped
    expect(syncLog!.channelDetails).toBeDefined();
    expect(syncLog!.channelDetails!.length).toBeGreaterThan(0);

    const channelDetail = syncLog!.channelDetails!.find(
      (d) => d.channelName === 'Parents Group 3A',
    );
    expect(channelDetail).toBeDefined();
    expect(channelDetail!.skipped).toBe(false);
    expect(channelDetail!.messagesFound).toBe(2);
    expect(channelDetail!.skipReason).toBeUndefined();
  });

  it('should have updated child lastScanAt', async () => {
    const children = await childRepo.find();
    const alice = children.find((c) => c.name === 'Alice');
    expect(alice).toBeDefined();
    expect(alice!.lastScanAt).toBeDefined();
  });

  it('sync log should appear in GET /api/sync/logs', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sync/logs')
      .expect(200);

    expect(res.body.length).toBeGreaterThan(0);

    const successLog = res.body.find(
      (l: any) => l.messageCount > 0 && l.status === 'success',
    );
    expect(successLog).toBeDefined();
    expect(successLog.channelDetails).toBeDefined();
    expect(
      successLog.channelDetails.some(
        (d: any) => d.channelName === 'Parents Group 3A' && !d.skipped,
      ),
    ).toBe(true);
  });

  it('should not duplicate messages on re-sync', async () => {
    const countBefore = await messageRepo.count();

    await request(app.getHttpServer())
      .post('/api/sync/manual')
      .expect(201);

    const countAfter = await messageRepo.count();

    // Same messages should not be duplicated (timestamps haven't changed)
    expect(countAfter).toBe(countBefore);
  });

  describe('WhatsApp disconnected scenario', () => {
    it('should log skip reason when WhatsApp is not connected', async () => {
      // Simulate disconnection
      (mockWhatsAppService.isConnected as jest.Mock).mockReturnValue(false);
      (mockWhatsAppService.initialize as jest.Mock).mockRejectedValue(
        new Error('No session found'),
      );

      const res = await request(app.getHttpServer())
        .post('/api/sync/manual')
        .expect(201);

      // Sync completes but with 0 messages
      expect(res.body.status).toBe('success');
      expect(res.body.messageCount).toBe(0);

      // Find the sync log that has channel details with skipped channels
      const logs = await syncLogRepo.find({ order: { timestamp: 'DESC' } });
      const disconnectedLog = logs.find(
        (l) =>
          l.channelDetails &&
          l.channelDetails.some((d) => d.skipped),
      );
      expect(disconnectedLog).toBeDefined();

      const skippedChannel = disconnectedLog!.channelDetails!.find(
        (d) => d.channelName === 'Parents Group 3A',
      );
      expect(skippedChannel).toBeDefined();
      expect(skippedChannel!.skipped).toBe(true);
      expect(skippedChannel!.skipReason).toBe('WhatsApp not connected');

      // Restore mock for any subsequent tests
      (mockWhatsAppService.isConnected as jest.Mock).mockReturnValue(true);
      (mockWhatsAppService.initialize as jest.Mock).mockResolvedValue(
        undefined,
      );
    });
  });
});

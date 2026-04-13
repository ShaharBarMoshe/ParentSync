import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SyncController } from './sync.controller';
import { SyncService } from '../services/sync.service';
import { EventSyncService } from '../services/event-sync.service';
import { ChildService } from '../../settings/child.service';
import { MESSAGE_REPOSITORY } from '../../shared/constants/injection-tokens';
import { SyncLogEntity } from '../entities/sync-log.entity';
import { SyncStatus } from '../../shared/enums/sync-status.enum';

describe('SyncController', () => {
  let controller: SyncController;
  let syncService: jest.Mocked<SyncService>;
  let eventSyncService: jest.Mocked<EventSyncService>;
  let childService: any;
  let messageRepository: any;

  const mockSyncLog: SyncLogEntity = {
    id: 'log-uuid-1',
    timestamp: new Date(),
    status: SyncStatus.SUCCESS,
    messageCount: 5,
    eventsCreated: 2,
    startedAt: new Date(),
    endedAt: new Date(),
    channelDetails: [],
  };

  beforeEach(async () => {
    const mockSyncService = {
      syncAll: jest.fn(),
      getSyncLogs: jest.fn(),
    };

    const mockEventSyncService = {
      syncEvents: jest.fn(),
    };

    childService = {
      resetAllLastScan: jest.fn().mockResolvedValue(2),
    };

    messageRepository = {
      resetAllParsed: jest.fn().mockResolvedValue(5),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [
        { provide: SyncService, useValue: mockSyncService },
        { provide: EventSyncService, useValue: mockEventSyncService },
        { provide: ChildService, useValue: childService },
        { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
        EventEmitter2,
      ],
    }).compile();

    controller = module.get<SyncController>(SyncController);
    syncService = module.get(SyncService);
    eventSyncService = module.get(EventSyncService);
  });

  describe('manualSync', () => {
    it('should trigger manual sync and return result', async () => {
      const syncResult = { messageCount: 5, status: 'success' };
      syncService.syncAll.mockResolvedValue(syncResult as any);

      const result = await controller.manualSync();

      expect(syncService.syncAll).toHaveBeenCalled();
      expect(result).toEqual(syncResult);
    });

    it('should propagate errors from sync service', async () => {
      syncService.syncAll.mockRejectedValue(new Error('Sync failed'));

      await expect(controller.manualSync()).rejects.toThrow('Sync failed');
    });
  });

  describe('syncEvents', () => {
    it('should trigger event sync and return result', async () => {
      const syncResult = { eventsCreated: 3, eventsSynced: 2 };
      eventSyncService.syncEvents.mockResolvedValue(syncResult as any);

      const result = await controller.syncEvents();

      expect(eventSyncService.syncEvents).toHaveBeenCalled();
      expect(result).toEqual(syncResult);
    });

    it('should propagate errors from event sync service', async () => {
      eventSyncService.syncEvents.mockRejectedValue(
        new Error('Event sync failed'),
      );

      await expect(controller.syncEvents()).rejects.toThrow(
        'Event sync failed',
      );
    });
  });

  describe('errors SSE', () => {
    it('should return an observable that emits app.error events', (done) => {
      const eventEmitter = controller['eventEmitter'];
      const observable = controller.errors();

      const testError = {
        source: 'llm',
        code: 'LLM_CLIENT_ERROR_404',
        message: 'Model not found',
        timestamp: new Date().toISOString(),
      };

      observable.subscribe((event) => {
        expect(event.data).toEqual(testError);
        done();
      });

      eventEmitter.emit('app.error', testError);
    });
  });

  describe('getSyncLogs', () => {
    it('should return sync logs with default limit', async () => {
      syncService.getSyncLogs.mockResolvedValue([mockSyncLog]);

      const result = await controller.getSyncLogs();

      expect(syncService.getSyncLogs).toHaveBeenCalledWith(20);
      expect(result).toEqual([mockSyncLog]);
    });

    it('should pass custom limit to service', async () => {
      syncService.getSyncLogs.mockResolvedValue([mockSyncLog]);

      const result = await controller.getSyncLogs(5);

      expect(syncService.getSyncLogs).toHaveBeenCalledWith(5);
      expect(result).toEqual([mockSyncLog]);
    });

    it('should return empty array when no logs exist', async () => {
      syncService.getSyncLogs.mockResolvedValue([]);

      const result = await controller.getSyncLogs();

      expect(result).toEqual([]);
    });
  });

  describe('resetSyncState', () => {
    it('should reset children lastScanAt and messages parsed status', async () => {
      const result = await controller.resetSyncState();

      expect(childService.resetAllLastScan).toHaveBeenCalled();
      expect(messageRepository.resetAllParsed).toHaveBeenCalled();
      expect(result).toEqual({ childrenReset: 2, messagesReset: 5 });
    });
  });
});

import { Controller, Post, Get, Inject, Query, Sse, MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent, map } from 'rxjs';
import { SyncService } from '../services/sync.service';
import { EventSyncService } from '../services/event-sync.service';
import { ChildService } from '../../settings/child.service';
import { MESSAGE_REPOSITORY } from '../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import { SyncLogEntity } from '../entities/sync-log.entity';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly eventSyncService: EventSyncService,
    private readonly eventEmitter: EventEmitter2,
    private readonly childService: ChildService,
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
  ) {}

  @Post('manual')
  @ApiOperation({ summary: 'Trigger manual sync (fetch messages)' })
  @ApiResponse({ status: 201, description: 'Sync completed' })
  async manualSync() {
    return this.syncService.syncAll();
  }

  @Post('events')
  @ApiOperation({
    summary: 'Parse messages and sync events to Google Calendar',
  })
  @ApiResponse({ status: 201, description: 'Event sync completed' })
  async syncEvents() {
    return this.eventSyncService.syncEvents();
  }

  @Get('logs')
  @ApiOperation({ summary: 'Get sync logs' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Sync logs retrieved' })
  async getSyncLogs(
    @Query('limit') limit?: number,
  ): Promise<SyncLogEntity[]> {
    return this.syncService.getSyncLogs(limit ?? 20);
  }

  @Post('reset')
  @ApiOperation({ summary: 'Reset sync state — clears lastScanAt for all children and marks all messages as unparsed' })
  @ApiResponse({ status: 201, description: 'Sync state reset' })
  async resetSyncState() {
    const childrenReset = await this.childService.resetAllLastScan();
    const messagesReset = await this.messageRepository.resetAllParsed();
    return { childrenReset, messagesReset };
  }

  @Sse('errors')
  @ApiOperation({ summary: 'SSE stream for critical app errors' })
  errors(): Observable<MessageEvent> {
    return fromEvent(this.eventEmitter, 'app.error').pipe(
      map((error: unknown) => ({ data: error as object })),
    );
  }
}

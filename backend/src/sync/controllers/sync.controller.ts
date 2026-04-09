import { Controller, Post, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { SyncService } from '../services/sync.service';
import { EventSyncService } from '../services/event-sync.service';
import { SyncLogEntity } from '../entities/sync-log.entity';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly eventSyncService: EventSyncService,
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
}

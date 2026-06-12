import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MonitorService } from '../services/monitor.service';
import { DbHygieneService } from '../../sync/services/db-hygiene.service';
import { QueryMonitorDto } from '../dto/query-monitor.dto';

@ApiTags('monitor')
@Controller('monitor')
export class MonitorController {
  constructor(
    private readonly monitorService: MonitorService,
    private readonly dbHygieneService: DbHygieneService,
  ) {}

  @Get('messages-over-time')
  @ApiOperation({ summary: 'Message counts grouped by time period' })
  @ApiResponse({ status: 200, description: 'Chart data returned' })
  async getMessagesOverTime(@Query() query: QueryMonitorDto) {
    return this.monitorService.getMessagesOverTime(query);
  }

  @Get('events-per-channel')
  @ApiOperation({ summary: 'Event counts grouped by channel' })
  @ApiResponse({ status: 200, description: 'Chart data returned' })
  async getEventsPerChannel(@Query() query: QueryMonitorDto) {
    return this.monitorService.getEventsPerChannel(query);
  }

  @Get('sync-history')
  @ApiOperation({ summary: 'Sync log timeline with details' })
  @ApiResponse({ status: 200, description: 'Sync history returned' })
  async getSyncHistory(@Query() query: QueryMonitorDto) {
    return this.monitorService.getSyncHistory(query);
  }

  @Get('summary')
  @ApiOperation({ summary: 'KPI summary with totals and averages' })
  @ApiResponse({ status: 200, description: 'Summary returned' })
  async getSummary(@Query() query: QueryMonitorDto) {
    return this.monitorService.getSummary(query);
  }

  @Get('channels-activity')
  @ApiOperation({ summary: 'Per-channel message volume heatmap data' })
  @ApiResponse({ status: 200, description: 'Heatmap data returned' })
  async getChannelsActivity(@Query() query: QueryMonitorDto) {
    return this.monitorService.getChannelsActivity(query);
  }

  @Get('db-stats')
  @ApiOperation({ summary: 'Database file size and per-table row/byte breakdown' })
  @ApiResponse({ status: 200, description: 'DB stats returned' })
  async getDatabaseStats() {
    return this.monitorService.getDatabaseStats();
  }

  @Post('db-maintenance')
  @ApiOperation({ summary: 'Trigger DB maintenance now (backup, retention sweep, vacuum)' })
  @ApiResponse({ status: 200, description: 'Maintenance completed' })
  async runDbMaintenance() {
    await this.dbHygieneService.runDailyMaintenance();
    return this.monitorService.getDatabaseStats();
  }
}

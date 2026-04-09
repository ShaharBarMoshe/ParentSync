import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MonitorService } from '../services/monitor.service';
import { QueryMonitorDto } from '../dto/query-monitor.dto';

@ApiTags('monitor')
@Controller('monitor')
export class MonitorController {
  constructor(private readonly monitorService: MonitorService) {}

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
}

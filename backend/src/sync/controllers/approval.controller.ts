import {
  Controller,
  Post,
  Param,
  ParseUUIDPipe,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApprovalService } from '../services/approval.service';

@ApiTags('approval')
@Controller('approval/events')
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a pending event from the app' })
  @ApiParam({ name: 'id', description: 'Event id' })
  async approve(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.approvalService.approveEventById(id);
    } catch (e: any) {
      if (/not found/i.test(e?.message ?? '')) {
        throw new NotFoundException(e.message);
      }
      throw e;
    }
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a pending event from the app' })
  @ApiParam({ name: 'id', description: 'Event id' })
  async reject(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.approvalService.rejectEventById(id);
    } catch (e: any) {
      if (/not found/i.test(e?.message ?? '')) {
        throw new NotFoundException(e.message);
      }
      throw e;
    }
  }
}

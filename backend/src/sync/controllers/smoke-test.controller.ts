import { Controller, Post, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SmokeTestService } from '../services/smoke-test.service';
import type { SmokeTestResult } from '../../shared/constants/smoke-test';

@ApiTags('smoke-test')
@Controller('smoke-test')
@Throttle({ default: { limit: 6, ttl: 60000 } })
export class SmokeTestController {
  constructor(private readonly smokeTestService: SmokeTestService) {}

  @Post('run')
  @ApiOperation({ summary: 'Run the production smoke test now (manual trigger)' })
  @ApiResponse({ status: 201, description: 'Smoke test completed' })
  async run(): Promise<SmokeTestResult> {
    return this.smokeTestService.run('manual');
  }

  @Get('status')
  @ApiOperation({ summary: 'Get the last smoke test result' })
  @ApiResponse({ status: 200, description: 'Last smoke test result (or null)' })
  getStatus(): SmokeTestResult | null {
    return this.smokeTestService.getLastResult();
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthCheckService,
  HealthCheck,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { resolveAppVersion } from './app-version';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
  ) {}

  @Get('health')
  @HealthCheck()
  @ApiOperation({ summary: 'Health check endpoint' })
  check() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }

  @Get('version')
  @ApiOperation({
    summary: 'Return the running application version. Reads APP_VERSION (set by Electron at fork time) and falls back to the root package.json on disk for dev mode.',
  })
  version(): { version: string; source: 'env' | 'package' | 'unknown' } {
    return resolveAppVersion();
  }
}

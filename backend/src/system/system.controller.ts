import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsOptional } from 'class-validator';
import { SystemService } from './system.service';

class UninstallDto {
  /** When true, also wipe the user-data directory (database, OAuth tokens,
   *  WhatsApp Web session, logs). When false, only the binary + autostart. */
  @IsOptional()
  @IsBoolean()
  removeUserData?: boolean;
}

@ApiTags('system')
@Controller('system')
@Throttle({ default: { limit: 3, ttl: 60_000 } })
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Post('uninstall')
  @ApiOperation({
    summary:
      'Schedule a self-uninstall: writes a per-platform cleanup script and exits the app.',
  })
  async uninstall(@Body() dto: UninstallDto) {
    const removeUserData = dto.removeUserData ?? false;
    const result = await this.systemService.uninstall(removeUserData);
    return {
      ok: true,
      message:
        'Uninstall scheduled. The app will close and the cleanup script will run in a few seconds.',
      ...result,
    };
  }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { CreateSettingDto } from './dto/create-setting.dto';
import { UpdateSettingDto } from './dto/update-setting.dto';
import { SENSITIVE_SETTING_KEYS } from './constants/setting-keys';

@ApiTags('settings')
@Controller('settings')
@Throttle({ default: { limit: 60, ttl: 60000 } })
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all settings (sensitive values masked)' })
  async findAll() {
    const settings = await this.settingsService.findAll();
    return settings.map((s) => ({
      ...s,
      value: SENSITIVE_SETTING_KEYS.has(s.key) ? maskValue(s.value) : s.value,
    }));
  }

  @Get('sensitive-status')
  @ApiOperation({ summary: 'Check which sensitive keys are configured (boolean only)' })
  async getSensitiveStatus(): Promise<Record<string, boolean>> {
    const settings = await this.settingsService.findAll();
    const keySet = new Map(settings.map((s) => [s.key, s.value]));
    const result: Record<string, boolean> = {};
    for (const key of SENSITIVE_SETTING_KEYS) {
      const val = keySet.get(key);
      result[key] = !!val && val.trim().length > 0;
    }
    return result;
  }

  @Get(':key')
  @ApiOperation({ summary: 'Get a setting by key (sensitive values masked)' })
  @ApiParam({ name: 'key', description: 'Setting key' })
  async findByKey(@Param('key') key: string) {
    const setting = await this.settingsService.findByKey(key);
    if (SENSITIVE_SETTING_KEYS.has(setting.key)) {
      return { ...setting, value: maskValue(setting.value) };
    }
    return setting;
  }

  @Post()
  @ApiOperation({ summary: 'Create or upsert a setting' })
  create(@Body() dto: CreateSettingDto) {
    return this.settingsService.create(dto);
  }

  @Put(':key')
  @ApiOperation({ summary: 'Update a setting by key' })
  @ApiParam({ name: 'key', description: 'Setting key' })
  update(@Param('key') key: string, @Body() dto: UpdateSettingDto) {
    return this.settingsService.update(key, dto);
  }

  @Delete(':key')
  @ApiOperation({ summary: 'Delete a setting by key' })
  @ApiParam({ name: 'key', description: 'Setting key' })
  delete(@Param('key') key: string) {
    return this.settingsService.delete(key);
  }
}

function maskValue(value: string): string {
  if (!value || value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { SettingsService } from '../../settings/settings.service';
import { LLM_SYSTEM_PROMPT_KEY } from '../../settings/constants/setting-keys';
import { DEFAULT_SYSTEM_PROMPT } from '../services/default-system-prompt';

class UpdatePromptDto {
  @IsString()
  @MinLength(50)
  @MaxLength(64000)
  value!: string;
}

interface PromptResponse {
  value: string;
  default: string;
  isCustom: boolean;
}

@ApiTags('llm')
@Controller('llm/prompt')
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class LlmPromptController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get the active LLM extraction prompt' })
  async get(): Promise<PromptResponse> {
    let value = DEFAULT_SYSTEM_PROMPT;
    let isCustom = false;
    try {
      const setting = await this.settingsService.findByKey(LLM_SYSTEM_PROMPT_KEY);
      if (setting?.value?.trim()) {
        value = setting.value;
        isCustom = true;
      }
    } catch {
      // setting not found — return default
    }
    return { value, default: DEFAULT_SYSTEM_PROMPT, isCustom };
  }

  @Put()
  @ApiOperation({ summary: 'Override the LLM extraction prompt' })
  async update(@Body() dto: UpdatePromptDto): Promise<PromptResponse> {
    const trimmed = dto.value.trim();
    if (!trimmed) {
      throw new BadRequestException('Prompt cannot be empty.');
    }
    await this.settingsService.create({
      key: LLM_SYSTEM_PROMPT_KEY,
      value: trimmed,
    });
    return { value: trimmed, default: DEFAULT_SYSTEM_PROMPT, isCustom: true };
  }

  @Delete()
  @ApiOperation({ summary: 'Reset to the default LLM extraction prompt' })
  async reset(): Promise<PromptResponse> {
    try {
      await this.settingsService.delete(LLM_SYSTEM_PROMPT_KEY);
    } catch {
      // already absent — fine
    }
    return {
      value: DEFAULT_SYSTEM_PROMPT,
      default: DEFAULT_SYSTEM_PROMPT,
      isCustom: false,
    };
  }
}

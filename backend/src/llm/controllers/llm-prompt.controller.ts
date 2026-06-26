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
import {
  LLM_SYSTEM_PROMPT_KEY,
  LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY,
  LLM_CLASSIFIER_PROMPT_KEY,
  LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY,
} from '../../settings/constants/setting-keys';
import { DEFAULT_SYSTEM_PROMPT } from '../services/default-system-prompt';
import { DEFAULT_CLASSIFIER_PROMPT } from '../services/default-classifier-prompt';

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
  @ApiOperation({ summary: 'Get the active LLM extractor prompt' })
  async get(): Promise<PromptResponse> {
    return this.getPrompt(LLM_SYSTEM_PROMPT_KEY, LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY, DEFAULT_SYSTEM_PROMPT);
  }

  @Put()
  @ApiOperation({ summary: 'Override the LLM extractor prompt' })
  async update(@Body() dto: UpdatePromptDto): Promise<PromptResponse> {
    return this.savePrompt(LLM_SYSTEM_PROMPT_KEY, LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY, DEFAULT_SYSTEM_PROMPT, dto.value);
  }

  @Delete()
  @ApiOperation({ summary: 'Reset the LLM extractor prompt to default' })
  async reset(): Promise<PromptResponse> {
    return this.resetPrompt(LLM_SYSTEM_PROMPT_KEY, LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY, DEFAULT_SYSTEM_PROMPT);
  }

  @Get('classifier')
  @ApiOperation({ summary: 'Get the active LLM classifier prompt (stage 1)' })
  async getClassifier(): Promise<PromptResponse> {
    return this.getPrompt(LLM_CLASSIFIER_PROMPT_KEY, LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY, DEFAULT_CLASSIFIER_PROMPT);
  }

  @Put('classifier')
  @ApiOperation({ summary: 'Override the LLM classifier prompt' })
  async updateClassifier(@Body() dto: UpdatePromptDto): Promise<PromptResponse> {
    return this.savePrompt(LLM_CLASSIFIER_PROMPT_KEY, LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY, DEFAULT_CLASSIFIER_PROMPT, dto.value);
  }

  @Delete('classifier')
  @ApiOperation({ summary: 'Reset the LLM classifier prompt to default' })
  async resetClassifier(): Promise<PromptResponse> {
    return this.resetPrompt(LLM_CLASSIFIER_PROMPT_KEY, LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY, DEFAULT_CLASSIFIER_PROMPT);
  }

  private async getPrompt(valueKey: string, customKey: string, fallback: string): Promise<PromptResponse> {
    let value = fallback;
    const isCustomSetting = await this.settingsService.findByKey(customKey).catch(() => null);
    const isCustom = isCustomSetting?.value === 'true';
    try {
      const setting = await this.settingsService.findByKey(valueKey);
      if (setting?.value?.trim()) value = setting.value;
    } catch {
      /* not found — return default */
    }
    return { value, default: fallback, isCustom };
  }

  private async savePrompt(valueKey: string, customKey: string, fallback: string, raw: string): Promise<PromptResponse> {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new BadRequestException('Prompt cannot be empty.');
    }
    await this.settingsService.create({ key: valueKey, value: trimmed });
    await this.settingsService.create({ key: customKey, value: 'true' });
    return { value: trimmed, default: fallback, isCustom: true };
  }

  private async resetPrompt(valueKey: string, customKey: string, fallback: string): Promise<PromptResponse> {
    await this.settingsService.create({ key: valueKey, value: fallback });
    await this.settingsService.create({ key: customKey, value: 'false' });
    return { value: fallback, default: fallback, isCustom: false };
  }
}

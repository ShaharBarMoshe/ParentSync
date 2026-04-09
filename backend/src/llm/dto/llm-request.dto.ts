import {
  IsArray,
  IsString,
  IsNumber,
  IsOptional,
  ValidateNested,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LlmMessageDto {
  @ApiProperty({ enum: ['system', 'user', 'assistant'] })
  @IsString()
  @IsIn(['system', 'user', 'assistant'])
  role: 'system' | 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  content: string;
}

export class LlmRequestDto {
  @ApiProperty({ type: [LlmMessageDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LlmMessageDto)
  messages: LlmMessageDto[];

  @ApiPropertyOptional({ default: 'google/gemini-2.0-flash-001' })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ default: 0.3 })
  @IsOptional()
  @IsNumber()
  temperature?: number;

  @ApiPropertyOptional({ default: 2048 })
  @IsOptional()
  @IsNumber()
  maxTokens?: number;
}

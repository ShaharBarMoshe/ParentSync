import { IsOptional, IsEnum, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MessageSource } from '../../shared/enums/message-source.enum';

export class QueryMessagesDto {
  @ApiPropertyOptional({ enum: MessageSource })
  @IsOptional()
  @IsEnum(MessageSource)
  source?: MessageSource;

  @ApiPropertyOptional({ description: 'Filter unparsed messages only' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  unparsed?: boolean;

  @ApiPropertyOptional({ description: 'Max items to return', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ description: 'Items to skip', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  Matches,
  IsEnum,
} from 'class-validator';
import { MessageSource } from '../../shared/enums/message-source.enum';

export class CreateCalendarEventDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  @IsNotEmpty()
  date: string; // YYYY-MM-DD

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'time must be in HH:MM format' })
  time?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsEnum(MessageSource)
  source?: MessageSource;

  @IsOptional()
  @IsString()
  sourceId?: string;
}

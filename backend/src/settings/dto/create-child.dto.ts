import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const GOOGLE_CALENDAR_COLORS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
];

export class CreateChildDto {
  @ApiProperty({ description: 'Child display name', example: 'Yoni' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description: 'Comma-separated WhatsApp channel names',
  })
  @IsOptional()
  @IsString()
  channelNames?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated teacher email addresses',
  })
  @IsOptional()
  @IsString()
  teacherEmails?: string;

  @ApiPropertyOptional({ description: 'Google Calendar color ID (1-11)' })
  @IsOptional()
  @IsString()
  @IsIn(GOOGLE_CALENDAR_COLORS, {
    message: 'calendarColor must be a valid Google Calendar color ID (1-11)',
  })
  calendarColor?: string;
}

import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ALLOWED_SETTING_KEYS } from '../constants/setting-keys';

export class CreateSettingDto {
  @ApiProperty({ description: 'Setting key', example: 'whatsapp_channels' })
  @IsString()
  @IsNotEmpty()
  @IsIn(ALLOWED_SETTING_KEYS, { message: `key must be one of: ${ALLOWED_SETTING_KEYS.join(', ')}` })
  key: string;

  @ApiProperty({
    description: 'Setting value',
    example: 'parents-group,school-updates',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  value: string;
}

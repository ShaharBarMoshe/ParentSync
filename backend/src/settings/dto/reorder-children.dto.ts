import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReorderChildrenDto {
  @ApiProperty({ type: [String], description: 'Ordered array of child IDs' })
  @IsArray()
  @IsString({ each: true })
  ids: string[];
}

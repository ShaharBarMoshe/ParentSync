import { PartialType } from '@nestjs/swagger';
import { IsOptional, IsDate } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateChildDto } from './create-child.dto';

export class UpdateChildDto extends PartialType(CreateChildDto) {
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  lastScanAt?: Date;

  @IsOptional()
  order?: number;
}

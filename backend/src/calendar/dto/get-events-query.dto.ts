import { IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../shared/dto/pagination.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class GetEventsQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Inclusive start of date range (YYYY-MM-DD). Pair with `to`.',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    description: 'Inclusive end of date range (YYYY-MM-DD). Pair with `from`.',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

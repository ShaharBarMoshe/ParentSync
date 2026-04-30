import {
  Controller,
  Get,
  Delete,
  Param,
  Inject,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NEGATIVE_EXAMPLE_REPOSITORY } from '../../shared/constants/injection-tokens';
import type { INegativeExampleRepository } from '../interfaces/negative-example-repository.interface';

@ApiTags('llm')
@Controller('llm/negative-examples')
@Throttle({ default: { limit: 60, ttl: 60000 } })
export class NegativeExamplesController {
  constructor(
    @Inject(NEGATIVE_EXAMPLE_REPOSITORY)
    private readonly repo: INegativeExampleRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all learned exclusions (newest first)' })
  async list() {
    const items = await this.repo.findAll();
    const count = items.length;
    return {
      count,
      items: items.map((e) => ({
        id: e.id,
        messageContent: e.messageContent,
        extractedTitle: e.extractedTitle,
        extractedDate: e.extractedDate,
        channel: e.channel,
        createdAt: e.createdAt,
      })),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove one learned exclusion' })
  @ApiParam({ name: 'id', description: 'NegativeExample id' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.repo.delete(id);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Clear all learned exclusions' })
  async clear(): Promise<void> {
    await this.repo.deleteAll();
  }
}

import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeminiService } from './services/gemini.service';
import { MessageParserService } from './services/message-parser.service';
import { LlmRateLimiter } from './guards/llm-throttle.guard';
import { LlmQueueProcessor } from './queue/llm-queue.processor';
import { LlmPromptController } from './controllers/llm-prompt.controller';
import { NegativeExamplesController } from './controllers/negative-examples.controller';
import { NegativeExampleEntity } from './entities/negative-example.entity';
import { TypeOrmNegativeExampleRepository } from './repositories/typeorm-negative-example.repository';
import {
  LLM_SERVICE,
  NEGATIVE_EXAMPLE_REPOSITORY,
} from '../shared/constants/injection-tokens';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    SettingsModule,
    TypeOrmModule.forFeature([NegativeExampleEntity]),
    CacheModule.register({
      ttl: 86400, // 24 hours default
      max: 1000,
    }),
  ],
  controllers: [LlmPromptController, NegativeExamplesController],
  providers: [
    {
      provide: LLM_SERVICE,
      useClass: GeminiService,
    },
    {
      provide: NEGATIVE_EXAMPLE_REPOSITORY,
      useClass: TypeOrmNegativeExampleRepository,
    },
    MessageParserService,
    LlmRateLimiter,
    LlmQueueProcessor,
  ],
  exports: [
    LLM_SERVICE,
    MessageParserService,
    LlmRateLimiter,
    LlmQueueProcessor,
    NEGATIVE_EXAMPLE_REPOSITORY,
  ],
})
export class LlmModule {}

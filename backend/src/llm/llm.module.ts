import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeminiChatFactory } from './adapters/gemini-chat.factory';
import { ChainRunner } from './adapters/chain-runner.service';
import { ExtractionChain } from './adapters/extraction.chain';
import { ClassifierChain } from './adapters/classifier.chain';
import { DuplicateJudgeChain } from './adapters/duplicate-judge.chain';
import { EmbeddingAdapter } from './adapters/embedding.adapter';
import { TracingService } from './observability/tracing.service';
import { PromptRegistry } from './prompts/prompt-registry.service';
import { MessageParserService } from './services/message-parser.service';
import { MessageClassifierService } from './services/message-classifier.service';
import { LlmRateLimiter } from './guards/llm-throttle.guard';
import { LlmPromptController } from './controllers/llm-prompt.controller';
import { NegativeExamplesController } from './controllers/negative-examples.controller';
import { NegativeExampleEntity } from './entities/negative-example.entity';
import { TypeOrmNegativeExampleRepository } from './repositories/typeorm-negative-example.repository';
import {
  EVENT_EXTRACTOR,
  RELEVANCE_CLASSIFIER,
  DUPLICATE_JUDGE,
} from './ports/ai-ports';
import {
  EMBEDDING_SERVICE,
  NEGATIVE_EXAMPLE_REPOSITORY,
} from '../shared/constants/injection-tokens';
import { SettingsModule } from '../settings/settings.module';

/**
 * Every AI capability in the app, and the only place `@langchain/*` is wired.
 *
 * The four ports below are the entire AI surface the rest of the app can see.
 * Each is served by exactly one adapter — there is no runtime switch and no
 * second implementation to drift from the first. Rolling back a bad release
 * means installing the previous AppImage, which `install-local.sh` keeps.
 */
@Module({
  imports: [
    SettingsModule,
    TypeOrmModule.forFeature([NegativeExampleEntity]),
    CacheModule.register({
      ttl: 86400, // 24 hours
      max: 1000,
    }),
  ],
  controllers: [LlmPromptController, NegativeExamplesController],
  providers: [
    GeminiChatFactory,
    ChainRunner,
    TracingService,
    PromptRegistry,
    { provide: EVENT_EXTRACTOR, useClass: ExtractionChain },
    { provide: RELEVANCE_CLASSIFIER, useClass: ClassifierChain },
    { provide: DUPLICATE_JUDGE, useClass: DuplicateJudgeChain },
    { provide: EMBEDDING_SERVICE, useClass: EmbeddingAdapter },
    {
      provide: NEGATIVE_EXAMPLE_REPOSITORY,
      useClass: TypeOrmNegativeExampleRepository,
    },
    MessageParserService,
    MessageClassifierService,
    LlmRateLimiter,
  ],
  exports: [
    TracingService,
    PromptRegistry,
    EVENT_EXTRACTOR,
    RELEVANCE_CLASSIFIER,
    DUPLICATE_JUDGE,
    EMBEDDING_SERVICE,
    MessageParserService,
    MessageClassifierService,
    LlmRateLimiter,
    NEGATIVE_EXAMPLE_REPOSITORY,
  ],
})
export class LlmModule {}

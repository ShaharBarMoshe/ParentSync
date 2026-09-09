import { Logger, Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeminiService } from './services/gemini.service';
import { LangChainLlmService } from './services/langchain-llm.service';
import { LangChainEmbeddingService } from './services/langchain-embedding.service';
import { TracingService } from './observability/tracing.service';
import { SettingsService } from '../settings/settings.service';
import { LLM_RUNTIME_KEY } from '../settings/constants/setting-keys';
import type { ILLMService } from './interfaces/llm-service.interface';
import type { IEmbeddingService } from './interfaces/embedding-service.interface';
import { GeminiEmbeddingService } from './services/gemini-embedding.service';
import { MessageParserService } from './services/message-parser.service';
import { MessageClassifierService } from './services/message-classifier.service';
import { LlmRateLimiter } from './guards/llm-throttle.guard';
import { LlmQueueProcessor } from './queue/llm-queue.processor';
import { LlmPromptController } from './controllers/llm-prompt.controller';
import { NegativeExamplesController } from './controllers/negative-examples.controller';
import { NegativeExampleEntity } from './entities/negative-example.entity';
import { TypeOrmNegativeExampleRepository } from './repositories/typeorm-negative-example.repository';
import {
  LLM_SERVICE,
  EMBEDDING_SERVICE,
  NEGATIVE_EXAMPLE_REPOSITORY,
} from '../shared/constants/injection-tokens';
import { SettingsModule } from '../settings/settings.module';

const runtimeLogger = new Logger('LlmRuntime');

/**
 * Pick the adapter family for this boot.
 *
 * `llm_runtime` defaults to `langchain`; setting it to `legacy` falls back to
 * the Gemini SDK adapters. A temporary escape hatch for the Phase 26
 * migration — this app runs a real family's daily sync, and a bad parse path
 * means missed school events. Remove once LangChain has a few weeks of clean
 * runs. Read once at boot, so switching it needs a restart.
 */
async function selectRuntime<T>(
  settings: SettingsService,
  langchain: T,
  legacy: T,
  label: string,
): Promise<T> {
  let choice = 'langchain';
  try {
    choice = (await settings.findByKey(LLM_RUNTIME_KEY)).value.trim().toLowerCase();
  } catch {
    // Unset — take the default.
  }

  if (choice === 'legacy') {
    runtimeLogger.warn(
      `${label} runtime: legacy Gemini SDK adapter (llm_runtime=legacy)`,
    );
    return legacy;
  }
  runtimeLogger.log(`${label} runtime: LangChain`);
  return langchain;
}

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
    // Both adapter families are constructible; the factories below pick one
    // per boot from the `llm_runtime` setting. See `selectRuntime`.
    GeminiService,
    GeminiEmbeddingService,
    LangChainLlmService,
    LangChainEmbeddingService,
    TracingService,
    {
      provide: LLM_SERVICE,
      inject: [SettingsService, LangChainLlmService, GeminiService],
      useFactory: (
        settings: SettingsService,
        langchain: ILLMService,
        legacy: ILLMService,
      ) => selectRuntime(settings, langchain, legacy, 'LLM'),
    },
    {
      provide: EMBEDDING_SERVICE,
      inject: [SettingsService, LangChainEmbeddingService, GeminiEmbeddingService],
      useFactory: (
        settings: SettingsService,
        langchain: IEmbeddingService,
        legacy: IEmbeddingService,
      ) => selectRuntime(settings, langchain, legacy, 'embedding'),
    },
    {
      provide: NEGATIVE_EXAMPLE_REPOSITORY,
      useClass: TypeOrmNegativeExampleRepository,
    },
    MessageParserService,
    MessageClassifierService,
    LlmRateLimiter,
    LlmQueueProcessor,
  ],
  exports: [
    LLM_SERVICE,
    EMBEDDING_SERVICE,
    MessageParserService,
    MessageClassifierService,
    LlmRateLimiter,
    LlmQueueProcessor,
    NEGATIVE_EXAMPLE_REPOSITORY,
  ],
})
export class LlmModule {}

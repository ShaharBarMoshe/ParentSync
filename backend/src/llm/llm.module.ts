import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { GeminiService } from './services/gemini.service';
import { MessageParserService } from './services/message-parser.service';
import { LlmRateLimiter } from './guards/llm-throttle.guard';
import { LlmQueueProcessor } from './queue/llm-queue.processor';
import { LLM_SERVICE } from '../shared/constants/injection-tokens';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    SettingsModule,
    CacheModule.register({
      ttl: 86400, // 24 hours default
      max: 1000,
    }),
  ],
  providers: [
    {
      provide: LLM_SERVICE,
      useClass: GeminiService,
    },
    MessageParserService,
    LlmRateLimiter,
    LlmQueueProcessor,
  ],
  exports: [LLM_SERVICE, MessageParserService, LlmRateLimiter, LlmQueueProcessor],
})
export class LlmModule {}

import { Injectable, Logger, Inject } from '@nestjs/common';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';
import type { ILLMService, LlmMessage } from '../interfaces/llm-service.interface';

export interface LlmJob {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

@Injectable()
export class LlmQueueProcessor {
  private readonly logger = new Logger(LlmQueueProcessor.name);
  private readonly queue: Array<{
    job: LlmJob;
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private processing = false;

  constructor(
    @Inject(LLM_SERVICE) private readonly llmService: ILLMService,
    private readonly rateLimiter: LlmRateLimiter,
  ) {}

  async enqueue(job: LlmJob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.logger.debug(
        `Job enqueued. Queue length: ${this.queue.length}`,
      );
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;

        try {
          await this.rateLimiter.acquire();
          const result = await this.llmService.callLLM(
            item.job.messages,
            item.job.model,
            item.job.temperature,
            item.job.maxTokens,
          );
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

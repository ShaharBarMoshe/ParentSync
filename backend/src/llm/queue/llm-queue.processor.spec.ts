import { Test, TestingModule } from '@nestjs/testing';
import { LlmQueueProcessor } from './llm-queue.processor';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { LLM_SERVICE } from '../../shared/constants/injection-tokens';

describe('LlmQueueProcessor', () => {
  let processor: LlmQueueProcessor;
  let llmService: any;
  let rateLimiter: any;

  beforeEach(async () => {
    llmService = {
      callLLM: jest.fn().mockResolvedValue('LLM response'),
    };

    rateLimiter = {
      acquire: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmQueueProcessor,
        { provide: LLM_SERVICE, useValue: llmService },
        { provide: LlmRateLimiter, useValue: rateLimiter },
      ],
    }).compile();

    processor = module.get<LlmQueueProcessor>(LlmQueueProcessor);
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  it('should process a job and return the result', async () => {
    const result = await processor.enqueue({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result).toBe('LLM response');
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(1);
    expect(llmService.callLLM).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hello' }],
      undefined,
      undefined,
      undefined,
    );
  });

  it('should reject on LLM failure', async () => {
    llmService.callLLM.mockRejectedValue(new Error('API error'));

    await expect(
      processor.enqueue({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toThrow('API error');
  });

  it('should process multiple jobs sequentially', async () => {
    llmService.callLLM
      .mockResolvedValueOnce('Response 1')
      .mockResolvedValueOnce('Response 2');

    const [result1, result2] = await Promise.all([
      processor.enqueue({ messages: [{ role: 'user', content: 'Job 1' }] }),
      processor.enqueue({ messages: [{ role: 'user', content: 'Job 2' }] }),
    ]);

    expect(result1).toBe('Response 1');
    expect(result2).toBe('Response 2');
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(2);
  });

  it('should report queue length', () => {
    expect(processor.getQueueLength()).toBe(0);
  });

  it('should pass model and parameters to LLM service', async () => {
    await processor.enqueue({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'openai/gpt-4',
      temperature: 0.7,
      maxTokens: 4096,
    });

    expect(llmService.callLLM).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hello' }],
      'openai/gpt-4',
      0.7,
      4096,
    );
  });
});

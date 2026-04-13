import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { of, throwError } from 'rxjs';
import { AxiosResponse, AxiosHeaders } from 'axios';
import { OpenRouterService } from './openrouter.service';
import { LlmRateLimiter } from '../guards/llm-throttle.guard';
import { SettingsService } from '../../settings/settings.service';

describe('OpenRouterService', () => {
  let service: OpenRouterService;
  let httpService: jest.Mocked<HttpService>;
  let rateLimiter: jest.Mocked<LlmRateLimiter>;
  let eventEmitter: EventEmitter2;

  const mockSuccessResponse: AxiosResponse = {
    data: {
      id: 'gen-123',
      choices: [
        {
          message: { role: 'assistant', content: 'Hello, world!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenRouterService,
        {
          provide: HttpService,
          useValue: {
            post: jest.fn(),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            findByKey: jest.fn().mockImplementation((key: string) => {
              if (key === 'openrouter_api_key')
                return Promise.resolve({ value: 'test-api-key' });
              if (key === 'openrouter_model')
                return Promise.resolve({ value: 'test-model' });
              return Promise.reject(new Error('Not found'));
            }),
            findByKeyDecrypted: jest.fn().mockImplementation((key: string) => {
              if (key === 'openrouter_api_key')
                return Promise.resolve({ value: 'test-api-key' });
              if (key === 'openrouter_model')
                return Promise.resolve({ value: 'test-model' });
              return Promise.reject(new Error('Not found'));
            }),
          },
        },
        {
          provide: LlmRateLimiter,
          useValue: {
            acquire: jest.fn().mockResolvedValue(undefined),
          },
        },
        EventEmitter2,
      ],
    }).compile();

    service = module.get<OpenRouterService>(OpenRouterService);
    httpService = module.get(HttpService);
    rateLimiter = module.get(LlmRateLimiter);
    eventEmitter = module.get(EventEmitter2);

    // Trigger onModuleInit to load API key from settings
    await service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should acquire rate limit before making a call', async () => {
    httpService.post.mockReturnValue(of(mockSuccessResponse));

    await service.callLLM([{ role: 'user', content: 'Hello' }]);

    expect(rateLimiter.acquire).toHaveBeenCalledTimes(1);
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });

  it('should make a successful LLM call', async () => {
    httpService.post.mockReturnValue(of(mockSuccessResponse));

    const result = await service.callLLM([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result).toBe('Hello, world!');
    expect(httpService.post).toHaveBeenCalledTimes(1);
    expect(httpService.post).toHaveBeenCalledWith(
      expect.stringContaining('openrouter.ai'),
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      }),
    );
  });

  it('should throw on empty response', async () => {
    const emptyResponse: AxiosResponse = {
      ...mockSuccessResponse,
      data: { choices: [{ message: { content: '' } }] },
    };
    httpService.post.mockReturnValue(of(emptyResponse));

    await expect(
      service.callLLM([{ role: 'user', content: 'Hello' }]),
    ).rejects.toThrow();
  });

  it('should retry on server errors', async () => {
    const error = { response: { status: 500 }, message: 'Server error' };
    httpService.post
      .mockReturnValueOnce(throwError(() => error))
      .mockReturnValueOnce(of(mockSuccessResponse));

    const result = await service.callLLM([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result).toBe('Hello, world!');
    expect(httpService.post).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 4xx client errors (except 429)', async () => {
    const error = {
      response: { status: 400 },
      message: 'Bad request',
    };
    httpService.post.mockReturnValue(throwError(() => error));

    await expect(
      service.callLLM([{ role: 'user', content: 'Hello' }]),
    ).rejects.toBeDefined();
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });

  it('should retry on 429 rate limit errors', async () => {
    jest.useFakeTimers();
    const error = { response: { status: 429, headers: { 'retry-after': '1' } }, message: 'Rate limited' };
    httpService.post
      .mockReturnValueOnce(throwError(() => error))
      .mockReturnValueOnce(of(mockSuccessResponse));

    const callPromise = service.callLLM([
      { role: 'user', content: 'Hello' },
    ]);

    // Advance past the retry-after delay
    await jest.advanceTimersByTimeAsync(2000);

    const result = await callPromise;

    expect(result).toBe('Hello, world!');
    expect(httpService.post).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('should accept custom model and parameters', async () => {
    httpService.post.mockReturnValue(of(mockSuccessResponse));

    await service.callLLM(
      [{ role: 'user', content: 'Hello' }],
      'openai/gpt-4',
      0.7,
      4096,
    );

    expect(httpService.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: 'openai/gpt-4',
        temperature: 0.7,
        max_tokens: 4096,
      }),
      expect.any(Object),
    );
  });

  it('should emit app.error event on 404 client error', async () => {
    const emitSpy = jest.spyOn(eventEmitter, 'emit');
    const error = {
      response: { status: 404 },
      message: 'Request failed with status code 404',
    };
    httpService.post.mockReturnValue(throwError(() => error));

    await expect(
      service.callLLM([{ role: 'user', content: 'Hello' }]),
    ).rejects.toBeDefined();

    expect(emitSpy).toHaveBeenCalledWith(
      'app.error',
      expect.objectContaining({
        source: 'llm',
        code: 'LLM_CLIENT_ERROR_404',
        message: expect.stringContaining('not found on OpenRouter'),
      }),
    );
  });

  it('should emit app.error event on 401 client error', async () => {
    const emitSpy = jest.spyOn(eventEmitter, 'emit');
    const error = {
      response: { status: 401 },
      message: 'Unauthorized',
    };
    httpService.post.mockReturnValue(throwError(() => error));

    await expect(
      service.callLLM([{ role: 'user', content: 'Hello' }]),
    ).rejects.toBeDefined();

    expect(emitSpy).toHaveBeenCalledWith(
      'app.error',
      expect.objectContaining({
        source: 'llm',
        code: 'LLM_CLIENT_ERROR_401',
        message: expect.stringContaining('invalid or missing'),
      }),
    );
  });

  it('should sanitize API keys in error logs', async () => {
    const error = {
      response: { status: 500 },
      message: 'Failed with Bearer sk-abc123xyz456789012 token',
    };
    httpService.post.mockReturnValue(throwError(() => error));

    await expect(
      service.callLLM([{ role: 'user', content: 'Hello' }]),
    ).rejects.toBeDefined();
  });
});

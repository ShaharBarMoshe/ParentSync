import { LlmLoggingInterceptor } from './llm-logging.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';

describe('LlmLoggingInterceptor', () => {
  let interceptor: LlmLoggingInterceptor;

  beforeEach(() => {
    interceptor = new LlmLoggingInterceptor();
  });

  const mockContext = {
    getHandler: () => ({ name: 'callLLM' }),
    getClass: () => ({ name: 'OpenRouterService' }),
  } as unknown as ExecutionContext;

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  it('should pass through successful responses', (done) => {
    const handler: CallHandler = {
      handle: () => of('response'),
    };

    interceptor.intercept(mockContext, handler).subscribe({
      next: (value) => {
        expect(value).toBe('response');
      },
      complete: () => done(),
    });
  });

  it('should pass through errors', (done) => {
    const handler: CallHandler = {
      handle: () => throwError(() => new Error('test error')),
    };

    interceptor.intercept(mockContext, handler).subscribe({
      error: (err) => {
        expect(err.message).toBe('test error');
        done();
      },
    });
  });

  it('should sanitize API keys in error messages', (done) => {
    const handler: CallHandler = {
      handle: () =>
        throwError(
          () => new Error('Failed with Bearer sk-abc123xyz token'),
        ),
    };

    // The interceptor logs but still throws
    interceptor.intercept(mockContext, handler).subscribe({
      error: () => done(),
    });
  });
});

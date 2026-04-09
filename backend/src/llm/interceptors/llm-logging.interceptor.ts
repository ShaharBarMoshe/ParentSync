import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LlmLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('LlmLoggingInterceptor');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const now = Date.now();
    const handler = context.getHandler().name;
    const className = context.getClass().name;

    this.logger.log(`LLM request started: ${className}.${handler}`);

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - now;
          this.logger.log(
            `LLM request completed: ${className}.${handler} (${duration}ms)`,
          );
        },
        error: (error) => {
          const duration = Date.now() - now;
          const sanitizedMessage = this.sanitizeMessage(error.message);
          this.logger.error(
            `LLM request failed: ${className}.${handler} (${duration}ms) - ${sanitizedMessage}`,
          );
        },
      }),
    );
  }

  private sanitizeMessage(message: string): string {
    if (!message) return 'Unknown error';
    // Remove any API keys that may appear in error messages
    return message.replace(
      /Bearer\s+[a-zA-Z0-9\-_]+/g,
      'Bearer [REDACTED]',
    ).replace(
      /sk-[a-zA-Z0-9\-_]+/g,
      '[REDACTED_KEY]',
    ).replace(
      /key[=:]\s*["']?[a-zA-Z0-9\-_]{20,}["']?/gi,
      'key=[REDACTED]',
    );
  }
}

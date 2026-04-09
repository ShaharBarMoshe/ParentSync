import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly isProduction = false) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Build detailed error log
    const logParts: string[] = [
      `${request.method} ${request.url} ${status}`,
    ];

    // Log validation error details for 400 responses
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const msg = (exceptionResponse as Record<string, unknown>).message;
        if (msg) {
          logParts.push(`Validation errors: ${JSON.stringify(msg)}`);
        }
      }
    }

    // Log request body (redact sensitive fields)
    if (request.body && Object.keys(request.body).length > 0) {
      const sanitizedBody = this.sanitizeBody(request.body);
      logParts.push(`Request body: ${JSON.stringify(sanitizedBody)}`);
    }

    this.logger.error(
      logParts.join(' | '),
      exception instanceof Error ? exception.stack : undefined,
    );

    if (this.isProduction) {
      const message =
        exception instanceof HttpException
          ? this.extractMessage(exception.getResponse())
          : 'Internal server error';
      response.status(status).json({
        statusCode: status,
        message,
      });
    } else {
      const message =
        exception instanceof HttpException
          ? exception.getResponse()
          : 'Internal server error';
      response.status(status).json({
        statusCode: status,
        timestamp: new Date().toISOString(),
        path: request.url,
        ...(typeof message === 'string' ? { message } : (message as object)),
      });
    }
  }

  private readonly SENSITIVE_FIELDS = new Set([
    'password',
    'secret',
    'token',
    'api_key',
    'apikey',
    'authorization',
  ]);

  private sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      const lowerKey = key.toLowerCase();
      // Redact if the key itself is sensitive or if a "key" field's value contains sensitive words
      if (
        this.SENSITIVE_FIELDS.has(lowerKey) ||
        (key === 'value' &&
          typeof body['key'] === 'string' &&
          this.SENSITIVE_FIELDS.has(body['key'].toLowerCase().replace(/_/g, '')))
      ) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private extractMessage(response: string | object): string {
    if (typeof response === 'string') return response;
    if ('message' in response) {
      const msg = (response as { message: unknown }).message;
      return Array.isArray(msg) ? msg.join(', ') : String(msg);
    }
    return 'An error occurred';
  }
}

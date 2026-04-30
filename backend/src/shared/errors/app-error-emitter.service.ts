import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface AppErrorPayload {
  source: string;
  code: string;
  message: string;
}

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Emits `app.error` events to the SSE stream consumed by the frontend
 * ErrorModal. Rate-limited per error code so that repeated failures
 * (e.g. an OAuth refresh failing every hour) don't spam the modal.
 *
 * Why a dedicated service: every NestJS service that emits `app.error`
 * was previously inlining the EventEmitter2 call + timestamp, with no
 * dedupe. That meant either silent log-only failures (most callers) or
 * redundant emissions on retry loops. Centralising here keeps the
 * payload shape consistent and the dedupe rules in one place.
 */
@Injectable()
export class AppErrorEmitterService {
  private readonly logger = new Logger(AppErrorEmitterService.name);
  private readonly lastEmitted = new Map<string, number>();

  constructor(private readonly eventEmitter: EventEmitter2) {}

  emit(
    payload: AppErrorPayload,
    opts: { dedupeWindowMs?: number } = {},
  ): boolean {
    const window = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    const now = Date.now();
    const last = this.lastEmitted.get(payload.code) ?? 0;
    if (window > 0 && now - last < window) {
      return false;
    }
    this.lastEmitted.set(payload.code, now);
    this.eventEmitter.emit('app.error', {
      ...payload,
      timestamp: new Date(now).toISOString(),
    });
    this.logger.warn(
      `app.error emitted: source=${payload.source} code=${payload.code} — ${payload.message}`,
    );
    return true;
  }

  /** Clear the dedupe window for a code so the next emit fires immediately. */
  clear(code: string): void {
    this.lastEmitted.delete(code);
  }
}

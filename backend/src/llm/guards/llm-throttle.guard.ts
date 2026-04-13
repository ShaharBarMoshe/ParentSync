import { Injectable, Logger } from '@nestjs/common';

const MAX_REQUESTS_PER_MINUTE = 14; // Gemini free tier allows 15 RPM, leave 1 buffer
const WINDOW_MS = 60_000;

@Injectable()
export class LlmRateLimiter {
  private readonly logger = new Logger(LlmRateLimiter.name);
  private readonly timestamps: number[] = [];

  async acquire(): Promise<void> {
    this.pruneOldEntries();

    if (this.timestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      const oldestInWindow = this.timestamps[0];
      const waitMs = oldestInWindow + WINDOW_MS - Date.now();
      this.logger.warn(
        `LLM rate limit reached (${MAX_REQUESTS_PER_MINUTE}/min). Waiting ${waitMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.pruneOldEntries();
    }

    this.timestamps.push(Date.now());
  }

  private pruneOldEntries(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  getCurrentCount(): number {
    this.pruneOldEntries();
    return this.timestamps.length;
  }
}

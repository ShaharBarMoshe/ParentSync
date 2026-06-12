import { Injectable, Logger } from '@nestjs/common';

/**
 * Tracks whether a sync cycle is active.
 * SyncService acquires before syncAll() and releases in the finally block.
 * DbHygieneService checks isLocked() before running VACUUM — if locked,
 * it skips and defers to the next maintenance window.
 */
@Injectable()
export class SyncLockService {
  private readonly logger = new Logger(SyncLockService.name);
  private locked = false;
  private lockedSince: Date | null = null;

  acquire(): void {
    this.locked = true;
    this.lockedSince = new Date();
  }

  release(): void {
    this.locked = false;
    this.lockedSince = null;
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** How long the lock has been held (for logging). */
  lockAgeMs(): number | null {
    return this.lockedSince ? Date.now() - this.lockedSince.getTime() : null;
  }
}

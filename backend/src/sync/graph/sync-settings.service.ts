import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';

/**
 * The two bits of settings access several nodes need, in one place so they do
 * not each grow their own copy.
 */
@Injectable()
export class SyncSettings {
  private readonly logger = new Logger(SyncSettings.name);

  constructor(private readonly settingsService: SettingsService) {}

  /** The calendar events are written to; `primary` when unset. */
  async calendarId(): Promise<string> {
    try {
      return (await this.settingsService.findByKey('google_calendar_id')).value;
    } catch {
      return 'primary';
    }
  }

  /**
   * Increment a small integer counter stored under a settings key.
   * Best-effort: failures are swallowed, because a metric must never be the
   * reason a sync fails.
   */
  async incrementMetric(key: string): Promise<void> {
    try {
      let current = 0;
      try {
        const parsed = Number.parseInt(
          (await this.settingsService.findByKey(key)).value,
          10,
        );
        if (!Number.isNaN(parsed)) current = parsed;
      } catch {
        // Usually seeded; if it is gone, start at 0.
      }
      await this.settingsService.create({ key, value: String(current + 1) });
    } catch (err) {
      this.logger.debug(
        `Failed to increment metric ${key}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Whether an event's moment has already passed. An event with no time is
 * treated as lasting until the end of its day.
 */
export function isDateInPast(
  date: string,
  time: string | undefined,
  now: Date,
): boolean {
  const dateStr = time ? `${date}T${time}:00` : `${date}T23:59:59`;
  return new Date(dateStr).getTime() < now.getTime();
}

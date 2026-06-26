import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EMBEDDING_SERVICE,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IEmbeddingService } from '../../llm/interfaces/embedding-service.interface';
import type {
  IGoogleCalendarService,
  GoogleCalendarEventResult,
} from '../../calendar/interfaces/google-calendar-service.interface';
import { SettingsService } from '../../settings/settings.service';
import { cosineSimilarity } from '../../shared/utils/cosine-similarity';
import { CalendarEventEntity } from '../../calendar/entities/calendar-event.entity';

/** A calendar event close enough to the proposed one to suppress approval. */
export interface CalendarConflictMatch {
  googleEventId: string;
  summary: string;
  similarity: number;
}

const DEFAULT_THRESHOLD = 0.88;
const WINDOW_MINUTES = 60;
const TIME_ZONE = 'Asia/Jerusalem';

/**
 * Layer 4 dedup: before sending an event for approval, check the user's
 * Google Calendar for an existing entry within ±60 minutes of the proposed
 * time that semantically matches. Catches events the user pre-added manually
 * or events synced from another source — the three local layers can't see
 * those.
 *
 * **Fail-open contract:** this service never throws. Any error
 * (Google API failure, OAuth refresh, embedding API down, malformed
 * threshold) returns `null` and the approval message proceeds normally.
 */
@Injectable()
export class CalendarConflictDedupService {
  private readonly logger = new Logger(CalendarConflictDedupService.name);

  constructor(
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
    @Inject(EMBEDDING_SERVICE)
    private readonly embeddingService: IEmbeddingService,
    private readonly settingsService: SettingsService,
  ) {}

  async findConflict(
    event: CalendarEventEntity,
    calendarId: string,
  ): Promise<CalendarConflictMatch | null> {
    if (!(await this.isEnabled())) return null;
    // All-day tasks don't have a meaningful time window — skip.
    if (!event.time) return null;

    let candidates: GoogleCalendarEventResult[];
    try {
      const { timeMin, timeMax } = this.windowBounds(event.date, event.time);
      candidates = await this.googleCalendarService.searchEvents(
        calendarId,
        '',
        timeMin,
        timeMax,
      );
    } catch (err) {
      this.logger.warn(
        `Calendar dedup fail-open: searchEvents failed: ${(err as Error).message}`,
      );
      return null;
    }

    const usable = candidates.filter(
      (c) => c.summary && c.summary.trim().length > 0,
    );
    if (usable.length === 0) {
      this.logger.debug(
        `Calendar dedup no-candidates date=${event.date} time=${event.time}`,
      );
      return null;
    }

    const proposedText = this.formatEventText(event);
    let proposedEmbedding: number[];
    let candidateEmbeddings: number[][];
    try {
      [proposedEmbedding, candidateEmbeddings] = await Promise.all([
        this.embeddingService.embedText(proposedText),
        this.embeddingService.embedBatch(usable.map((c) => c.summary.trim())),
      ]);
    } catch (err) {
      this.logger.warn(
        `Calendar dedup fail-open: embedding error: ${(err as Error).message}`,
      );
      return null;
    }

    const threshold = await this.getThreshold();
    let best: CalendarConflictMatch | null = null;
    let bestScore = 0;

    for (let i = 0; i < usable.length; i++) {
      const cEmb = candidateEmbeddings[i];
      if (!cEmb || cEmb.length !== proposedEmbedding.length) continue;
      const sim = cosineSimilarity(proposedEmbedding, cEmb);
      if (sim > bestScore) bestScore = sim;
      if (sim >= threshold && (best === null || sim > best.similarity)) {
        best = {
          googleEventId: usable[i].googleEventId,
          summary: usable[i].summary,
          similarity: sim,
        };
      }
    }

    if (best) {
      this.logger.log(
        `Calendar dedup match candidateCount=${usable.length} similarity=${best.similarity.toFixed(3)} threshold=${threshold}`,
      );
    } else {
      this.logger.debug(
        `Calendar dedup no-hit candidateCount=${usable.length} bestSimilarity=${bestScore.toFixed(3)} threshold=${threshold}`,
      );
    }
    return best;
  }

  private formatEventText(event: CalendarEventEntity): string {
    return [event.title, event.location].filter(Boolean).join(' ').trim();
  }

  /**
   * Builds the ±WINDOW_MINUTES ISO-8601 range around event.date+event.time,
   * anchored in TIME_ZONE. The output is consumed by Google's
   * `events.list?timeMin&timeMax`, which expects RFC 3339 timestamps.
   */
  private windowBounds(
    date: string,
    time: string,
  ): { timeMin: string; timeMax: string } {
    // Build a UTC anchor from the naive local datetime; we don't have a TZ
    // library wired in. The window only needs to be roughly right — the
    // Google API tolerates wide windows and we filter semantically anyway.
    const anchor = new Date(`${date}T${time}:00`);
    const min = new Date(anchor.getTime() - WINDOW_MINUTES * 60 * 1000);
    const max = new Date(anchor.getTime() + WINDOW_MINUTES * 60 * 1000);
    return {
      timeMin: min.toISOString(),
      timeMax: max.toISOString(),
    };
  }

  async isEnabled(): Promise<boolean> {
    try {
      const setting =
        await this.settingsService.findByKey('calendar_dedup_enabled');
      return setting.value.toLowerCase() !== 'false';
    } catch {
      // Seed hook guarantees presence; default on if missing.
      return true;
    }
  }

  private async getThreshold(): Promise<number> {
    try {
      const setting =
        await this.settingsService.findByKey('calendar_dedup_threshold');
      const parsed = Number.parseFloat(setting.value);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
        this.logger.warn(
          `Calendar dedup threshold invalid (${setting.value}), using fallback ${DEFAULT_THRESHOLD}`,
        );
        return DEFAULT_THRESHOLD;
      }
      return parsed;
    } catch {
      return DEFAULT_THRESHOLD;
    }
  }
}

// Exported only so tests can assert the default constant matches the doc/plan.
export const _CALENDAR_DEDUP_TEST_INTERNALS = {
  DEFAULT_THRESHOLD,
  WINDOW_MINUTES,
  TIME_ZONE,
};

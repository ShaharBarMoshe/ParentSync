/**
 * Production smoke test (Phase 25) — shared constants and types.
 *
 * The smoke test drives one synthetic event through the entire pipeline
 * (WhatsApp send → scrape → LLM parse → approval card → 👍 reaction →
 * Google Calendar) on every new deployment and daily at 07:00, then cleans
 * up after itself. See docs/phase25-production-smoke-test.md.
 */

/**
 * Marker embedded in the smoke-test source message. The WhatsApp scrape
 * normally drops the app's own outgoing messages (`isSentByMe`); messages
 * carrying this marker are the one exception so the test can read its own
 * message back through the real scrape path.
 *
 * It must NOT contain the APP_MESSAGE_MARKER text ("— ParentSync") — that
 * marker is filtered out by SyncService, which would hide the test message.
 */
export const SMOKE_TEST_MARKER = '[ps-smoke-test]';

/** Settings keys owned by the smoke test. */
export const SMOKE_TEST_ENABLED_KEY = 'smoke_test_enabled';
export const SMOKE_TEST_LAST_VERSION_KEY = 'smoke_test_last_version';

/** Cron job name (registered via SchedulerRegistry). */
export const SMOKE_TEST_CRON_JOB = 'smoke-test-daily';
/**
 * Daily at 07:30 local time.
 *
 * Deliberately **not** on the hour. Scheduled syncs run at the top of every
 * hour from 07:00 to 22:00, and a smoke run at 07:00 started 13ms before the
 * 07:00 sync: the smoke test finished and swept up while that sync was still
 * walking its channel list, so when the scan finally reached the approval
 * channel it found the smoke message, stored it as a real one and raised a
 * real approval card — after the only thing that would have cleaned it up had
 * already run.
 *
 * The filter in `SyncService` is what actually fixes that race; this offset
 * just keeps the two jobs from contending in the first place.
 */
export const SMOKE_TEST_CRON_EXPRESSION = '30 7 * * *';

export type SmokeTestStatus = 'passed' | 'failed' | 'skipped';
export type SmokeTestTrigger = 'deploy' | 'cron' | 'manual';

export interface SmokeTestStep {
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface SmokeTestResult {
  runId: string;
  trigger: SmokeTestTrigger;
  status: SmokeTestStatus;
  startedAt: string;
  endedAt: string;
  failedStep?: string;
  skipReason?: string;
  steps: SmokeTestStep[];
  // Post-run teardown. Populated in the `finally` of a run; each artifact
  // deletion is recorded so a silent cleanup failure is no longer invisible.
  cleanup?: SmokeTestStep[];
  // True when at least one cleanup step failed — a "passed but dirty" run that
  // left artifacts behind. Surfaced in latest.json and the FAIL log.
  cleanupFailed?: boolean;
  // Useful identifiers for debugging a failed run.
  sourceMessageId?: string;
  approvalMessageId?: string;
  eventId?: string;
  googleEventId?: string;
}

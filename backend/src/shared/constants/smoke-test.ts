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
/** Daily at 07:00 local time. */
export const SMOKE_TEST_CRON_EXPRESSION = '0 7 * * *';

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

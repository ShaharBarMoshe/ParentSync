/**
 * Date helpers for e2e fixtures.
 *
 * Events dated today or earlier are skipped at creation time
 * (`EventSyncService.createEventsInTransaction`), and Gmail/WhatsApp fetches
 * only look back a fixed scan window. A hard-coded fixture date therefore
 * works right up until it ages past those cutoffs, at which point the test
 * fails for a reason unrelated to what it is asserting. Always derive fixture
 * dates from the current time instead.
 */

/** `YYYY-MM-DD`, `n` days from now (negative for the past). */
export function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
}

/** A `Date` `n` minutes ago — for message timestamps inside the scan window. */
export function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

/** A `Date` `n` days ago. */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

import { execSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Compilation smoke tests — verify that both backend and frontend TypeScript
 * compiles and both bundles build. These catch type errors, missing imports and
 * interface mismatches that unit tests miss, because a unit test mocks the
 * module it would otherwise fail to import.
 *
 * Two things these got wrong, both fixed here:
 *
 * **The timeouts were too tight.** `nest build` takes ~42 s on an idle machine
 * against what used to be a 60 s cap — 1.4x headroom. Under any load (the three
 * sibling compiles here, or other jest workers) it blew through it, so the suite
 * failed roughly half the time while passing when run alone. A test that fails
 * half the time teaches everyone to ignore a red suite, which is the same
 * reasoning that gates the live e2e specs; see `helpers/live-e2e.ts`.
 *
 * **A failure said nothing.** `expect(() => execSync(...)).not.toThrow()`
 * discards the compiler's output, so a genuine type error reported only
 * "backend NestJS build succeeds" with no diagnostics. `runBuild` captures
 * stdout/stderr and puts them in the failure message instead.
 */
function runBuild(label: string, command: string, cwd: string, timeoutMs: number): void {
  try {
    execSync(command, {
      cwd,
      stdio: 'pipe',
      timeout: timeoutMs,
      encoding: 'utf8',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; signal?: string; message?: string };
    // A timeout arrives as SIGTERM with empty output, which is worth naming
    // explicitly — it is a different problem from a compile error.
    const timedOut = e.signal === 'SIGTERM';
    const detail = timedOut
      ? `timed out after ${timeoutMs}ms (the machine may be loaded; this is not a compile error)`
      : [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || e.message || 'no output';
    throw new Error(`${label} failed:\n${detail}`);
  }
}

/**
 * Generous on purpose. These shell out to real compilers, so the number only
 * has to be comfortably above the worst case — being tight buys nothing and
 * costs a flaky suite.
 */
const TSC_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 240_000;

describe('Compilation (e2e)', () => {
  it(
    'backend TypeScript compiles without errors (production code)',
    () => {
      runBuild(
        'backend tsc --noEmit',
        'npx tsc --noEmit -p tsconfig.build.json',
        path.join(ROOT, 'backend'),
        TSC_TIMEOUT_MS,
      );
    },
    TSC_TIMEOUT_MS + 30_000,
  );

  it(
    'backend NestJS build succeeds',
    () => {
      runBuild(
        'backend nest build',
        'npx nest build',
        path.join(ROOT, 'backend'),
        BUILD_TIMEOUT_MS,
      );
    },
    BUILD_TIMEOUT_MS + 30_000,
  );

  it(
    'frontend TypeScript compiles without errors',
    () => {
      runBuild(
        'frontend tsc --noEmit',
        'npx tsc --noEmit',
        path.join(ROOT, 'frontend'),
        TSC_TIMEOUT_MS,
      );
    },
    TSC_TIMEOUT_MS + 30_000,
  );

  it(
    'frontend Vite build succeeds',
    () => {
      runBuild(
        'frontend vite build',
        'npx vite build',
        path.join(ROOT, 'frontend'),
        BUILD_TIMEOUT_MS,
      );
    },
    BUILD_TIMEOUT_MS + 30_000,
  );
});

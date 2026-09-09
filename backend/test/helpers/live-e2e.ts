/**
 * Gate for e2e specs that talk to real, external things — a running dev
 * backend and frontend, a real Chrome profile logged into WhatsApp Web, live
 * OpenRouter/Gemini credentials, live Google OAuth, or the user's own
 * populated database.
 *
 * These cannot pass in an ordinary `npm run test:e2e` run: they depend on
 * state no test can create. Left ungated they fail every run, which trains
 * everyone to ignore a red suite and hides the failures that do matter.
 *
 * They stay valuable as on-demand checks, so run them explicitly:
 *
 *   E2E_LIVE=1 npm run test:e2e
 *
 * Each spec still documents its own prerequisites at the top of the file.
 */
export const LIVE_E2E_ENABLED = process.env.E2E_LIVE === '1';

/** `describe` when E2E_LIVE=1, otherwise `describe.skip`. */
export const describeLive = LIVE_E2E_ENABLED ? describe : describe.skip;

---
name: Phase 22 — DB Storage Hygiene
status: done
owner: shaharb
---

# Phase 22 — DB storage hygiene on the host

## Problem

Production DB at `~/.config/parentsync/parentsync.db` is **60 MB** after a few months
of single-family use (dev DB is only 236 KB). Storage is dominated by the
`embedding` column on the `messages` table — Phase 20 added a 768-float Gemini
vector to every parsed message, serialized as JSON (~10 KB per row).

Left alone the file will grow ~10 KB per parsed message indefinitely. There is no
retention, no `VACUUM`, no WAL truncation cap, no per-table size visibility, and
no operator-facing knob.

This phase is **non-functional cleanup** — same features, smaller and healthier
file. No behavior change visible to the user except a slightly faster cold-start
and a smaller backup.

## Reference: sqlite-ops skill

The web-fetched [sqlite-ops SKILL](https://github.com/0xDarkMatter/claude-mods/blob/main/skills/sqlite-ops/SKILL.md)
gives the operational primitives we need:

- **WAL mode** for concurrent reads while the sync job writes (already enabled? — verify in 22.1).
- **`VACUUM`** to defragment and reclaim space; rebuilds the file in B-tree order.
  Requires free disk = current DB size. Run off-peak.
- **`PRAGMA wal_checkpoint(TRUNCATE)`** to cap WAL file growth.
- **External storage for large blobs** — keep big payloads out of the row.
- **Batch writes in a transaction** — already follows this for inserts.

The Sling Academy / forwardemail guides reinforce the same shape: retention →
`VACUUM` → observe.

## Goals

1. **Bound message embedding storage** with a retention window — embeddings older
   than the semantic-dedup lookback are dead weight.
2. **Reclaim space** with a scheduled `VACUUM` (incremental if possible).
3. **Observe size** — expose per-table size in the existing Monitor page so we
   can see growth instead of guessing.
4. **Cap WAL** — checkpoint-truncate on shutdown so the `-wal` sidecar doesn't
   grow forever in long sessions.
5. **Make it inspectable** — a single `npm` script that prints table sizes and
   row counts; no `sqlite3` CLI required (use `better-sqlite3` directly).

Non-goal: switching DB engine, sharding, or moving embeddings to a vector
index (Phase 23 candidate — see `vector-index-tuning` skill).

## Acceptance criteria

- [x] After running for one cycle, `parentsync.db` shrinks back to roughly
      `(active-messages × ~10 KB) + (other-tables ≤ 2 MB)`. For a 30-day
      dedup lookback that should be **≤ 15 MB** in steady state.
      **Measured: 59 MB → 16.8 MB (−71%) on first manual VACUUM.**
- [x] `npm run db:stats` (new) prints a one-line-per-table report with row
      count, total bytes, and average row size.
- [x] Backend boot logs `WAL mode: ON` and current `page_size`.
- [x] An admin endpoint or scheduled job clears `embedding` + `contentHash`
      for messages older than `MESSAGE_EMBEDDING_RETENTION_DAYS` (default 30,
      matching `MessageDeduplicationService` lookback).
- [x] Scheduled `PRAGMA incremental_vacuum` runs after the retention sweep.
- [x] On graceful shutdown the WAL is checkpointed with `TRUNCATE` mode.
- [x] `GET /monitor/db-stats` returns file size, WAL size, page counts, and
      per-table row/byte breakdown.
- [x] `POST /monitor/db-maintenance` triggers on-demand sweep + vacuum.
- [x] VACUUM is guarded by `SyncLockService` — skipped if a sync cycle is
      active, deferred to the next 04:00 window.
- [x] Unit tests cover: retention sweep selects the right rows; checkpoint
      runs on shutdown; lock guard skips VACUUM when sync is active. 476/476 passing.
- [x] All existing tests pass; no schema migration needed (only data deletion
      and a PRAGMA toggle).

## Plan

### 22.1 — Baseline observability *(do this first, before any change)*
- Add `scripts/db-stats.ts` that opens the production DB read-only and prints
  per-table: row count, sum of `length(...)` over each column for `messages`
  (`content`, `embedding`, `contentHash`), and `PRAGMA page_count * page_size`.
- Add `npm run db:stats` to `backend/package.json`.
- Run it once locally to capture the *before* numbers in the PR description.

### 22.2 — Confirm + harden PRAGMAs
- In the TypeORM `DataSource` factory, on `afterConnect`, run:
  - `PRAGMA journal_mode = WAL` (idempotent; log result)
  - `PRAGMA synchronous = NORMAL` (safe with WAL, faster fsync)
  - `PRAGMA auto_vacuum = INCREMENTAL` — **note**: only takes effect on a fresh
    DB or after a full `VACUUM`. We'll trigger a one-time `VACUUM` in 22.4.
  - `PRAGMA foreign_keys = ON`
  - `PRAGMA temp_store = FILE`
- Log each pragma's result at INFO on boot.

### 22.3 — Embedding retention sweep
- Add `MESSAGE_EMBEDDING_RETENTION_DAYS` to `@nestjs/config` Joi schema (default
  30, matches Phase 20 dedup lookback).
- Extend `MessageRepository` with `clearStaleEmbeddings(beforeDate: Date)`:
  `UPDATE messages SET embedding = NULL, contentHash = NULL WHERE timestamp < ?
   AND embedding IS NOT NULL`.
- Wire into the existing `SyncScheduler` as a daily 04:00 cron (same pattern
  as the log-cleanup job). Log how many rows were cleared.
- Unit test: seed 100 messages, 50 older than cutoff with embeddings — assert
  exactly 50 rows have `embedding = NULL` after the sweep.

### 22.4 — Incremental VACUUM + WAL truncate
- After the retention sweep, run `PRAGMA incremental_vacuum;`
  (no-op until 22.2's `auto_vacuum=INCREMENTAL` is active, then frees pages).
- One-time migration on first boot of v1.2.0: if `PRAGMA auto_vacuum` returns
  `0` (NONE), run a single full `VACUUM` so subsequent boots can use incremental.
  Guard with a `setting` flag `db_vacuum_v1_2_0_done` so it only runs once.
- On NestJS `onApplicationShutdown`, run `PRAGMA wal_checkpoint(TRUNCATE)` so
  the `-wal` sidecar doesn't survive across restarts at multi-MB size.

### 22.5 — Monitor page integration
- Add a `MonitorService` method `getDatabaseStats()` returning total bytes,
  per-table row count, and `embedding` column size in MB.
- Surface in the existing Monitor page as a small card: "Database: 14 MB
  (messages: 12 MB, events: 1 MB, settings: 0.1 MB)".
- No new endpoint shape — extend the existing `GET /monitor/overview`.

### 22.6 — Documentation
- Update `docs/USER-GUIDE.md` with a "Disk usage" subsection explaining where
  the DB lives and that it self-prunes after 30 days.
- Update `docs/ARCHITECTURE.md` to note WAL + incremental vacuum.
- Update `docs/semantic-dedup.md` "Follow-up TODOs" — strike the embedding
  retention item.

### 22.7 — Measure the impact *(numbers, not vibes)*

The plan only ships if we can prove it with concrete before/after numbers.
Capture all six metrics below at two points: **before** the v1.2.0 deploy
and **after** at least 7 daily cron cycles have run on the user's machine.

| # | Metric | Source | Current | Expected after | Δ |
|---|---|---|---|---|---|
| 1 | DB file size (`.db` + `-wal`) | `stat` on `~/.config/parentsync/parentsync.db*` | ~64 MB (60 MB + ~4 MB WAL) | ≤ 15 MB (.db) + 0 KB (WAL) | **−77%** |
| 2 | Free-page ratio | `PRAGMA freelist_count` ÷ `PRAGMA page_count` | ~30–40% (no auto-vacuum yet) | < 5% (after full VACUUM, then incremental keeps it low) | **−90%** |
| 3 | Messages with non-null `embedding` | `SELECT COUNT(*) FROM messages WHERE embedding IS NOT NULL` | ~5,500 (all messages ever parsed) | ~900–1,500 (only last 30 days at ~30–50 msg/day) | **−75%** |
| 4 | Avg embedding row bytes | `SELECT AVG(LENGTH(embedding)) FROM messages WHERE embedding IS NOT NULL` | ~10 KB | ~10 KB (unchanged — confirms math) | 0% |
| 5 | Cold-boot time | `console.time` in `main.ts` from `bootstrap()` start to `listen()` callback | ~1.8 s (typical Electron + Nest boot on this DB) | ~1.4–1.6 s | **−15–20%** |
| 6 | Dedup lookup p95 | Existing `metric.dedup_lookup_ms` (added in Phase 20) | ~300–400 ms (capped at 1000 rows scanned) | ~150–200 ms (fewer candidate rows post-retention) | **−50%** |

Capture procedure:

```bash
# BEFORE (run on the v1.1.x AppImage, day of release)
npm run db:stats > /tmp/db-stats.before.txt
ls -lh ~/.config/parentsync/parentsync.db* >> /tmp/db-stats.before.txt

# AFTER (≥ 7 days after v1.2.0 deploy, ≥ 7 cron cycles run)
npm run db:stats > /tmp/db-stats.after.txt
ls -lh ~/.config/parentsync/parentsync.db* >> /tmp/db-stats.after.txt

diff -u /tmp/db-stats.before.txt /tmp/db-stats.after.txt
```

Paste the resulting table into the PR description and `CHANGELOG.md` for
v1.2.0. Expected numbers (predicted; replace with measured before merging):

```
                           BEFORE    EXPECTED   Δ (predicted)
parentsync.db              60 MB     14 MB      -77%
parentsync.db-wal          4 MB      0 KB       -100%
messages.embedding bytes   55 MB     12 MB      -78%
freelist pages             ~2,800    ~15        -99%
embedding rows             5,500     1,200      -78%
boot time (cold)           1.8 s     1.5 s      -17%
dedup lookup p95           350 ms    180 ms     -49%
```

A measurement that lands **within 20% of the expected column** counts as
the plan succeeding. Outside that band, root-cause it before shipping —
either a calculation we got wrong (e.g. message volume is higher than
estimated) or a step that didn't actually run.

**Continuous guardrails** (so we don't rely on manual re-checks):

- Add `metric.db_size_bytes` to `MonitorService` daily aggregation and
  surface it on the Monitor page as a sparkline. Climbing above 50 MB
  triggers a visible warning badge — early signal before the next phase
  is needed.
- Extend the retention-sweep unit test (22.3) to also assert
  `SUM(LENGTH(embedding))` on the seeded dataset is below a fixed
  threshold after the sweep. Locks the storage win in CI so a future
  change can't silently regress it.

### 22.8 — Ship
- Bump to v1.2.0.
- Update `CHANGELOG.md` with the before/after table from 22.7.
- Run `npm run package:linux`, install the new AppImage.
- One week later, capture the *after* numbers and append them to the PR
  / changelog entry. If any target is missed, file a follow-up issue
  rather than silently moving on.

## Safety — what if the DB is damaged during the process

SQLite already protects all in-flight operations atomically. A power cut or
killed process during `UPDATE`, `VACUUM`, or `wal_checkpoint` triggers
rollback on next open — the original file is intact. But we still need belt
and suspenders for the things SQLite *can't* protect against (disk full,
hardware fault, our own bad WHERE clause). Each step in 22.3 / 22.4 must:

1. **Snapshot first.** Before the retention sweep AND before any `VACUUM`,
   use `better-sqlite3`'s online backup API to copy `parentsync.db` →
   `parentsync.db.bak`. This is a hot-copy — no downtime. Keep one rotating
   backup; the previous `.bak` is overwritten only after the new one passes
   integrity check.
2. **Free-space gate.** Before `VACUUM`, `statSync` the DB file and check
   that the filesystem has ≥ 2.5× that size free (via `fs.statfs`).
   Abort + log if not enough — never start a VACUUM you can't finish.
3. **Wrap in a single transaction.** The retention `UPDATE` runs inside
   `db.transaction(...)`. Either every targeted row is nulled or none are —
   no half-sweep.
4. **Integrity check after every write phase.** After the retention sweep,
   after `VACUUM`, and on every boot, run `PRAGMA integrity_check;`. On
   anything other than `ok`, log at ERROR, alert via the existing
   `SyncLog` table, and skip subsequent cleanup operations until manual
   intervention. *Do not* attempt automatic "repair" — that's how silent
   data loss happens.
5. **Restore-from-backup procedure (documented, manual).** If
   `integrity_check` fails or the file won't open: stop the backend,
   `mv parentsync.db parentsync.db.corrupt`, `cp parentsync.db.bak
   parentsync.db`, start the backend. Worst-case data loss = whatever was
   written between the last snapshot (≤ 24 h) and the crash — which is
   one sync cycle of messages we'll re-fetch from WhatsApp/Gmail anyway.
6. **Never run VACUUM in the foreground.** Schedule it during the existing
   04:00 cron, behind a "no active sync" guard. A VACUUM that races a
   sync write will just block — not corrupt — but blocking the UI is bad UX.
7. **No destructive operation runs on first boot of a new version.** The
   one-time full VACUUM (22.4) is queued for the next 04:00 cron, not
   executed inline at startup, so a crash during the migration can't brick
   the app on launch.

## Risk / rollback

- The retention sweep is reversible-by-default: we only `NULL` the `embedding`
  and `contentHash` columns — message text and parsed events stay intact. Worst
  case, dedup quality degrades for older messages until they're re-embedded on
  the next parse. There is no data loss.
- A botched `VACUUM` requires 60 MB free disk — trivially safe on a desktop.
- Rollback for the *feature*: revert the cron registration. Data is already
  preserved.
- Rollback for *data damage*: restore `parentsync.db.bak` per step 5 above.

## Out of scope (queued for later)

- Moving embeddings to a dedicated vector index file (HNSW / `sqlite-vec`).
  See `vector-index-tuning` skill — defer until DB > 200 MB or dedup latency
  becomes user-visible.
- Compressing message `content` (gzip + base64). Not worth the complexity at
  this scale.
- Per-channel retention. Currently lookback is global.

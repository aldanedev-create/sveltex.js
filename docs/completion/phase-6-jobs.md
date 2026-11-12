# Phase 6 — Jobs completion report

**Status:** implemented, tested against real Redis 7 (`ioredis` + Lua scripts) and real
SQLite / PostgreSQL 16 (SQL executor + `FOR UPDATE SKIP LOCKED` transactions), documented.
Phase 6 done; Phases 7–12 remain.

**Measured full-monorepo gate:** `pnpm check` → **806/806** runtime (0 failures, 0 skipped,
16 test projects), `pnpm test:security` → **141/141** (16 packages), `pnpm test:types` →
**16/16**, `pnpm --filter @sveltex/jobs test:integration` → **17/17** (Redis 7 + SQLite +
PostgreSQL 16), all exit 0 with live PostgreSQL 16 / MySQL 8.0 / Redis 7 services.

## Objective

Per [`docs/completion-plan.md`](../completion-plan.md) Phase 6, close every gap the Phase 0 audit
recorded for `@sveltex/jobs` **without creating a new package**. The Phase 0 table read:

> Queue, retries, exponential backoff, dedup, concurrency, worker shutdown ✅ (in-memory queue);
> **Redis-backed queue, DB-backed queue, persistence** ✗ (README: "no broker/provider adapter").

Core rule honored: **finish what SvelteX already promises before making SvelteX promise more.**
No placeholder package, no fake provider, no skipped test.

## Gap → delivery

| Gap / requirement | Delivered | Reality |
| --- | :---: | --- |
| Redis-backed queue | ✅ | `RedisJobQueue` using real `ioredis` with four Lua scripts (`ENQUEUE_LUA`, `CLAIM_LUA`, `FINALIZE_LUA`, `CANCEL_LUA`) for atomic cross-process enqueue / claim / finalize / cancel. ZSET by `availableAt`, SET of all ids, per-id job records, dedupe key mapping. |
| Database-backed queue | ✅ | `SqlJobQueue` using a BYO `JobSqlExecutor` port (`@sveltex/database`'s `Database` satisfies it). `sqlite` and `postgres` dialects. Transaction-based atomic claim with `FOR UPDATE SKIP LOCKED` (PostgreSQL) / `LIMIT` (SQLite). Partial unique dedupe index. Concurrent-safe schema creation. |
| Persistence | ✅ | Both `RedisJobQueue` and `SqlJobQueue` store every job as a strict `sveltex-jobs:v1:` record; records survive process restart. `decodeJobRecord` validates the full record (version, status, id, name, payload envelope) and rejects corrupt / legacy / tampered records. |
| Job registration | ✅ | `JobRegistry` with `register()` / `registerAll()` / `has()` / `get()` / `names()` / `createHandler()`. Unregistered jobs throw typed `JobsError('SX_JOBS_UNREGISTERED')` so the worker retry / dead-letter path applies. |
| Job scheduling | ✅ | `JobScheduler` with `enqueue()` / `scheduleAt()` / `scheduleIn()`. Clock-injectable. `computeDelayMs()` validates timestamps. |
| Delayed jobs | ✅ | `availableAt` field respected by all three queue implementations (in-memory, Redis, SQL). Redis ZSET score; SQL `available_at` column with indexed filter. |
| Job cancellation | ✅ | `JobQueue.cancel(id)` added to the interface and implemented by all three backends. Redis uses `CANCEL_LUA`; SQL uses conditional `UPDATE ... SET status = 'cancelled'`. |
| Strict payload serialization | ✅ | `sveltex-jobs:v1:` envelope (`serializeJobPayload` / `deserializeJobPayload`). `u` tag for `undefined`, `j` tag for strict JSON. Rejects `Date`, `Map`, `Set`, `RegExp`, `bigint`, `symbol`, `function`, nested `undefined`, non-finite numbers, typed arrays, circular objects, custom class instances. `__proto__` / `constructor` / `prototype` keys stripped. `MAX_PAYLOAD_BYTES = 64 KiB`, `MAX_RECORD_BYTES = 128 KiB`. |
| Shared validation | ✅ | `validation.ts` centralizes job name grammar (`/^[A-Za-z0-9._:-]{1,128}$/`), id / dedupe key / table name / error length limits, timestamp and claim validation across all backends. |
| Typed errors | ✅ | `JobsSerializationError`, `JobsConfigurationError`, `JobsStoreError` (with `operation` field and `cause` chain). |
| In-memory dev/test queue | ✅ | `InMemoryJobQueue` retained and rewritten to use the shared validation module; existing 17 runtime + 7 security test semantics preserved. |
| Real integration, no fakes | ✅ | 51 runtime + 17 security unit tests; 17 integration tests against real Redis 7, real SQLite (`node:sqlite`), and real PostgreSQL 16. No fake provider, no skipped test. |

## What Phase 6 added

| Area | File | Content |
| --- | --- | --- |
| Errors + contracts | `src/index.ts` (extended) | `JobsSerializationError`, `JobsConfigurationError`, `JobsStoreError`; `JobQueue.cancel(id)` added to the interface. |
| Shared validation | `src/validation.ts` (new) | `JOB_NAME_PATTERN`, `MAX_JOB_ID_LENGTH`, `MAX_DEDUPE_KEY_LENGTH`, `MAX_ERROR_LENGTH`, `validateEnqueueOptions`, `validateClaim`, `validateFailOptions`, `validateJobId`, `validateTableName`, `validateTimestamp`. |
| Strict serialization | `src/serialization.ts` (new) | `JOBS_ENVELOPE_VERSION = 1`, `JOBS_ENVELOPE_PREFIX = 'sveltex-jobs:v1:'`, `MAX_PAYLOAD_BYTES = 64 KiB`, `MAX_RECORD_BYTES = 128 KiB`, `serializeJobPayload` / `deserializeJobPayload` / `encodeJobRecord` / `decodeJobRecord` / `decodeJob`. Shared `parseStrictPayload` used by both `deserializeJobPayload` and `decodeJobRecord`. |
| Redis queue | `src/redis.ts` (new) | `RedisJobQueue` with real `ioredis`, lazy-connect, four Lua scripts, ZSET ready queue, SET of all ids, per-id job records, dedupe key mapping, `JobsStoreError` wrapping. |
| SQL queue | `src/sql.ts` (new) | `SqlJobQueue` with BYO `JobSqlExecutor` port, `sqlite` / `postgres` dialects, `$n` placeholder rendering, transaction-based atomic claim (`FOR UPDATE SKIP LOCKED`), partial unique dedupe index, concurrent-safe schema creation (catches `duplicate_table` / unique-violation race). |
| Registry | `src/registry.ts` (new) | `JobRegistry` with typed `SX_JOBS_UNREGISTERED` error for unregistered job names. |
| Scheduler | `src/scheduler.ts` (new) | `JobScheduler` with `enqueue` / `scheduleAt` / `scheduleIn`, `computeDelayMs`. |
| In-memory queue | `src/in-memory.ts` (rewritten) | Now uses shared validation module; `cancel()` implemented; existing semantics preserved. |
| Exports | `package.json` | Six new subpath exports: `./validation`, `./serialization`, `./registry`, `./scheduler`, `./redis`, `./sql`. `ioredis@^6.0.0` is the only new runtime dependency. Version stays `0.1.0`. |
| Tests | `tests/serialization.test.mjs` (8), `tests/registry.test.mjs` (5), `tests/scheduler.test.mjs` (4), `tests/security/phase6-security.test.mjs` (10), `tests/integration/redis.test.mjs` (7), `tests/integration/sql.test.mjs` (10), `tests/types/public-api.test.ts` (extended). |
| Docs | `README.md`, `CHANGELOG.md` | Rewritten with Redis / SQL backends, strict serialization, registry, scheduler, API surface and honest limitations. |

## Architecture

### Strict payload serialization

```
sveltex-jobs:v1:u          → undefined
sveltex-jobs:v1:j{...}     → strict JSON (no silent coercion, __proto__ stripped)
```

`decodeJobRecord` validates:
- Envelope prefix (`sveltex-jobs:v1:`)
- Record version (`v === 1`)
- Status (one of `pending`, `active`, `completed`, `failed`, `cancelled`, `dead-letter`)
- `id` (string, ≤ 256 chars)
- `name` (matches `JOB_NAME_PATTERN`)
- Payload is a valid `sveltex-jobs:v1:` envelope (not plaintext)
- `attempts` (non-negative integer)
- Timestamps (non-negative integers)

Corrupt, legacy (`v: 2`), tampered (`status: 'bogus'`, `payload: 'plaintext'`, `id: 9`,
`attempts: -1`) records are rejected with `JobsSerializationError` — never coerced.

### Redis queue

Keys:
```
<prefix>ready          # ZSET by availableAt
<prefix>all            # SET of job ids
<prefix>job:<id>       # strict job record JSON
<prefix>dedupe:<key>   # dedupe key → job id
```

Lua scripts: `ENQUEUE_LUA` (atomic add to ready ZSET + all SET + job record + dedupe),
`CLAIM_LUA` (atomic ZPOPMIN-style claim with stale-entry denial), `FINALIZE_LUA`
(idempotent complete/fail/dead-letter), `CANCEL_LUA` (conditional cancel).

### SQL queue

Schema:
```sql
CREATE TABLE IF NOT EXISTS <table> (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,       -- strict sveltex-jobs:v1: envelope
  status TEXT NOT NULL DEFAULT 'pending',
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  dedupe_key TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS <table>_ready ON <table>(status, available_at);
CREATE UNIQUE INDEX IF NOT EXISTS <table>_dq ON <table>(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','active');
```

Claim transaction:
```sql
SELECT id FROM <table>
WHERE status = ? AND available_at <= ?
ORDER BY available_at, created_at, id
LIMIT ? FOR UPDATE SKIP LOCKED;
UPDATE <table> SET status = ?, attempts = attempts + 1
WHERE id IN (...) AND status = ?;
SELECT ... FROM <table> WHERE id IN (...);
```

PostgreSQL renders `?` → `$1..$n`; SQLite uses `?`.

Concurrent schema creation: `CREATE TABLE IF NOT EXISTS` is not atomic across connections
on PostgreSQL (`duplicate key` on `pg_type`). `#createSchema` catches and swallows
`duplicate_table` / unique-violation errors when the table/index already exists.

## Measured verification

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm check` | **806/806** runtime, 0 failures, 0 skipped, 16 test projects |
| `pnpm test:security` | **141/141**, 16 packages, 0 failures, 0 skipped |
| `pnpm --filter @sveltex/jobs test:integration` | **17/17** (Redis 7 + SQLite + PostgreSQL 16) |
| `pnpm test:types` | **16/16** |
| `npm pack --dry-run --json` | `@sveltex/jobs` 0.1.0, 35 files |

### Test inventory

| Suite | Tests | Coverage |
| --- | ---: | --- |
| `jobs.test.mjs` (pre-existing) | 17 | Atomic claim, delayed visibility, dedupe, dead-letter, idempotent complete/fail, worker concurrency, backoff, graceful shutdown |
| `serialization.test.mjs` | 8 | Primitives, undefined, arrays/objects, unsafe values, prototype pollution, corrupt/legacy envelopes, byte bounds, frozen Job |
| `registry.test.mjs` | 5 | Registration, duplicate rejection, invalid grammar, routing, unregistered typed error |
| `scheduler.test.mjs` | 4 | computeDelayMs, enqueue, scheduleAt overrides delayMs, scheduleIn |
| `security/security.test.mjs` (pre-existing) | 7 | Job claim atomicity, retries, dead-lettering, graceful shutdown |
| `security/phase6-security.test.mjs` | 10 | Prototype pollution, corrupt/legacy/tampered records, SQL parameterization, config validation, closed queue, idempotent finalization, unregistered dead-lettering, oversized payloads, JobsStoreError diagnostics |
| `integration/redis.test.mjs` | 7 | Real Redis: enqueue/claim/complete/fail/cancel, dedupe, delayed visibility, persistence across queue instances, Lua atomicity |
| `integration/sql.test.mjs` | 10 | Real SQLite + PostgreSQL: schema, enqueue/claim/complete/fail/cancel, dedupe index, concurrent claim (two connections, no double-execute), persistence across queue instances, dialect placeholders |
| `types/public-api.test.ts` | — | Extended: `JobRegistry`, `JobScheduler`, `RedisJobQueue`, `SqlJobQueue`, `JobsStoreError`, `JobsSerializationError`, `JobsConfigurationError`, `computeDelayMs`, subpath imports |

## XERJ

XERJ was used for repository research throughout Phase 6:
- HTTP search (`ax-docs` index) queried for Phase 6 gap analysis, job queue patterns, and
  cross-package blueprint study (`packages/database/src/sqlite.ts`, `packages/database/src/postgres.ts`,
  `packages/database/src/migrations.ts`, `packages/cache/src/redis.ts`, `packages/session/src/database.ts`).
- Final `--fresh` rebuild: 454 files / 2594 records live / 30 duplicate aliases /
  0 junk records / 0 junk/skipped files; `ax-docs` 2579 docs, `ax-packages-cli` 15 docs,
  graph 1626 edges, `xerj-done ok=true exit=0 reason=completed`.

## Docs synced

- `packages/jobs/README.md` — rewritten with Redis / SQL backends, strict serialization, registry, scheduler.
- `packages/jobs/CHANGELOG.md` — Phase 6 entry.
- `docs/completion-plan.md` — Phase 6 tasks and tests checked.
- `docs/completion/phase-0-audit.md` — Phase 6 gap table updated to completion table.
- `docs/audit/README.md` — totals updated to 806 / 141 / 16; Phase 6 delivery text added.
- `docs/audit/package-status.md` — jobs row updated; totals updated.
- `docs/audit/testing-status.md` — jobs row updated; integration tests added; gap 6 updated.
- `docs/audit/security-findings.md` — SEC-053–SEC-062 added.
- `docs/audit/repository-audit.md` — jobs tree line and package row updated.
- `docs/audit/progress.md` — Session 13 added.
- `docs/specification.md` — jobs row and totals updated.
- `docs/packages/README.md` — jobs row and totals updated.
- `docs/roadmap.md` — Phase 6 delivery noted.
- `README.md` (root) — totals updated.
- `docs/manifest.json` — document count and status updated.

## Not claimed

- MySQL is **not** implemented for `SqlJobQueue` (only `sqlite` and `postgres` dialects).
  The BYO executor port accepts any dialect, but placeholder rendering and `FOR UPDATE SKIP
  LOCKED` are only tested against SQLite and PostgreSQL.
- No distributed lock beyond Redis Lua atomicity and SQL row-level locking.
- No SvelteKit `handle` hook wiring for job scheduling (Phase 10).
- No job priorities, recurring/cron schedules, or workflow DAGs.
- No cross-process worker coordination (each worker claims independently; no leader election).
- Package version stays `0.1.0` (bump deferred to Phase 11 release audit).

## Next

Phase 7 (`@sveltex/storage`) per the plan. Phases 7–12 remain.

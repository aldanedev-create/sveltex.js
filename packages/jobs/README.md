# @sveltex/jobs

Background job processing for SvelteX: one queue contract, one worker, and three real backends —
an in-memory queue for development/testing, a Redis-backed queue, and a SQL-backed queue
(SQLite / PostgreSQL). All backends share strict payload serialization, validation, typed errors,
atomic claim, retries with capped exponential backoff, deduplication, cancellation and a
dead-letter state.

## Install

```sh
pnpm add @sveltex/jobs
# Redis backend needs the bundled ioredis dependency (installed automatically).
# SQL backend: supply any executor satisfying JobSqlExecutor, e.g. @sveltex/database.
```

## Queue backends

| Backend | Subpath | Durable | Cross-process | Driver |
| --- | --- | :---: | :---: | --- |
| `InMemoryJobQueue` | `@sveltex/jobs/in-memory` | ✗ | ✗ | process memory |
| `RedisJobQueue` | `@sveltex/jobs/redis` | ✅ | ✅ | real `ioredis` + Lua |
| `SqlJobQueue` | `@sveltex/jobs/sql` | ✅ | ✅ | BYO SQL executor (`sqlite` / `postgres`) |

Every backend implements the same `JobQueue` contract (`enqueue`, `claim`, `complete`, `fail`,
`cancel`, `get`, `list`, `close`, `isClosed`), so `Worker` and `JobScheduler` are backend-agnostic.

## Minimal example (development)

```ts
import { Worker } from '@sveltex/jobs';
import { InMemoryJobQueue } from '@sveltex/jobs/in-memory';

const queue = new InMemoryJobQueue();
await queue.enqueue({ name: 'email.send', payload: { to: 'a@b.com' }, maxAttempts: 5, dedupeKey: 'welcome:a@b.com' });

const worker = new Worker({
  queue,
  concurrency: 4,
  handler: async (job, ctx) => {
    console.log(`attempt ${ctx.attempts} for ${job.name}`);
    // do the work; throw to trigger a retry
  },
});

worker.start();
// later, on shutdown:
await worker.stop();
await queue.close();
```

## Registration and scheduling

`JobRegistry` routes by `job.name`; an unregistered name throws a typed `JobsError`, so the
worker's normal retry / dead-letter path applies instead of silently dropping work.

`JobScheduler` is a thin, clock-injectable facade over any queue. `scheduleAt` and `scheduleIn`
override `options.delayMs` and translate a run time into delayed visibility.

```ts
import { JobRegistry } from '@sveltex/jobs/registry';
import { JobScheduler } from '@sveltex/jobs/scheduler';

const registry = new JobRegistry();
registry.register('email.send', async (job) => { await sendMail(job.payload); });

const worker = new Worker({ queue, handler: registry.createHandler() });
const scheduler = new JobScheduler(queue);
await scheduler.scheduleIn({ name: 'email.send', payload: { to: 'a@b.com' } }, 60_000);
await scheduler.scheduleAt({ name: 'email.send', payload: { to: 'b@b.com' } }, Date.now() + 3_600_000);
worker.start();
```

## Production: Redis

```ts
import { RedisJobQueue } from '@sveltex/jobs/redis';

const queue = new RedisJobQueue({ url: process.env.REDIS_URL, keyPrefix: 'myapp:jobs:' });
await queue.connect();           // optional; the first operation connects lazily
const worker = new Worker({ queue, handler: registry.createHandler() });
worker.start();
```

Keys are `<prefix>ready` (ZSET by `availableAt`), `<prefix>all` (SET of ids), `<prefix>job:<id>`
(strict job record) and `<prefix>dedupe:<key>`. `enqueue`, `claim`, `complete`/`fail` and `cancel`
are each a single Lua script, so state transitions are atomic on the Redis server and two
independent processes cannot claim the same job twice. Each `RedisJobQueue` creates its own
client; `close()` disconnects it so no reconnect timers survive.

## Production: SQL (SQLite / PostgreSQL)

`SqlJobQueue` takes a driver-neutral structural port. `@sveltex/database`'s `Database` facade
satisfies it without adding a hard runtime dependency:

```ts
import { Database } from '@sveltex/database';
import { PostgresAdapter } from '@sveltex/database/postgres';
import { SqlJobQueue } from '@sveltex/jobs/sql';

const db = new Database(new PostgresAdapter({ connectionString: process.env.DATABASE_URL }));
await db.connect();
const queue = new SqlJobQueue(db, { dialect: 'postgres', tableName: 'sveltex_jobs' });

// Run once as a migration (recommended), or let the queue create it lazily:
for (const statement of queue.schemaStatements()) await db.query(statement);
// await queue.ensureSchema();
```

`schemaStatements()` creates the table plus a **partial unique index** on `dedupe_key` for
`pending`/`active` rows, making concurrent de-duplication atomic. `claim()` selects due rows and
conditionally updates them inside one transaction (`FOR UPDATE SKIP LOCKED` on PostgreSQL, and a
conditional-update row-count guard), so concurrent workers cannot double-deliver. DDL creation is
bounded-retry safe against PostgreSQL's catalog race (`23505 pg_type_typname_nsp_index`) when two
fresh connections initialize simultaneously. `close()` only marks the queue closed — the caller
owns the executor's lifecycle.

For SQLite use `dialect: 'sqlite'` with `SqliteAdapter` (`node:sqlite`); `?` placeholders are used,
`$1..$n` for PostgreSQL. A file-backed SQLite queue survives a full reopen; `:memory:` does not.
**MySQL is not implemented for this queue.**

## Strict payload serialization

Persisted payloads use a versioned envelope `sveltex-jobs:v1:u` (cached `undefined`) or
`sveltex-jobs:v1:j<strict JSON>`. Bounds: **64 KiB** per payload, **128 KiB** per record.
Encoding rejects values that `JSON.stringify` would silently coerce or drop — `Date`, `Map`,
`Set`, `RegExp`, `bigint`, `symbol`, functions, nested `undefined`, non-finite numbers, typed
arrays, circular objects and custom class instances — plus the keys `__proto__`, `constructor`
and `prototype`. Decoding re-validates the envelope and all scalar fields; plaintext, legacy and
tampered records raise `JobsSerializationError` and are never coerced into a job.

## Lifecycle: retries, backoff, cancellation, idempotency

`computeBackoffDelay(attempts, policy)` returns `min(maxDelayMs, baseDelayMs * factor^(attempts-1))`;
the default is `{ baseDelayMs: 100, maxDelayMs: 30_000, factor: 2 }`. A failing job with
`attempts < maxAttempts` is re-queued with `availableAt = now + delay`; an exhausted job moves to
`dead` and keeps its `lastError`. `complete`, `fail` and `cancel` are idempotent: a dead or
completed job cannot be resurrected, `cancel` only transitions a `pending` job and returns `true`
once, and a late/duplicate finalization cannot double-apply.

## Validation and errors

All backends share `validation.ts`: job-name grammar `^[A-Za-z0-9._:-]{1,128}$`, bounded ids and
dedupe keys, plain-SQL-identifier table names, finite timestamps, integer claim limits and bounded
error strings. Typed errors carry stable codes:

| Error | Code | Meaning |
| --- | --- | --- |
| `JobsValidationError` | `SX_JOBS_VALIDATION` | invalid input |
| `JobsSerializationError` | `SX_JOBS_SERIALIZATION` | corrupt/unsafe payload or record |
| `JobsConfigurationError` | `SX_JOBS_CONFIGURATION` | bad backend options |
| `JobsClosedError` | `SX_JOBS_CLOSED` | operation on a closed queue |
| `JobsStoreError` | `SX_JOBS_STORE` | backend failure; keeps `operation` and `cause` |

## Deterministic testing

`Worker.tick(now?)` is public and clock-injectable. Drive retries and backoff visibility without
timers or live services:

```ts
await queue.enqueue({ name: 'flaky', payload: 1, maxAttempts: 3 }, 0);
await worker.tick(0);   // fails, re-queued at now + 100
await worker.tick(99);  // not yet due
await worker.tick(100); // second attempt
```

`Worker` accepts an `AbortSignal`; `stop()` is idempotent and drains the in-flight batch. `onError`
reports handler failures without crashing the worker. `metrics` exposes cumulative
`claimed / succeeded / failed / retried / dead / ticks`.

## API surface

| Export | Subpath | Kind |
| --- | --- | --- |
| `Worker`, `computeBackoffDelay`, `DEFAULT_BACKOFF`, `JobQueue`, `Job`, `JobStatus`, `EnqueueOptions`, `EnqueueResult`, `FailOptions`, `BackoffPolicy`, `JobContext`, `JobHandler`, `WorkerOptions`, `WorkerTickResult`, `WorkerMetrics` | `.` | class / function / types |
| `JobsError`, `JobsValidationError`, `JobsClosedError`, `JobsSerializationError`, `JobsConfigurationError`, `JobsStoreError` | `.` | errors |
| `InMemoryJobQueue`, `InMemoryJobQueueOptions` | `./in-memory` | queue |
| `RedisJobQueue`, `RedisJobQueueOptions` | `./redis` | queue |
| `SqlJobQueue`, `SqlJobQueueOptions`, `JobSqlDialect`, `JobSqlExecutor`, `JobSqlQueryExecutor`, `JobSqlResult`, `JobSqlValue` | `./sql` | queue / types |
| `JobRegistry` | `./registry` | registry |
| `JobScheduler`, `JobSchedulerOptions`, `computeDelayMs` | `./scheduler` | scheduling |
| `serializeJobPayload`, `deserializeJobPayload`, `encodeJobRecord`, `decodeJobRecord`, `decodeJob`, `JobRecord`, `JOBS_ENVELOPE_PREFIX`, `JOBS_ENVELOPE_VERSION`, `MAX_PAYLOAD_BYTES`, `MAX_RECORD_BYTES` | `./serialization` | wire format |
| `validateJobName`, `validateEnqueueOptions`, `validateClaim`, `validateFailOptions`, `validateJobId`, `validateTableName`, `validateDedupeKey`, `validateTimestamp`, `ValidatedEnqueue`, `ValidatedFail`, `JOB_NAME_PATTERN`, `MAX_JOB_ID_LENGTH`, `MAX_DEDUPE_KEY_LENGTH`, `MAX_ERROR_LENGTH` | `./validation` | validation |

## Testing and verification

- **51** runtime + security tests (`node --test`), **0 skipped**.
- **17** real integration tests: 7 against a live Redis server, 10 against real SQLite
  (`node:sqlite`) and PostgreSQL (`pg.Pool`) via `@sveltex/database`, including concurrent
  cross-connection claim, dedupe-index races, file-backed persistence across reopen and
  end-to-end `Worker` processing. No mock executor or fake provider.
- **1** public-API type-test project under `tests/types/`.
- CI runs `pnpm --filter @sveltex/jobs test:integration` with `redis:7` and `postgres:16`
  service containers; those tests are never skipped.

## Limitations and production notes

- **`InMemoryJobQueue` is not durable and not distributed.** A restart loses all jobs.
- `SqlJobQueue` supports `sqlite` and `postgres` only — **no MySQL adapter** is shipped or claimed.
- The Redis backend expects one Redis instance, or keys sharing a single hash-tag slot on
  Cluster (`{hash-tag}` prefix). Cross-slot Cluster routing is not implemented.
- No priority queues, no cron/periodic schedule persistence (`JobScheduler` only enqueues), no
  job-progress store, no dead-letter replay tooling, and no built-in rate limiting. Delayed jobs
  become visible through worker polling, not a background timer.
- TLS, authentication and connection pooling are supplied by the Redis URL or the BYO SQL
  executor, not by this package.
- Workers are single-process concurrent; multi-instance coordination comes from the backend's
  atomic claim, not from an in-process lock.

## Status

Completion-plan Phase 6 is delivered. Package version remains `0.1.0` (unpublished); version
bumps are deferred to the Phase 11 release audit.

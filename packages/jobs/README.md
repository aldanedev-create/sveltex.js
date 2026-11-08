# @sveltex/jobs

Job queue contracts with retries, capped exponential backoff, deduplication, concurrency control, and a graceful worker lifecycle.

## Install

```sh
pnpm add @sveltex/jobs
```

## Concepts

- **`JobQueue`** — the contract any backend implements (`enqueue`, `claim`, `complete`, `fail`, `get`, `list`, `close`). Implementations may be in-memory or backed by a database/broker.
- **`InMemoryJobQueue`** (`@sveltex/jobs/in-memory`) — a real, working process-local queue with **atomic claim** (a job is claimed exactly once), delayed visibility, deduplication keys, and a dead-letter state.
- **`Worker`** — concurrent processor. Retries with `computeBackoffDelay`, dead-letters exhausted jobs, isolates handler failures, and drains in-flight work on `stop()`.

## Minimal example

```ts
import { Worker } from '@sveltex/jobs';
import { InMemoryJobQueue } from '@sveltex/jobs/in-memory';

const queue = new InMemoryJobQueue();
await queue.enqueue({ name: 'email', payload: { to: 'a@b.com' }, maxAttempts: 5, dedupeKey: 'welcome:a@b.com' });

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

## Retries and backoff

`computeBackoffDelay(attempts, policy)` returns `min(maxDelayMs, baseDelayMs * factor^(attempts-1))`. The default policy is `{ baseDelayMs: 100, maxDelayMs: 30_000, factor: 2 }`. A job that fails with `attempts < maxAttempts` is re-queued with `availableAt = now + delay`; a job that exhausts `maxAttempts` moves to `dead` and is retained with its `lastError` as dead-letter evidence. `complete` and `fail` are idempotent — a duplicate/late delivery cannot double-finalize a job.

## Deduplication

`enqueue({ dedupeKey })` collapses to a single job while that key is pending/active; after the job completes or dies the key may be enqueued again. Keys are validated as bounded opaque strings and are used only as in-memory map keys — never as filesystem paths or shell arguments.

## Deterministic testing

`Worker.tick(now?)` is public and clock-injectable. You can drive retries, backoff visibility, and concurrency without timers or any live service:

```ts
await queue.enqueue({ name: 'flaky', payload: 1, maxAttempts: 3 }, 0);
await worker.tick(0);   // fails, re-queued at now + 100
await worker.tick(99);  // not yet due
await worker.tick(100); // second attempt
```

`Worker` accepts an `AbortSignal`; `stop()` is idempotent and waits for the in-flight batch to settle. `onError` reports handler failures without crashing the worker. `metrics` exposes cumulative `claimed / succeeded / failed / retried / dead / ticks`.

## API surface

| Export | Kind |
| --- | --- |
| `Worker` | class |
| `computeBackoffDelay(attempts, policy?)`, `DEFAULT_BACKOFF` | function / constant |
| `JobQueue`, `Job`, `JobStatus`, `EnqueueOptions`, `EnqueueResult`, `FailOptions`, `BackoffPolicy`, `JobContext`, `JobHandler`, `WorkerOptions`, `WorkerTickResult`, `WorkerMetrics` | types |
| `JobsError`, `JobsValidationError`, `JobsClosedError` | errors |
| `InMemoryJobQueue`, `InMemoryJobQueueOptions` (`@sveltex/jobs/in-memory`) | queue |

## Limitations and production notes

- **`InMemoryJobQueue` is not durable and not distributed.** State lives in one process; a restart loses all jobs, and it cannot coordinate workers across instances. This is an in-process queue, **not** a durable distributed queue. For production multi-instance deployments, implement `JobQueue` on a database or broker (Redis, Postgres, SQS, etc.) — the `Worker` is backend-agnostic.
- In-process workers do not survive process termination. Graceful `stop()` drains the current batch but there is no on-disk recovery.
- Job names are restricted to `^[A-Za-z0-9._:-]{1,128}$` to avoid injection surfaces.
- No external broker/provider adapter is shipped in this package; none is advertised as supported.

## Status

Verified with runtime, security, and public-API type tests. No live external service is required.

import {
  Worker,
  computeBackoffDelay,
  DEFAULT_BACKOFF,
  JobsError,
  JobsValidationError,
  JobsClosedError,
} from '../../dist/index.js';
import type {
  Job,
  JobStatus,
  JobQueue,
  EnqueueOptions,
  EnqueueResult,
  FailOptions,
  BackoffPolicy,
  JobContext,
  JobHandler,
  WorkerOptions,
  WorkerTickResult,
  WorkerMetrics,
} from '../../dist/index.js';
import { InMemoryJobQueue } from '../../dist/in-memory.js';
import type { InMemoryJobQueueOptions } from '../../dist/in-memory.js';

const opts: InMemoryJobQueueOptions = { generateId: () => 'id' };
const queue: JobQueue = new InMemoryJobQueue(opts);
void opts;

const enqueue: EnqueueOptions<{ to: string }> = { name: 'email', payload: { to: 'a@b.com' }, maxAttempts: 3 };
const result: Promise<EnqueueResult> = queue.enqueue(enqueue, 0);
const job: Promise<Job | undefined> = queue.get('id');
const jobs: Promise<readonly Job[]> = queue.list();
const fail: Promise<void> = queue.fail('id', { error: 'x', retryAt: 10 } satisfies FailOptions);
const complete: Promise<void> = queue.complete('id');
const closed: Promise<void> = queue.close();
void [result, job, jobs, fail, complete, closed, queue.isClosed];

const status: JobStatus = 'pending';
void status;

const policy: BackoffPolicy = DEFAULT_BACKOFF;
const delay: number = computeBackoffDelay(3, policy);
void delay;

const handler: JobHandler = (j: Job, ctx: JobContext) => {
  const attempts: number = ctx.attempts;
  const signal: AbortSignal = ctx.signal;
  void [j, attempts, signal];
};
const workerOptions: WorkerOptions = { queue, handler, concurrency: 2, now: () => 0 };
const worker: Worker = new Worker(workerOptions);
const tick: Promise<WorkerTickResult> = worker.tick(0);
const metrics: WorkerMetrics = worker.metrics;
const running: boolean = worker.isRunning;
const stopped: Promise<void> = worker.stop();
worker.start();
void [tick, metrics, running, stopped];

const err: JobsError = new JobsValidationError('bad');
const code: string = err.code;
void code;
void new JobsClosedError('closed');

// @ts-expect-error the handler is required
void new Worker({ queue });

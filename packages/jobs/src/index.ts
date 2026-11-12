import { SvelteXError, toError } from '@sveltex/shared';
import type { Awaitable } from '@sveltex/shared';

export type JobStatus = 'pending' | 'active' | 'completed' | 'dead' | 'cancelled';

export interface Job<TPayload = unknown> {
  readonly id: string;
  readonly name: string;
  readonly payload: TPayload;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly availableAt: number;
  readonly dedupeKey?: string;
  readonly lastError?: string;
}

export interface EnqueueOptions<TPayload> {
  readonly name: string;
  readonly payload: TPayload;
  readonly maxAttempts?: number;
  readonly dedupeKey?: string;
  readonly delayMs?: number;
}

export interface EnqueueResult {
  readonly job: Job;
  /** True when an equivalent active/pending job already existed and no new job was created. */
  readonly deduplicated: boolean;
}

export interface FailOptions {
  readonly error: string;
  readonly retryAt?: number;
}

/** Durable-capable queue contract. Implementations may be in-memory or backed by a broker/database. */
export interface JobQueue {
  enqueue<TPayload>(options: EnqueueOptions<TPayload>, now: number): Promise<EnqueueResult>;
  /** Atomically transition up to `limit` due jobs to `active`; increments their attempt counter. */
  claim(now: number, limit: number): Promise<readonly Job[]>;
  /** Idempotent: only an `active` job transitions to `completed`. */
  complete(id: string): Promise<void>;
  /** Idempotent: an `active` job is either re-queued for retry (retryAt) or moved to dead-letter. */
  fail(id: string, options: FailOptions): Promise<void>;
  /** Cancel a `pending` job. Idempotent: returns true only when a pending job was cancelled. */
  cancel(id: string): Promise<boolean>;
  get(id: string): Promise<Job | undefined>;
  list(): Promise<readonly Job[]>;
  close(): Promise<void>;
  readonly isClosed: boolean;
}

export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({ baseDelayMs: 100, maxDelayMs: 30_000, factor: 2 });

/** Exponential backoff with a cap. `attempts` is the number of the attempt that just failed (>=1). */
export function computeBackoffDelay(attempts: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = policy.baseDelayMs * Math.pow(policy.factor, exponent);
  return Math.min(policy.maxDelayMs, Math.round(raw));
}

export interface JobContext {
  readonly attempts: number;
  readonly signal: AbortSignal;
}
export type JobHandler = (job: Job, context: JobContext) => Awaitable<void>;

export interface JobsErrorOptions {
  readonly cause?: Error;
  readonly details?: Record<string, unknown>;
}
export class JobsError extends SvelteXError {
  constructor(code: string, message: string, options: JobsErrorOptions = {}) {
    super(message, {
      code,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    });
    this.name = 'JobsError';
  }
}
export class JobsValidationError extends JobsError {
  constructor(message: string, options: JobsErrorOptions = {}) {
    super('SX_JOBS_VALIDATION', message, options);
    this.name = 'JobsValidationError';
  }
}
export class JobsClosedError extends JobsError {
  constructor(message: string, options: JobsErrorOptions = {}) {
    super('SX_JOBS_CLOSED', message, options);
    this.name = 'JobsClosedError';
  }
}
export class JobsSerializationError extends JobsError {
  constructor(message: string, options: JobsErrorOptions = {}) {
    super('SX_JOBS_SERIALIZATION', message, options);
    this.name = 'JobsSerializationError';
  }
}
export class JobsConfigurationError extends JobsError {
  constructor(message: string, options: JobsErrorOptions = {}) {
    super('SX_JOBS_CONFIGURATION', message, options);
    this.name = 'JobsConfigurationError';
  }
}
/** A backend operation failed. `operation` identifies the failing step; `cause` keeps the driver error. */
export class JobsStoreError extends JobsError {
  readonly operation: string;
  constructor(message: string, operation: string, options: JobsErrorOptions = {}) {
    super('SX_JOBS_STORE', message, options);
    this.name = 'JobsStoreError';
    this.operation = operation;
  }
}

export interface WorkerTickResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly retried: number;
  readonly dead: number;
}

export interface WorkerMetrics extends WorkerTickResult {
  readonly ticks: number;
}

interface MutableCounters {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  dead: number;
}

export interface WorkerOptions {
  readonly queue: JobQueue;
  readonly handler: JobHandler;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly backoff?: BackoffPolicy;
  readonly onError?: (error: Error, job: Job) => void;
  readonly signal?: AbortSignal;
}

/**
 * Concurrent job worker. Retries with capped exponential backoff, de-duplicates delivery via the
 * queue's atomic claim, dead-letters exhausted jobs, and drains in-flight work on graceful stop.
 * `tick()` is public and deterministic (clock-injectable) so tests need no timers or live services.
 */
export class Worker {
  readonly #queue: JobQueue;
  readonly #handler: JobHandler;
  readonly #concurrency: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #backoff: BackoffPolicy;
  readonly #onError: WorkerOptions['onError'];
  readonly #abort = new AbortController();
  readonly #metrics = { claimed: 0, succeeded: 0, failed: 0, retried: 0, dead: 0, ticks: 0 };
  #timer: ReturnType<typeof setInterval> | undefined;
  #started = false;
  #stopped = false;
  #stopPromise: Promise<void> | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: WorkerOptions) {
    if (!options || !options.queue || typeof options.handler !== 'function') {
      throw new JobsValidationError('A queue and a handler function are required.');
    }
    const concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 1024) {
      throw new JobsValidationError('concurrency must be an integer between 1 and 1024.');
    }
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new JobsValidationError('pollIntervalMs must be a positive integer.');
    }
    this.#queue = options.queue;
    this.#handler = options.handler;
    this.#concurrency = concurrency;
    this.#pollIntervalMs = pollIntervalMs;
    this.#now = options.now ?? Date.now;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#onError = options.onError;
    if (options.signal) {
      if (options.signal.aborted) this.#abort.abort();
      else options.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });
    }
  }

  get isRunning(): boolean { return this.#started && !this.#stopped; }
  get isStopped(): boolean { return this.#stopped; }
  get metrics(): WorkerMetrics { return Object.freeze({ ...this.#metrics }); }

  /** Begin interval polling. Idempotent. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.#pollIntervalMs);
    // Do not hold the event loop open on its own.
    (this.#timer as { unref?: () => void } | undefined)?.unref?.();
  }

  /** Graceful shutdown: stop polling, abort in-flight handlers, drain, and close idempotently. */
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stopInternal();
    return this.#stopPromise;
  }

  /** Process one batch. Serialized so overlapping ticks never exceed the concurrency budget.
   * New work is rejected synchronously once stopping; ticks already in the execution chain are
   * always drained so in-flight handlers are never dropped. */
  tick(now: number = this.#now()): Promise<WorkerTickResult> {
    if (this.#stopped || this.#abort.signal.aborted) {
      return Promise.resolve({ claimed: 0, succeeded: 0, failed: 0, retried: 0, dead: 0 });
    }
    const run: Promise<WorkerTickResult> = this.#chain.then(
      () => this.#tickInternal(now),
      () => this.#tickInternal(now),
    );
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #tickInternal(now: number): Promise<WorkerTickResult> {
    const counters: MutableCounters = { claimed: 0, succeeded: 0, failed: 0, retried: 0, dead: 0 };
    let jobs: readonly Job[];
    try {
      jobs = await this.#queue.claim(now, this.#concurrency);
    } catch (error) {
      throw new JobsError('SX_JOBS_CLAIM', 'Queue failed to claim jobs.', { cause: toError(error) });
    }
    counters.claimed = jobs.length;
    const tasks = jobs.map((job) => this.#runJob(job, now, counters));
    await Promise.all(tasks);
    this.#metrics.ticks += 1;
    this.#metrics.claimed += counters.claimed;
    this.#metrics.succeeded += counters.succeeded;
    this.#metrics.failed += counters.failed;
    this.#metrics.retried += counters.retried;
    this.#metrics.dead += counters.dead;
    return counters;
  }

  async #runJob(job: Job, now: number, counters: MutableCounters): Promise<void> {
    try {
      await this.#handler(job, Object.freeze({ attempts: job.attempts, signal: this.#abort.signal }));
      await this.#queue.complete(job.id);
      counters.succeeded += 1;
    } catch (error) {
      counters.failed += 1;
      const err = toError(error);
      this.#onError?.(err, job);
      if (job.attempts < job.maxAttempts) {
        const delay = computeBackoffDelay(job.attempts, this.#backoff);
        await this.#queue.fail(job.id, { error: err.message, retryAt: now + delay });
        counters.retried += 1;
      } else {
        await this.#queue.fail(job.id, { error: err.message });
        counters.dead += 1;
      }
    }
  }

  async #stopInternal(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#abort.abort();
    // Wait for the currently running tick (and its in-flight handlers) to settle.
    await this.#chain;
  }
}

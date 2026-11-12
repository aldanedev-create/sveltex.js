import { randomUUID } from 'node:crypto';
import { JobsClosedError } from './index.js';
import type { EnqueueOptions, EnqueueResult, FailOptions, Job, JobQueue } from './index.js';
import { validateClaim, validateEnqueueOptions, validateFailOptions, validateJobId } from './validation.js';

interface MutableJob {
  id: string;
  name: string;
  payload: unknown;
  status: Job['status'];
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  availableAt: number;
  dedupeKey: string | undefined;
  lastError: string | undefined;
}

function snapshot(job: MutableJob): Job {
  return Object.freeze({
    id: job.id,
    name: job.name,
    payload: job.payload,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    availableAt: job.availableAt,
    ...(job.dedupeKey !== undefined ? { dedupeKey: job.dedupeKey } : {}),
    ...(job.lastError !== undefined ? { lastError: job.lastError } : {}),
  }) as Job;
}

export interface InMemoryJobQueueOptions {
  readonly now?: () => number;
  readonly generateId?: () => string;
}

/**
 * A real, working process-local queue. It provides atomic claim, bounded-attempt retries with
 * delayed visibility, deduplication, and a dead-letter state. It is NOT durable and NOT a
 * distributed queue: state lives in this process only. Use `RedisJobQueue` or `SqlJobQueue`
 * for multi-instance deployments.
 */
export class InMemoryJobQueue implements JobQueue {
  readonly #jobs = new Map<string, MutableJob>();
  readonly #dedupe = new Map<string, string>();
  readonly #now: () => number;
  readonly #generateId: () => string;
  #closed = false;

  constructor(options: InMemoryJobQueueOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? (() => randomUUID());
  }

  get isClosed(): boolean { return this.#closed; }
  get size(): number { return this.#jobs.size; }

  async enqueue<TPayload>(options: EnqueueOptions<TPayload>, now: number = this.#now()): Promise<EnqueueResult> {
    this.#assertOpen();
    const validated = validateEnqueueOptions(options, now);
    const key = validated.dedupeKey;
    if (key !== undefined) {
      const existingId = this.#dedupe.get(key);
      if (existingId !== undefined) {
        const existing = this.#jobs.get(existingId);
        if (existing && (existing.status === 'pending' || existing.status === 'active')) {
          return Object.freeze({ job: snapshot(existing), deduplicated: true });
        }
        // Stale entry (completed/dead/cancelled) — allow a fresh job for the same key.
        this.#dedupe.delete(key);
      }
    }
    const job: MutableJob = {
      id: this.#generateId(),
      name: validated.name,
      payload: validated.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: validated.maxAttempts,
      createdAt: now,
      availableAt: now + validated.delayMs,
      dedupeKey: key,
      lastError: undefined,
    };
    this.#jobs.set(job.id, job);
    if (key !== undefined) this.#dedupe.set(key, job.id);
    return Object.freeze({ job: snapshot(job), deduplicated: false });
  }

  async claim(now: number, limit: number): Promise<readonly Job[]> {
    this.#assertOpen();
    validateClaim(now, limit);
    if (limit === 0) return Object.freeze([]);
    const claimed: Job[] = [];
    for (const job of this.#jobs.values()) {
      if (claimed.length >= limit) break;
      if (job.status !== 'pending' || job.availableAt > now) continue;
      job.status = 'active';
      job.attempts += 1;
      claimed.push(snapshot(job));
    }
    return Object.freeze(claimed);
  }

  async complete(id: string): Promise<void> {
    if (this.#closed) return;
    validateJobId(id);
    const job = this.#jobs.get(id);
    if (!job || job.status !== 'active') return;
    job.status = 'completed';
    if (job.dedupeKey !== undefined && this.#dedupe.get(job.dedupeKey) === id) this.#dedupe.delete(job.dedupeKey);
  }

  async fail(id: string, options: FailOptions): Promise<void> {
    if (this.#closed) return;
    validateJobId(id);
    const validated = validateFailOptions(options);
    const job = this.#jobs.get(id);
    if (!job || job.status !== 'active') return;
    job.lastError = validated.error;
    if (validated.retryAt !== undefined) {
      job.status = 'pending';
      job.availableAt = validated.retryAt;
    } else {
      job.status = 'dead';
      if (job.dedupeKey !== undefined && this.#dedupe.get(job.dedupeKey) === id) this.#dedupe.delete(job.dedupeKey);
    }
  }

  async get(id: string): Promise<Job | undefined> {
    validateJobId(id);
    const job = this.#jobs.get(id);
    return job ? snapshot(job) : undefined;
  }

  async list(): Promise<readonly Job[]> {
    return Object.freeze([...this.#jobs.values()].map(snapshot));
  }

  /** Cancel a queued job (idempotent). Returns true when a pending job was cancelled. */
  async cancel(id: string): Promise<boolean> {
    if (this.#closed) return false;
    validateJobId(id);
    const job = this.#jobs.get(id);
    if (!job || job.status !== 'pending') return false;
    job.status = 'cancelled';
    if (job.dedupeKey !== undefined && this.#dedupe.get(job.dedupeKey) === id) this.#dedupe.delete(job.dedupeKey);
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new JobsClosedError('The job queue is closed.');
  }
}

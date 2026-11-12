import type { EnqueueOptions, EnqueueResult, JobQueue } from './index.js';
import { validateTimestamp } from './validation.js';

/** Convert an absolute run time to a non-negative `delayMs` relative to `now`. */
export function computeDelayMs(runAt: number, now: number): number {
  validateTimestamp(runAt, 'runAt');
  validateTimestamp(now, 'now');
  return Math.max(0, runAt - now);
}

export interface JobSchedulerOptions {
  readonly now?: () => number;
}

/** Thin, clock-injectable scheduling facade over any {@link JobQueue}. */
export class JobScheduler {
  readonly #queue: JobQueue;
  readonly #now: () => number;

  constructor(queue: JobQueue, options: JobSchedulerOptions = {}) {
    if (!queue || typeof queue.enqueue !== 'function') throw new TypeError('A JobQueue is required.');
    this.#queue = queue;
    this.#now = options.now ?? Date.now;
  }

  get queue(): JobQueue { return this.#queue; }

  enqueue<TPayload>(options: EnqueueOptions<TPayload>, now: number = this.#now()): Promise<EnqueueResult> {
    return this.#queue.enqueue(options, now);
  }

  /** Enqueue for an absolute timestamp. Overrides any `delayMs` on `options`. */
  scheduleAt<TPayload>(options: EnqueueOptions<TPayload>, runAt: number, now: number = this.#now()): Promise<EnqueueResult> {
    const delayMs = computeDelayMs(runAt, now);
    return this.#queue.enqueue({ ...options, delayMs }, now);
  }

  /** Enqueue after a relative delay. Overrides any `delayMs` on `options`. */
  scheduleIn<TPayload>(options: EnqueueOptions<TPayload>, delayMs: number, now: number = this.#now()): Promise<EnqueueResult> {
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError('delayMs must be a non-negative finite number.');
    }
    return this.#queue.enqueue({ ...options, delayMs }, now);
  }
}

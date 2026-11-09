import type { AuthAttemptLimiter } from './index.js';

/**
 * Options for {@link FixedWindowLimiter}.
 *
 * @public
 */
export interface FixedWindowLimiterOptions {
  /** Maximum allowed `consume` calls per key within one window. */
  readonly max: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window attempt limiter implementing the {@link AuthAttemptLimiter}
 * port. Each key accumulates hits within a sliding wall-clock window; once the
 * window elapses the counter resets. This is the canonical pattern for
 * login/registration throttling and integrates directly with `AuthService`.
 *
 * @example
 * ```ts
 * const limiter = new FixedWindowLimiter({ max: 5, windowMs: 15 * 60_000 });
 * const auth = new AuthService(store, hasher, sessions, { limiter, dummyPasswordHash });
 * ```
 *
 * @public
 */
export class FixedWindowLimiter implements AuthAttemptLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();
  #lastSweep = 0;

  constructor(options: FixedWindowLimiterOptions) {
    if (!Number.isSafeInteger(options.max) || options.max < 1) {
      throw new RangeError('max must be a positive integer.');
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError('windowMs must be a positive integer.');
    }
    this.#max = options.max;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Returns `true` when the key is still within its allowance (and consumes one
   * attempt), or `false` when the limit for the current window has been reached.
   */
  async consume(key: string): Promise<boolean> {
    const now = this.#now();
    this.#sweep(now);
    const bucket = this.#buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (bucket.count >= this.#max) return false;
    bucket.count += 1;
    return true;
  }

  /** Whole seconds until the active window for `key` resets (0 if inactive). */
  secondsRemaining(key: string): number {
    const bucket = this.#buckets.get(key);
    if (!bucket) return 0;
    return Math.max(0, Math.ceil((bucket.resetAt - this.#now()) / 1000));
  }

  /** Clear one key, or the entire limiter when `key` is omitted. */
  reset(key?: string): void {
    if (key === undefined) this.#buckets.clear();
    else this.#buckets.delete(key);
  }

  #sweep(now: number): void {
    // Bound memory by sweeping expired buckets at most once per quarter-window.
    if (now - this.#lastSweep < this.#windowMs / 4) return;
    this.#lastSweep = now;
    for (const [key, bucket] of this.#buckets) {
      if (now >= bucket.resetAt) this.#buckets.delete(key);
    }
  }
}

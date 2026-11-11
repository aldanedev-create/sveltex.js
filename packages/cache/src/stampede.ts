import { CacheConfigurationError } from './errors.js';
import { validateCacheKey, validateCacheTtl } from './validation.js';
import type { CacheStore, CacheSetOptions } from './index.js';

export interface CacheLoadOptions extends CacheSetOptions {
  /**
   * Randomise the effective TTL by +/- `jitterRatio` (0 to 0.5). Spreading
   * expirations reduces synchronised cache misses across processes.
   */
  readonly jitterRatio?: number;
}

export interface StampedeGuardOptions {
  /** Injectable RNG in `[0, 1)` for deterministic tests. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Observability hook fired when a caller coalesces onto an in-flight load. */
  readonly onCoalesced?: (key: string, waiters: number) => void;
}

/**
 * Apply symmetric TTL jitter. `ratio = 0` is a no-op; `ttlMs = 0` stays zero.
 * The result is always at least 1ms for a positive TTL.
 */
export function computeTtlWithJitter(
  ttlMs: number,
  ratio: number,
  random: () => number = Math.random,
): number {
  validateCacheTtl(ttlMs, true);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) {
    throw new RangeError('jitterRatio must be a finite number between 0 and 0.5.');
  }
  if (ttlMs === 0 || ratio === 0) return ttlMs;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('random() must return a finite number in [0, 1).');
  }
  return Math.max(1, Math.round(ttlMs * (1 + (sample * 2 - 1) * ratio)));
}

/**
 * Cache-aside loader with single-flight coalescing.
 *
 * Concurrent `getOrLoad` calls for the same key share one loader promise, so a
 * cold key is computed once. Loader failures are never cached and are delivered
 * to every waiter. Single-flight is **process-local**; cross-process stampedes
 * are mitigated (not eliminated) by TTL jitter via {@link computeTtlWithJitter}.
 */
export class StampedeGuard {
  readonly #store: CacheStore;
  readonly #random: () => number;
  readonly #onCoalesced: ((key: string, waiters: number) => void) | undefined;
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #waiters = new Map<string, number>();

  constructor(store: CacheStore, options: StampedeGuardOptions = {}) {
    if (store === null || typeof store !== 'object' || typeof store.get !== 'function' ||
      typeof store.set !== 'function' || typeof store.has !== 'function') {
      throw new CacheConfigurationError('StampedeGuard requires a CacheStore.');
    }
    this.#store = store;
    this.#random = options.random ?? Math.random;
    this.#onCoalesced = options.onCoalesced;
  }

  /** Number of keys currently being loaded. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: CacheLoadOptions = {},
  ): Promise<T> {
    validateCacheKey(key);
    if (typeof loader !== 'function') {
      throw new TypeError('getOrLoad requires a loader function.');
    }
    if (options.ttlMs !== undefined) validateCacheTtl(options.ttlMs, true);
    const ratio = options.jitterRatio ?? 0;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) {
      throw new RangeError('jitterRatio must be a finite number between 0 and 0.5.');
    }

    if (await this.#store.has(key)) {
      return (await this.#store.get<T>(key)) as T;
    }

    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      const waiters = (this.#waiters.get(key) ?? 0) + 1;
      this.#waiters.set(key, waiters);
      try {
        this.#onCoalesced?.(key, waiters);
      } catch {
        // Observer errors must not break the load.
      }
      return existing as unknown as Promise<T>;
    }

    const promise = (async (): Promise<T> => {
      const value = await loader();
      const effectiveTtl =
        options.ttlMs === undefined
          ? undefined
          : computeTtlWithJitter(options.ttlMs, ratio, this.#random);
      const setOptions: CacheSetOptions =
        effectiveTtl === undefined ? {} : { ttlMs: effectiveTtl };
      await this.#store.set(key, value, setOptions);
      return value;
    })();

    this.#inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(key);
      this.#waiters.delete(key);
    }
  }
}

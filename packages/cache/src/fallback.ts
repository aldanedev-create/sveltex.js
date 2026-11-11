import { CacheConfigurationError, CacheStoreError } from './errors.js';
import type { CacheStore, CacheSetOptions } from './index.js';

/** Circuit-breaker state of {@link FallbackCache}. */
export type FallbackState = 'healthy' | 'degraded' | 'probing';

export interface FallbackCacheOptions {
  /** Preferred (usually distributed) store. */
  readonly primary: CacheStore;
  /** Local store used while the primary is unavailable. */
  readonly fallback: CacheStore;
  /** Consecutive primary failures before the circuit opens. Default 3. */
  readonly failureThreshold?: number;
  /** Milliseconds in `degraded` before a half-open probe is allowed. Default 2000. */
  readonly recoveryProbeMs?: number;
  /** Injectable clock (tests). */
  readonly now?: () => number;
  /** Observability hook — every primary failure is reported, never silently dropped. */
  readonly onError?: (error: CacheStoreError) => void;
  /** Observability hook for state transitions. */
  readonly onStateChange?: (state: FallbackState) => void;
}

const PROBE_KEY = '__sveltex_cache_probe__';

/**
 * Resilient cache: a primary store with a write-through local fallback and a
 * three-state circuit breaker.
 *
 * - `healthy`  — every operation targets the primary; `set` mirrors to the fallback.
 * - `degraded` — the primary is skipped entirely; reads/writes go to the fallback.
 * - `probing`  — after `recoveryProbeMs` one operation is allowed to probe the
 *   primary; success returns to `healthy`, failure re-opens the circuit.
 *
 * No backend error is swallowed: each failure is wrapped in
 * {@link CacheStoreError} (with the original error as `cause`), recorded in
 * `lastError`, and delivered to `onError`. Reads served from the fallback while
 * degraded may be stale — this is stated explicitly rather than hidden.
 */
export class FallbackCache implements CacheStore {
  readonly #primary: CacheStore;
  readonly #fallback: CacheStore;
  readonly #threshold: number;
  readonly #probeMs: number;
  readonly #now: () => number;
  readonly #onError: ((error: CacheStoreError) => void) | undefined;
  readonly #onStateChange: ((state: FallbackState) => void) | undefined;

  #state: FallbackState = 'healthy';
  #failures = 0;
  #openedAt = 0;
  #lastError: CacheStoreError | undefined;

  constructor(options: FallbackCacheOptions) {
    assertStore(options.primary, 'primary');
    assertStore(options.fallback, 'fallback');
    this.#primary = options.primary;
    this.#fallback = options.fallback;

    this.#threshold = options.failureThreshold ?? 3;
    if (!Number.isSafeInteger(this.#threshold) || this.#threshold < 1) {
      throw new CacheConfigurationError('failureThreshold must be a positive safe integer.');
    }
    this.#probeMs = options.recoveryProbeMs ?? 2000;
    if (!Number.isFinite(this.#probeMs) || this.#probeMs < 0) {
      throw new CacheConfigurationError('recoveryProbeMs must be a non-negative finite number.');
    }
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError;
    this.#onStateChange = options.onStateChange;
  }

  get state(): FallbackState {
    return this.#state;
  }

  get lastError(): CacheStoreError | undefined {
    return this.#lastError;
  }

  get failureCount(): number {
    return this.#failures;
  }

  /** Force one primary health probe, regardless of the current state. */
  async probe(): Promise<boolean> {
    try {
      await this.#primary.has(PROBE_KEY);
      this.#recordSuccess();
      return true;
    } catch (cause) {
      this.#recordFailure('probe', cause);
      return false;
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.#shouldProbe()) return this.#fallback.get<T>(key);
    try {
      const value = await this.#primary.get<T>(key);
      this.#recordSuccess();
      return value;
    } catch (cause) {
      this.#recordFailure('get', cause);
      return this.#fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    if (!this.#shouldProbe()) {
      await this.#fallback.set(key, value, options);
      return;
    }
    try {
      await this.#primary.set(key, value, options);
      this.#recordSuccess();
    } catch (cause) {
      this.#recordFailure('set', cause);
    }
    // Write-through mirror. If the fallback also fails, the error propagates —
    // a write that reached neither tier must not report success.
    await this.#fallback.set(key, value, options);
  }

  async delete(key: string): Promise<boolean> {
    if (!this.#shouldProbe()) return this.#fallback.delete(key);
    let primaryDeleted = false;
    try {
      primaryDeleted = await this.#primary.delete(key);
      this.#recordSuccess();
    } catch (cause) {
      this.#recordFailure('delete', cause);
    }
    const fallbackDeleted = await this.#fallback.delete(key);
    return primaryDeleted || fallbackDeleted;
  }

  async has(key: string): Promise<boolean> {
    if (!this.#shouldProbe()) return this.#fallback.has(key);
    try {
      const exists = await this.#primary.has(key);
      this.#recordSuccess();
      return exists;
    } catch (cause) {
      this.#recordFailure('has', cause);
      return this.#fallback.has(key);
    }
  }

  async clear(): Promise<void> {
    if (!this.#shouldProbe()) {
      await this.#fallback.clear();
      return;
    }
    try {
      await this.#primary.clear();
      this.#recordSuccess();
    } catch (cause) {
      this.#recordFailure('clear', cause);
    }
    await this.#fallback.clear();
  }

  #shouldProbe(): boolean {
    if (this.#state !== 'degraded') return true;
    if (this.#now() - this.#openedAt >= this.#probeMs) {
      this.#setState('probing');
      return true;
    }
    return false;
  }

  #recordSuccess(): void {
    this.#failures = 0;
    this.#setState('healthy');
  }

  #recordFailure(operation: string, cause: unknown): void {
    const error = new CacheStoreError(operation, cause);
    this.#lastError = error;
    this.#failures += 1;
    this.#notifyError(error);
    if (this.#state === 'probing' || this.#failures >= this.#threshold) {
      this.#openedAt = this.#now();
      this.#setState('degraded');
    }
  }

  #setState(next: FallbackState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#notifyState(next);
  }

  #notifyError(error: CacheStoreError): void {
    try {
      this.#onError?.(error);
    } catch {
      // An observer must never break cache operations; backend errors are still
      // recorded in `lastError` and reflected in the circuit state.
    }
  }

  #notifyState(state: FallbackState): void {
    try {
      this.#onStateChange?.(state);
    } catch {
      // See #notifyError.
    }
  }
}

function assertStore(value: unknown, label: string): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as CacheStore).get !== 'function' ||
    typeof (value as CacheStore).set !== 'function' ||
    typeof (value as CacheStore).delete !== 'function' ||
    typeof (value as CacheStore).has !== 'function' ||
    typeof (value as CacheStore).clear !== 'function'
  ) {
    throw new CacheConfigurationError(`FallbackCache requires a CacheStore for "${label}".`);
  }
}

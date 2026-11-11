import { RealtimeBackpressureError, RealtimeConnectionError } from './index.js';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ReconnectOptions {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitterRatio?: number;
  readonly maxAttempts?: number;
}

export const DEFAULT_RECONNECT: Readonly<Required<ReconnectOptions>> = Object.freeze({
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  multiplier: 2,
  jitterRatio: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
});

/**
 * Capped exponential backoff with symmetric jitter. Pure and injectable so reconnection is
 * deterministic in tests; the real transports drive it with real timers.
 */
export function computeReconnectDelay(
  attempt: number,
  options: ReconnectOptions = {},
  random: () => number = Math.random,
): number {
  const initial = options.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs;
  const max = options.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs;
  const multiplier = options.multiplier ?? DEFAULT_RECONNECT.multiplier;
  const jitterRatio = options.jitterRatio ?? DEFAULT_RECONNECT.jitterRatio;
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new RealtimeConnectionError('attempt must be a non-negative integer.');
  if (!Number.isFinite(initial) || initial < 0) throw new RealtimeConnectionError('initialDelayMs must be non-negative.');
  if (!Number.isFinite(max) || max < initial) throw new RealtimeConnectionError('maxDelayMs must be >= initialDelayMs.');
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new RealtimeConnectionError('multiplier must be >= 1.');
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new RealtimeConnectionError('jitterRatio must be between 0 and 1.');
  const base = Math.min(initial * Math.pow(multiplier, attempt), max);
  const unit = Math.min(1, Math.max(0, random()));
  const jitter = base * jitterRatio * (2 * unit - 1);
  return Math.max(0, Math.round(base + jitter));
}

export type OverflowPolicy = 'error' | 'drop-oldest' | 'drop-newest';

/** Bounded send queue used while a connection is down. Overflow behavior is explicit. */
export class BoundedQueue<T> {
  readonly #items: T[] = [];
  #dropped = 0;
  constructor(readonly maxSize: number, readonly overflow: OverflowPolicy = 'error') {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new RealtimeConnectionError('maxSize must be a positive safe integer.');
    }
  }
  get size(): number { return this.#items.length; }
  get dropped(): number { return this.#dropped; }
  push(item: T): 'ok' | 'dropped-oldest' | 'dropped-newest' {
    if (this.#items.length < this.maxSize) {
      this.#items.push(item);
      return 'ok';
    }
    if (this.overflow === 'drop-newest') {
      this.#dropped += 1;
      return 'dropped-newest';
    }
    if (this.overflow === 'drop-oldest') {
      this.#items.shift();
      this.#items.push(item);
      this.#dropped += 1;
      return 'dropped-oldest';
    }
    throw new RealtimeBackpressureError(`Realtime send queue overflow (${String(this.maxSize)} frames).`);
  }
  /** Remove and return everything currently queued, in FIFO order. */
  drain(): T[] { return this.#items.splice(0, this.#items.length); }
  clear(): void { this.#items.length = 0; }
}

export interface HeartbeatOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onPing?: () => void;
  readonly onTimeout?: () => void;
  /** Injectable scheduler for deterministic tests; returns a cancel function. */
  readonly schedule?: (callback: () => void, ms: number) => () => void;
}

const defaultSchedule = (callback: () => void, ms: number): (() => void) => {
  const timer = setInterval(callback, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

/**
 * Liveness monitor. `tick()` is public so tests advance it with an injected clock; real
 * transports drive it with a real interval. A missed heartbeat never throws into the caller —
 * observer failures are contained.
 */
export class HeartbeatMonitor {
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #intervalMs: number;
  readonly #onPing: (() => void) | undefined;
  readonly #onTimeout: (() => void) | undefined;
  readonly #schedule: (callback: () => void, ms: number) => () => void;
  #cancel: (() => void) | undefined;
  #lastActivity: number;
  #timeouts = 0;

  constructor(options: HeartbeatOptions = {}) {
    const intervalMs = options.intervalMs ?? 5_000;
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RealtimeConnectionError('intervalMs must be >= 1.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < intervalMs) throw new RealtimeConnectionError('timeoutMs must be >= intervalMs.');
    this.#now = options.now ?? Date.now;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#onPing = options.onPing;
    this.#onTimeout = options.onTimeout;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#lastActivity = this.#now();
  }

  get timeouts(): number { return this.#timeouts; }
  get running(): boolean { return this.#cancel !== undefined; }

  start(): void {
    if (this.#cancel !== undefined) return;
    this.noteActivity();
    this.#cancel = this.#schedule(() => this.tick(), this.#intervalMs);
  }
  stop(): void {
    const cancel = this.#cancel;
    this.#cancel = undefined;
    cancel?.();
  }
  noteActivity(): void { this.#lastActivity = this.#now(); }

  tick(): void {
    if (this.#cancel === undefined) return;
    if (this.#now() - this.#lastActivity >= this.#timeoutMs) {
      this.#timeouts += 1;
      try { this.#onTimeout?.(); } catch { /* observer must not break liveness tracking */ }
      return;
    }
    try { this.#onPing?.(); } catch { /* observer must not break liveness tracking */ }
  }
}

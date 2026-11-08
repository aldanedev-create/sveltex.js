import { TestSetupError } from './errors.js';

export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Optional hook: a lightweight recorder shared with the deterministic lifecycle tracker. */
export interface CallRecorder {
  record(method: string, label: string): void;
}

/**
 * A deterministic in-memory key/value fake adapter. Intended to stand in for external services
 * (cache, session, kv store) in tests. It never touches the network or disk, records every call,
 * and can be made to fail on demand. It does NOT claim to be any real provider.
 */
export class FakeKeyValueAdapter {
  readonly #data = new Map<string, unknown>();
  readonly #calls: FakeCall[] = [];
  readonly #recorder: CallRecorder | undefined;
  #failNext: Error | undefined;
  #closed = false;

  constructor(options: { readonly recorder?: CallRecorder } = {}) {
    this.#recorder = options.recorder;
  }

  get isClosed(): boolean { return this.#closed; }
  get size(): number { return this.#data.size; }
  get calls(): readonly FakeCall[] { return Object.freeze([...this.#calls]); }

  /** Make the next mutating operation throw once (for failure-path tests). */
  failNext(error: Error = new Error('simulated failure')): void {
    this.#failNext = error;
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.#record('get', [key]);
    this.#assertOpen();
    return this.#data.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#record('set', [key, value]);
    this.#assertOpen();
    this.#consumeFailure();
    this.#data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    this.#record('delete', [key]);
    this.#assertOpen();
    this.#consumeFailure();
    return this.#data.delete(key);
  }

  async has(key: string): Promise<boolean> {
    this.#record('has', [key]);
    this.#assertOpen();
    return this.#data.has(key);
  }

  async clear(): Promise<void> {
    this.#record('clear', []);
    this.#assertOpen();
    this.#data.clear();
  }

  /** Snapshot of current data (defensive copy). */
  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze(Object.fromEntries(this.#data.entries()));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#data.clear();
  }

  #record(method: string, args: readonly unknown[]): void {
    this.#calls.push(Object.freeze({ method, args: Object.freeze([...args]) }));
    this.#recorder?.record(method, 'FakeKeyValueAdapter');
  }

  #assertOpen(): void {
    if (this.#closed) throw new TestSetupError('FakeKeyValueAdapter is closed.');
  }

  #consumeFailure(): void {
    if (this.#failNext !== undefined) {
      const error = this.#failNext;
      this.#failNext = undefined;
      throw error;
    }
  }
}

export interface FakeSentMessage<T> {
  readonly payload: T;
  readonly at: number;
}

/**
 * A deterministic in-memory message transport fake (for realtime / mail / queue boundaries).
 * Records deliveries and supports injectable failures; never contacts an external broker.
 */
export class FakeMessageTransport<T = unknown> {
  readonly #sent: FakeSentMessage<T>[] = [];
  readonly #recorder: CallRecorder | undefined;
  readonly #clock: () => number;
  #failNext: Error | undefined;
  #closed = false;

  constructor(options: { readonly recorder?: CallRecorder; readonly clock?: () => number } = {}) {
    this.#recorder = options.recorder;
    this.#clock = options.clock ?? (() => 0);
  }

  get isClosed(): boolean { return this.#closed; }
  get sent(): readonly FakeSentMessage<T>[] { return Object.freeze([...this.#sent]); }

  failNext(error: Error = new Error('simulated transport failure')): void {
    this.#failNext = error;
  }

  async send(payload: T): Promise<void> {
    if (this.#closed) throw new TestSetupError('FakeMessageTransport is closed.');
    this.#recorder?.record('send', 'FakeMessageTransport');
    if (this.#failNext !== undefined) {
      const error = this.#failNext;
      this.#failNext = undefined;
      throw error;
    }
    this.#sent.push(Object.freeze({ payload, at: this.#clock() }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
  }
}

import {
  DatabaseAdapterError,
  type DatabaseAdapter,
  type DatabaseAdapterConfig,
  type DatabaseAdapterContext,
  type DatabaseAdapterCapabilities,
} from '../contracts/adapter.js';
import type { ConnectionState, HealthCheckReport, ConnectionInfo } from '../contracts/connection.js';
import {
  AdapterTransactionError,
  UnsupportedCapabilityError,
  type TransactionOptions,
} from '../contracts/transaction.js';

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * A lifecycle-safe, managed connection over a database adapter. It owns the
 * state machine, concurrent-connect de-duplication, active-operation draining
 * on close, health reporting, capability checks, and consistent error wrapping.
 * The adapter's native client is always reachable through `native()`/`context()`.
 *
 * @public
 */
export interface ManagedConnection<Client = unknown> {
  readonly name: string;
  readonly state: ConnectionState;
  readonly capabilities: DatabaseAdapterCapabilities;
  connect(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<HealthCheckReport>;
  transaction<T>(callback: (tx: DatabaseAdapterContext<Client>) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** The native ORM/query-builder client (never wrapped). Requires `connected`. */
  native(): Client;
  /** The full adapter context (native client + config + adapter name). */
  context(): DatabaseAdapterContext<Client>;
  info(): ConnectionInfo;
}

export interface CreateConnectionOptions {
  /** Override the connection name (defaults to the adapter name). */
  readonly name?: string;
}

/** Wrap a validated adapter in a managed, production-safe connection. @public */
export function createConnection<Client = unknown>(
  adapter: DatabaseAdapter<Client>,
  config: DatabaseAdapterConfig,
  options: CreateConnectionOptions = {},
): ManagedConnection<Client> {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.connect !== 'function' || typeof adapter.disconnect !== 'function') {
    throw new TypeError('A complete, validated database adapter is required.');
  }
  const frozenConfig: DatabaseAdapterConfig = Object.freeze({ ...config });
  const name = options.name ?? adapter.name;
  let state: ConnectionState = 'idle';
  let context: DatabaseAdapterContext<Client> | undefined;
  let connectPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let activeOperations = 0;
  let drainOperations: (() => void) | undefined;

  const requireContext = (): DatabaseAdapterContext<Client> => {
    if (state !== 'connected' || context === undefined) {
      throw new DatabaseAdapterError(`Connection "${name}" requires the connected state; current state is ${state}.`, 'DATABASE_ADAPTER_LIFECYCLE');
    }
    return context;
  };
  const beginOperation = (): void => {
    requireContext();
    activeOperations += 1;
  };
  const endOperation = (): void => {
    activeOperations -= 1;
    if (activeOperations === 0) {
      const resolve = drainOperations;
      drainOperations = undefined;
      resolve?.();
    }
  };

  const connect = async (): Promise<void> => {
    if (state === 'connected') return;
    if (state === 'closing' || state === 'closed') {
      throw new DatabaseAdapterError(`Connection "${name}" is closed and cannot be reconnected.`, 'DATABASE_ADAPTER_LIFECYCLE');
    }
    if (connectPromise !== undefined) return connectPromise;
    state = 'connecting';
    connectPromise = (async () => {
      try {
        const ctx = await adapter.connect(frozenConfig);
        if (ctx === null || typeof ctx !== 'object' || ctx.client === undefined || ctx.client === null) {
          throw new TypeError('Adapter connect() must return a context carrying a native client.');
        }
        context = ctx;
        if (state === 'connecting') state = 'connected';
      } catch (cause) {
        state = 'failed';
        if (cause instanceof DatabaseAdapterError) throw cause;
        throw new DatabaseAdapterError(`Connection "${name}" failed to initialise.`, 'DATABASE_ADAPTER_CONNECT', cause);
      } finally {
        connectPromise = undefined;
      }
    })();
    return connectPromise;
  };

  const close = async (): Promise<void> => {
    if (state === 'closed') return;
    if (closePromise !== undefined) return closePromise;
    state = 'closing';
    closePromise = (async () => {
      try {
        if (connectPromise !== undefined) await connectPromise.catch(() => undefined);
        if (activeOperations > 0) {
          await new Promise<void>((resolve) => { drainOperations = resolve; });
        }
        const ctx = context;
        context = undefined;
        if (ctx !== undefined) await adapter.disconnect(ctx);
        state = 'closed';
      } catch (cause) {
        state = 'failed';
        throw new DatabaseAdapterError(`Connection "${name}" failed to shut down cleanly.`, 'DATABASE_ADAPTER_DISCONNECT', cause);
      } finally {
        closePromise = undefined;
      }
    })();
    return closePromise;
  };

  const healthCheck = async (): Promise<HealthCheckReport> => {
    const started = Date.now();
    const checkedAt = started;
    const checkedBy = name;
    if (state !== 'connected' || context === undefined) {
      return Object.freeze({ healthy: false, latencyMs: 0, checkedAt, checkedBy, error: `Connection is ${state}.` });
    }
    const check = adapter.healthCheck;
    if (!adapter.capabilities.healthCheck || check === undefined) {
      return Object.freeze({ healthy: false, latencyMs: 0, checkedAt, checkedBy, error: 'This adapter does not declare the healthCheck capability.' });
    }
    try {
      const ok = await check(context);
      return Object.freeze({
        healthy: ok === true,
        latencyMs: Date.now() - started,
        checkedAt,
        checkedBy,
        ...(ok === true ? {} : { error: 'The adapter reported an unhealthy connection.' }),
      });
    } catch {
      // Never surface raw driver/connection strings in a health report.
      return Object.freeze({ healthy: false, latencyMs: Date.now() - started, checkedAt, checkedBy, error: 'The health check raised an adapter error.' });
    }
  };

  const transaction = async <T>(
    callback: (tx: DatabaseAdapterContext<Client>) => Promise<T>,
    txOptions?: TransactionOptions,
  ): Promise<T> => {
    if (typeof callback !== 'function') throw new TypeError('A transaction callback is required.');
    beginOperation();
    try {
      assertNotAborted(txOptions?.signal);
      const runTransaction = adapter.transaction;
      if (!adapter.capabilities.transactions || runTransaction === undefined) {
        throw new UnsupportedCapabilityError('transactions');
      }
      const ctx = requireContext();
      let callbackFailure: unknown;
      let callbackFailed = false;
      try {
        return await runTransaction<T>(ctx, async (txContext) => {
          assertNotAborted(txOptions?.signal);
          try { return await callback(txContext); }
          catch (cause) { callbackFailed = true; callbackFailure = cause; throw cause; }
        });
      } catch (cause) {
        if (callbackFailed && cause === callbackFailure) throw cause;
        if (cause instanceof DatabaseAdapterError) throw cause;
        throw new AdapterTransactionError('The adapter transaction failed.', cause);
      }
    } finally {
      endOperation();
    }
  };

  const native = (): Client => requireContext().client;
  const contextFn = (): DatabaseAdapterContext<Client> => requireContext();
  const info = (): ConnectionInfo => Object.freeze({ name, adapter: adapter.name, state, capabilities: adapter.capabilities });

  return Object.freeze({
    get name(): string { return name; },
    get state(): ConnectionState { return state; },
    get capabilities(): DatabaseAdapterCapabilities { return adapter.capabilities; },
    connect,
    close,
    healthCheck,
    transaction,
    native,
    context: contextFn,
    info,
  });
}

/**
 * Manages several named connections and provides coordinated startup,
 * health checks, and graceful shutdown (all connections closed even if one
 * fails; failures aggregated). @public
 */
export class ConnectionManager {
  readonly #connections = new Map<string, ManagedConnection<unknown>>();

  add<Client>(name: string, connection: ManagedConnection<Client>): this {
    if (typeof name !== 'string' || name === '') throw new TypeError('A connection name is required.');
    if (this.#connections.has(name)) throw new DatabaseAdapterError(`A connection named "${name}" already exists.`, 'DATABASE_ADAPTER_DUPLICATE');
    this.#connections.set(name, connection as unknown as ManagedConnection<unknown>);
    return this;
  }
  get<Client = unknown>(name: string): ManagedConnection<Client> | undefined {
    return this.#connections.get(name) as ManagedConnection<Client> | undefined;
  }
  require<Client = unknown>(name: string): ManagedConnection<Client> {
    const c = this.#connections.get(name);
    if (c === undefined) throw new DatabaseAdapterError(`No connection named "${name}" exists.`, 'DATABASE_ADAPTER_NOT_FOUND');
    return c as unknown as ManagedConnection<Client>;
  }
  has(name: string): boolean { return this.#connections.has(name); }
  names(): readonly string[] { return Object.freeze([...this.#connections.keys()]); }
  get size(): number { return this.#connections.size; }
  remove(name: string): boolean { return this.#connections.delete(name); }

  async connectAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#connections.values()].map((c) => c.connect()));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) throw new DatabaseAdapterError(`${String(failed.length)} connection(s) failed to start.`, 'DATABASE_ADAPTER_CONNECT');
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#connections.values()].map((c) => c.close()));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) throw new DatabaseAdapterError(`${String(failed.length)} connection(s) failed to close cleanly.`, 'DATABASE_ADAPTER_DISCONNECT');
  }

  async healthCheckAll(): Promise<Readonly<Record<string, HealthCheckReport>>> {
    const entries = await Promise.all(
      [...this.#connections.entries()].map(async ([n, c]) => [n, await c.healthCheck()] as const),
    );
    return Object.freeze(Object.fromEntries(entries));
  }
}

/** Create an isolated connection manager. @public */
export function createConnectionManager(): ConnectionManager { return new ConnectionManager(); }

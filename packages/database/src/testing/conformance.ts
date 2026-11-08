import {
  DatabaseAdapterError,
  validateAdapterDefinition,
  type DatabaseAdapter,
  type DatabaseAdapterConfig,
  type DatabaseAdapterCapabilities,
} from '../contracts/adapter.js';
import { createConnection, type ManagedConnection } from '../core/lifecycle.js';

/** A live adapter + config + teardown hook under test. @public */
export interface ConformanceSubject<Client = unknown> {
  readonly adapter: DatabaseAdapter<Client>;
  readonly config: DatabaseAdapterConfig;
  readonly cleanup?: () => Promise<void>;
}
/** Factory that creates an isolated subject for each conformance run. @public */
export interface ConformanceFactory<Client = unknown> {
  readonly name: string;
  create(): Promise<ConformanceSubject<Client>>;
}
export interface ConformanceCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
}
export interface ConformanceReport {
  readonly subject: string;
  readonly passed: boolean;
  readonly results: readonly ConformanceCheckResult[];
}

function safeMessage(cause: unknown): string {
  const raw = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return raw
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/)[^\s@/]*:[^\s@/]*@/gi, '$1[redacted]@')
    .slice(0, 300);
}

function capabilitiesConsistent(adapter: DatabaseAdapter<unknown>): boolean {
  const c: DatabaseAdapterCapabilities = adapter.capabilities;
  if (c.transactions && adapter.transaction === undefined) return false;
  if (c.healthCheck && adapter.healthCheck === undefined) return false;
  if (c.migrations && adapter.migrate === undefined) return false;
  if (c.savepoints && !c.transactions) return false;
  return true;
}

/**
 * Run a shared conformance suite against any database adapter. Every official
 * adapter and any custom (BYO ORM) adapter can be validated with the exact same
 * checks: definition validity, capability consistency, connect idempotency,
 * health checks, transactions + application-error propagation, native-client
 * access, draining shutdown and post-close rejection.
 *
 * The function is framework-agnostic (no `node:test` dependency): it returns a
 * report so callers can assert with their preferred test runner.
 *
 * @public
 */
export async function runAdapterConformance<Client = unknown>(
  factory: ConformanceFactory<Client>,
): Promise<ConformanceReport> {
  const results: ConformanceCheckResult[] = [];
  const record = (name: string, passed: boolean, error?: string): void => {
    results.push(Object.freeze(error === undefined ? { name, passed } : { name, passed, error }));
  };
  const attempt = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try { await fn(); record(name, true); }
    catch (cause) { record(name, false, safeMessage(cause)); }
  };

  let subject: ConformanceSubject<Client> | undefined;
  let connection: ManagedConnection<Client> | undefined;
  try {
    subject = await factory.create();
    const adapter = subject.adapter;
    const conn = createConnection<Client>(adapter, subject.config);
    connection = conn;

    await attempt('definition-is-valid', () => {
      validateAdapterDefinition(adapter);
      if (typeof adapter.name !== 'string' || adapter.name === '') throw new Error('Adapter name is missing.');
      if (typeof adapter.capabilities !== 'object' || adapter.capabilities === null) throw new Error('Capabilities are not resolved.');
    });
    await attempt('capabilities-are-consistent', () => {
      if (!capabilitiesConsistent(adapter as unknown as DatabaseAdapter<unknown>)) {
        throw new Error('Declared capabilities do not match the implementations.');
      }
    });
    await attempt('connect-produces-context', async () => {
      await conn.connect();
      const ctx = conn.context();
      if (ctx.client === undefined || ctx.client === null) throw new Error('Context has no native client.');
      if (!Object.isFrozen(ctx.config)) throw new Error('Context config is not frozen.');
      if (ctx.adapter !== adapter.name) throw new Error('Context adapter name does not match.');
      if (conn.state !== 'connected') throw new Error('Connection did not reach connected state.');
    });
    await attempt('connect-is-idempotent', async () => {
      const before = conn.context();
      await Promise.all([conn.connect(), conn.connect()]);
      if (conn.context() !== before) throw new Error('Reconnect replaced the live context.');
      if (conn.state !== 'connected') throw new Error('State changed on idempotent connect.');
    });
    await attempt('native-client-is-accessible', () => {
      if (conn.native() !== conn.context().client) throw new Error('native() does not expose the ORM client.');
    });

    if (adapter.capabilities.healthCheck) {
      await attempt('health-check-reports-healthy', async () => {
        const report = await conn.healthCheck();
        if (report.healthy !== true) throw new Error(`Health check failed: ${report.error ?? 'unknown'}`);
        if (typeof report.latencyMs !== 'number' || report.latencyMs < 0) throw new Error('Invalid latency.');
      });
    } else {
      await attempt('health-check-not-claimed', () => {
        if (adapter.healthCheck !== undefined) throw new Error('Undeclared healthCheck implementation present.');
      });
    }

    if (adapter.capabilities.transactions) {
      await attempt('transaction-executes-and-returns-result', async () => {
        const value = await conn.transaction(async (tx) => {
          if (tx.client === undefined || tx.client === null) throw new Error('Transaction context has no client.');
          return 42;
        });
        if (value !== 42) throw new Error('Transaction did not return the callback result.');
      });
      await attempt('transaction-preserves-application-errors', async () => {
        const expected = new Error('domain failure');
        let seen: unknown;
        try { await conn.transaction(async () => { throw expected; }); }
        catch (cause) { seen = cause; }
        if (seen !== expected) throw new Error('Application error was not propagated unchanged.');
      });
    } else {
      await attempt('transaction-not-claimed', () => {
        if (adapter.transaction !== undefined) throw new Error('Undeclared transaction implementation present.');
      });
    }

    await attempt('close-is-idempotent', async () => {
      await Promise.all([conn.close(), conn.close()]);
      if (conn.state !== 'closed') throw new Error('Connection did not reach closed state.');
    });
    await attempt('native-access-rejected-after-close', () => {
      let threw = false;
      try { conn.native(); } catch (cause) { threw = cause instanceof DatabaseAdapterError; }
      if (!threw) throw new Error('native() should be rejected after close.');
    });
  } catch (cause) {
    record('suite-setup', false, safeMessage(cause));
  } finally {
    if (connection !== undefined) await connection.close().catch(() => undefined);
    const cleanup = subject?.cleanup;
    if (cleanup !== undefined) await cleanup().catch(() => undefined);
  }

  return Object.freeze({
    subject: factory.name,
    passed: results.every((r) => r.passed),
    results: Object.freeze(results),
  });
}

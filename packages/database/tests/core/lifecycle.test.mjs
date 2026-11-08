import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConnection,
  createConnectionManager,
  defineDatabaseAdapter,
  defineAdapterContext,
  DatabaseAdapterError,
  UnsupportedCapabilityError,
  AdapterTransactionError,
} from '../../dist/index.js';
import { createMemoryAdapter } from '../helpers/adapter.mjs';

const CONFIG = Object.freeze({ host: 'localhost' });

test('connect is idempotent for concurrent callers; close is idempotent', async () => {
  const { adapter, state } = createMemoryAdapter();
  const conn = createConnection(adapter, CONFIG);
  await Promise.all([conn.connect(), conn.connect(), conn.connect()]);
  assert.equal(state.connects, 1);
  assert.equal(conn.state, 'connected');
  await Promise.all([conn.close(), conn.close()]);
  assert.equal(state.disconnects, 1);
  assert.equal(conn.state, 'closed');
});

test('connection cannot be reopened after close and rejects native() in wrong state', async () => {
  const { adapter } = createMemoryAdapter();
  const conn = createConnection(adapter, CONFIG);
  assert.throws(() => conn.native(), DatabaseAdapterError);
  await conn.connect();
  assert.equal(typeof conn.native(), 'object');
  await conn.close();
  await assert.rejects(() => conn.connect(), DatabaseAdapterError);
  assert.throws(() => conn.native(), DatabaseAdapterError);
});

test('failed connect enters failed state and wraps the cause without leaking it', async () => {
  const { adapter } = createMemoryAdapter({ connectError: new Error('super-secret://user:pass@host') });
  const conn = createConnection(adapter, CONFIG);
  await assert.rejects(() => conn.connect(), (err) =>
    err instanceof DatabaseAdapterError && !err.message.includes('super-secret') && !err.message.includes('pass@host'));
  assert.equal(conn.state, 'failed');
  await conn.close();
});

test('healthCheck returns a healthy report and records latency', async () => {
  const { adapter, state } = createMemoryAdapter();
  const conn = createConnection(adapter, CONFIG);
  await conn.connect();
  const report = await conn.healthCheck();
  assert.equal(report.healthy, true);
  assert.equal(report.checkedBy, 'memory');
  assert.equal(typeof report.latencyMs, 'number');
  assert.equal(typeof report.checkedAt, 'number');
  assert.equal(state.healthChecks, 1);
  await conn.close();
});

test('healthCheck reports unhealthy for a disconnected connection without throwing', async () => {
  const { adapter } = createMemoryAdapter();
  const conn = createConnection(adapter, CONFIG);
  const report = await conn.healthCheck();
  assert.equal(report.healthy, false);
  assert.match(report.error, /idle/);
  await conn.close();
});

test('healthCheck sanitises adapter errors and handles undeclared capability', async () => {
  const failing = createMemoryAdapter({ healthCheckError: new Error('password=hunter2 leaked') });
  const c1 = createConnection(failing.adapter, CONFIG);
  await c1.connect();
  const r1 = await c1.healthCheck();
  assert.equal(r1.healthy, false);
  assert.equal(r1.error, 'The health check raised an adapter error.');
  assert.equal(JSON.stringify(r1).includes('hunter2'), false);
  await c1.close();

  const noHealth = createMemoryAdapter({ withHealthCheck: false });
  const c2 = createConnection(noHealth.adapter, CONFIG);
  await c2.connect();
  const r2 = await c2.healthCheck();
  assert.equal(r2.healthy, false);
  assert.match(r2.error, /does not declare/);
  await c2.close();
});

test('transaction returns the callback result and exposes a native tx client', async () => {
  const { adapter, state } = createMemoryAdapter();
  const conn = createConnection(adapter, CONFIG);
  await conn.connect();
  const value = await conn.transaction(async (tx) => {
    assert.ok(tx.client instanceof Map);
    assert.equal(Object.isFrozen(tx.config), true);
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.equal(state.transactions, 1);
  await conn.close();
});

test('transaction preserves application errors and wraps driver errors', async () => {
  const { adapter } = createMemoryAdapter();
  const conn = createConnection(adapter, CONFIG);
  await conn.connect();
  const expected = new Error('domain');
  await assert.rejects(() => conn.transaction(async () => { throw expected; }), (e) => e === expected);
  await conn.close();

  const broken = createMemoryAdapter({ transactionError: new Error('private driver detail') });
  const c2 = createConnection(broken.adapter, CONFIG);
  await c2.connect();
  await assert.rejects(() => c2.transaction(async () => 1), (e) =>
    e instanceof AdapterTransactionError && !e.message.includes('private driver detail'));
  await c2.close();
});

test('transaction is rejected for undeclared capability, invalid callback and aborted signal', async () => {
  const { adapter } = createMemoryAdapter({ withTransaction: false, withHealthCheck: false });
  const conn = createConnection(adapter, CONFIG);
  await conn.connect();
  await assert.rejects(() => conn.transaction(async () => 1), UnsupportedCapabilityError);
  await conn.close();

  const { adapter: a2 } = createMemoryAdapter();
  const c2 = createConnection(a2, CONFIG);
  await c2.connect();
  await assert.rejects(() => c2.transaction(null), TypeError);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(() => c2.transaction(async () => 1, { signal: controller.signal }), /cancelled/);
  await c2.close();
});

test('close drains in-flight transactions before disconnecting', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let disconnected = false;
  const adapter = defineDatabaseAdapter({
    name: 'slow',
    async connect(config) { return defineAdapterContext('slow', {}, config); },
    async disconnect() { disconnected = true; },
    async healthCheck() { return true; },
    async transaction(_ctx, cb) { await gate; return cb(_ctx); },
  });
  const conn = createConnection(adapter, CONFIG);
  await conn.connect();
  const running = conn.transaction(async () => 1);
  const closing = conn.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(disconnected, false);
  release();
  await running;
  await closing;
  assert.equal(disconnected, true);
  assert.equal(conn.state, 'closed');
});

test('info() describes name, adapter, state and capabilities', async () => {
  const { adapter } = createMemoryAdapter({ name: 'alpha' });
  const conn = createConnection(adapter, CONFIG);
  const before = conn.info();
  assert.equal(before.name, 'alpha');
  assert.equal(before.adapter, 'alpha');
  assert.equal(before.state, 'idle');
  assert.equal(before.capabilities.transactions, true);
  assert.equal(Object.isFrozen(before), true);
  await conn.connect();
  assert.equal(conn.info().state, 'connected');
  await conn.close();
});

test('ConnectionManager coordinates startup, health checks and graceful shutdown', async () => {
  const mgr = createConnectionManager();
  const c1 = createConnection(createMemoryAdapter({ name: 'one' }).adapter, CONFIG);
  const c2 = createConnection(createMemoryAdapter({ name: 'two' }).adapter, CONFIG);
  mgr.add('one', c1).add('two', c2);
  assert.equal(mgr.size, 2);
  assert.deepEqual(mgr.names(), ['one', 'two']);
  assert.throws(() => mgr.add('one', c1), DatabaseAdapterError);
  assert.throws(() => mgr.require('missing'), DatabaseAdapterError);

  await mgr.connectAll();
  assert.equal(c1.state, 'connected');
  assert.equal(c2.state, 'connected');
  const reports = await mgr.healthCheckAll();
  assert.equal(reports.one.healthy, true);
  assert.equal(reports.two.healthy, true);
  await mgr.closeAll();
  assert.equal(c1.state, 'closed');
  assert.equal(c2.state, 'closed');
});

test('closeAll still closes healthy connections when one disconnect fails', async () => {
  const mgr = createConnectionManager();
  const good = createConnection(createMemoryAdapter({ name: 'good' }).adapter, CONFIG);
  const badAdapter = defineDatabaseAdapter({
    name: 'bad',
    async connect(config) { return defineAdapterContext('bad', {}, config); },
    async disconnect() { throw new Error('close failed'); },
  });
  const bad = createConnection(badAdapter, CONFIG);
  mgr.add('good', good).add('bad', bad);
  await mgr.connectAll();
  await assert.rejects(() => mgr.closeAll(), DatabaseAdapterError);
  assert.equal(good.state, 'closed');
  assert.equal(bad.state, 'failed');
});

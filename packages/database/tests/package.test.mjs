import test from 'node:test';
import assert from 'node:assert/strict';
import { Database, DatabaseLifecycleError, DatabaseDriverError } from '../dist/index.js';
function makeDriver(overrides = {}) {
  const calls = { connect: 0, disconnect: 0, query: 0, transaction: 0 };
  const driver = {
    async connect() { calls.connect++; }, async disconnect() { calls.disconnect++; },
    async query(sql, parameters) { calls.query++; return { rows: [{ sql, parameters }], rowCount: 1 }; },
    async transaction(callback) { calls.transaction++; return callback({ query: async (sql, parameters) => ({ rows: [{ sql, parameters }], rowCount: 1 }) }); },
    ...overrides,
  };
  return { driver, calls };
}
test('database connects once for concurrent callers and closes idempotently', async () => {
  const { driver, calls } = makeDriver(); const db = new Database(driver);
  await Promise.all([db.connect(), db.connect(), db.connect()]);
  assert.equal(calls.connect, 1); assert.equal(db.state, 'ready');
  await Promise.all([db.close(), db.close()]); assert.equal(calls.disconnect, 1); assert.equal(db.state, 'closed');
});
test('database rejects operations before connect and after close', async () => {
  const { driver } = makeDriver(); const db = new Database(driver);
  await assert.rejects(() => db.query('select 1'), DatabaseLifecycleError);
  await db.connect(); await db.close(); await assert.rejects(() => db.query('select 1'), DatabaseLifecycleError);
});
test('database validates SQL and bound parameter values', async () => {
  const { driver } = makeDriver(); const db = new Database(driver); await db.connect();
  await assert.rejects(() => db.query('  '), TypeError);
  await assert.rejects(() => db.query('select ?', [Symbol('x')]), TypeError);
  await assert.rejects(() => db.query('select ?', [new Date('invalid')]), TypeError);
});
test('database wraps driver failures without exposing driver messages', async () => {
  const { driver } = makeDriver({ async query() { throw new Error('secret connection string'); } });
  const db = new Database(driver); await db.connect();
  await assert.rejects(() => db.query('select 1'), error => error instanceof DatabaseDriverError && !error.message.includes('secret'));
});
test('database transaction passes a scoped executor and returns callback result', async () => {
  const { driver, calls } = makeDriver(); const db = new Database(driver); await db.connect();
  const result = await db.transaction(async tx => { const rows = await tx.query('select ?', [1]); return rows.rows[0].parameters[0]; });
  assert.equal(result, 1); assert.equal(calls.transaction, 1);
});
test('database rejects aborted operations', async () => {
  const { driver, calls } = makeDriver(); const db = new Database(driver); await db.connect();
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(() => db.query('select 1', [], { signal: controller.signal }), /cancelled/); assert.equal(calls.query, 0);
});
test('failed connection enters failed state and can be closed', async () => {
  const { driver, calls } = makeDriver({ async connect() { throw new Error('offline'); } }); const db = new Database(driver);
  await assert.rejects(() => db.connect(), DatabaseDriverError); assert.equal(db.state, 'failed'); await db.close(); assert.equal(calls.disconnect, 1);
});
test('closing during connection does not reopen the database state', async () => {
  let resolveConnect; const gate = new Promise(resolve => { resolveConnect = resolve; }); const { driver, calls } = makeDriver({ async connect() { await gate; } });
  const db = new Database(driver); const connecting = db.connect(); const closing = db.close(); assert.equal(db.state, 'closing'); resolveConnect(); await connecting; await closing; assert.equal(db.state, 'closed'); assert.equal(calls.disconnect, 1);
});
test('driver result shape is validated before returning it', async () => {
  const { driver } = makeDriver({ async query() { return { rows: 'not-an-array', rowCount: -1 }; } }); const db = new Database(driver); await db.connect();
  await assert.rejects(() => db.query('select 1'), DatabaseDriverError);
});
test('transaction executor cannot be used after its callback completes', async () => {
  const { driver } = makeDriver(); const db = new Database(driver); await db.connect(); let leaked;
  await db.transaction(async tx => { leaked = tx; }); await assert.rejects(() => leaked.query('select 1'), /no longer active/);
});
test('database rejects non-finite numeric parameters', async () => {
  const { driver } = makeDriver(); const db = new Database(driver); await db.connect(); await assert.rejects(() => db.query('select ?', [Number.NaN]), TypeError);
});

test('close drains active queries before disconnecting the driver', async () => {
  let releaseQuery; const queryGate = new Promise(resolve => { releaseQuery = resolve; }); let disconnected = false;
  const { driver } = makeDriver({ async query() { await queryGate; return { rows: [], rowCount: 0 }; }, async disconnect() { disconnected = true; } });
  const db = new Database(driver); await db.connect(); const query = db.query('select 1'); const closing = db.close();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disconnected, false); releaseQuery(); await query; await closing; assert.equal(disconnected, true);
});
test('transaction preserves application errors from the callback', async () => {
  const { driver } = makeDriver(); const db = new Database(driver); await db.connect(); const expected = new Error('domain failure');
  await assert.rejects(() => db.transaction(async () => { throw expected; }), error => error === expected);
});
test('transaction wraps driver-level transaction failures', async () => {
  const { driver } = makeDriver({ async transaction() { throw new Error('private driver detail'); } }); const db = new Database(driver); await db.connect();
  await assert.rejects(() => db.transaction(async () => 1), error => error instanceof DatabaseDriverError && !error.message.includes('private driver detail'));
});
test('database rejects incomplete drivers at construction', () => { assert.throws(() => new Database({}), TypeError); });

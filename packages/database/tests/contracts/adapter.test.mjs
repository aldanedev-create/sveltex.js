import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineDatabaseAdapter,
  defineAdapterContext,
  validateAdapterDefinition,
  DEFAULT_ADAPTER_CAPABILITIES,
  DatabaseAdapterError,
} from '../../dist/index.js';

function minimal(overrides = {}) {
  return {
    name: 'valid',
    async connect(config) { return defineAdapterContext('valid', {}, config); },
    async disconnect() {},
    ...overrides,
  };
}

test('defineDatabaseAdapter freezes the adapter and resolves capabilities', () => {
  const adapter = defineDatabaseAdapter(minimal({
    async healthCheck() { return true; },
    async transaction(_ctx, cb) { return cb(defineAdapterContext('valid', {}, Object.freeze({}))); },
  }));
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(adapter.capabilities), true);
  assert.deepEqual(adapter.capabilities, {
    transactions: true, savepoints: false, healthCheck: true, migrations: false,
  });
});

test('undeclared capabilities default to false', () => {
  const adapter = defineDatabaseAdapter(minimal());
  assert.deepEqual(adapter.capabilities, DEFAULT_ADAPTER_CAPABILITIES);
});

test('rejects malformed names', () => {
  for (const name of ['', 'A', 'has space', 'x; DROP TABLE users', '../escape', 'a'.repeat(65)]) {
    assert.throws(() => defineDatabaseAdapter(minimal({ name })), TypeError);
  }
  assert.doesNotThrow(() => defineDatabaseAdapter(minimal({ name: 'my-orm.v2_x' })));
});

test('rejects definitions with missing lifecycle hooks', () => {
  assert.throws(() => defineDatabaseAdapter({ name: 'x', async disconnect() {} }), TypeError);
  assert.throws(() => defineDatabaseAdapter({ name: 'x', async connect() {} }), TypeError);
  assert.throws(() => defineDatabaseAdapter(null), TypeError);
});

test('rejects capabilities that are not backed by implementations', () => {
  assert.throws(() => defineDatabaseAdapter(minimal({ capabilities: { transactions: true } })), /transactions capability/);
  assert.throws(() => defineDatabaseAdapter(minimal({ capabilities: { healthCheck: true } })), /healthCheck capability/);
  assert.throws(() => defineDatabaseAdapter(minimal({ capabilities: { migrations: true } })), /migrations capability/);
  assert.throws(() => defineDatabaseAdapter(minimal({ capabilities: { savepoints: true, transactions: false }, async transaction(_c, cb) { return cb(_c); } })), /savepoints without transactions/);
});

test('rejects unknown capability keys and non-boolean values', () => {
  assert.throws(() => defineDatabaseAdapter(minimal({ capabilities: { telepathy: true } })), /Unknown adapter capability/);
  assert.throws(() => defineDatabaseAdapter(minimal({ capabilities: { transactions: 'yes' } })), /must be a boolean/);
});

test('validateAdapterDefinition accepts a well-formed adapter', () => {
  assert.doesNotThrow(() => validateAdapterDefinition(defineDatabaseAdapter(minimal())));
});

test('defineAdapterContext is frozen, preserves the native client, validates input', () => {
  const client = { query() {} };
  const config = Object.freeze({ host: 'localhost' });
  const ctx = defineAdapterContext('my-orm', client, config);
  assert.equal(Object.isFrozen(ctx), true);
  assert.equal(ctx.client, client);
  assert.equal(ctx.config.host, 'localhost');
  assert.equal(ctx.adapter, 'my-orm');
  assert.throws(() => defineAdapterContext('', client, config), TypeError);
  assert.throws(() => defineAdapterContext('my-orm', null, config), TypeError);
});

test('DatabaseAdapterError carries a stable code and optional cause', () => {
  const cause = new Error('root');
  const err = new DatabaseAdapterError('failed', 'MY_CODE', cause);
  assert.equal(err.name, 'DatabaseAdapterError');
  assert.equal(err.code, 'MY_CODE');
  assert.equal(err.cause, cause);
  assert.equal(new DatabaseAdapterError('x').code, 'DATABASE_ADAPTER');
});

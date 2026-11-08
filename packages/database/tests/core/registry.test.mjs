import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAdapterRegistry,
  defineDatabaseAdapter,
  defineAdapterContext,
  DatabaseAdapterError,
} from '../../dist/index.js';
import { createMemoryAdapter } from '../helpers/adapter.mjs';

function namedAdapter(name, capabilities) {
  return defineDatabaseAdapter({
    name,
    ...(capabilities === undefined ? {} : { capabilities }),
    async connect(config) { return defineAdapterContext(name, new Map(), config); },
    async disconnect() {},
    async healthCheck() { return true; },
    ...(capabilities?.transactions === false ? {} : {
      async transaction(_ctx, cb) { return cb(_ctx); },
    }),
  });
}

test('registry stores, retrieves and enumerates adapters', () => {
  const reg = createAdapterRegistry();
  const a = namedAdapter('primary');
  reg.register(a);
  assert.equal(reg.size, 1);
  assert.equal(reg.has('primary'), true);
  assert.equal(reg.get('primary'), a);
  assert.equal(reg.require('primary'), a);
  assert.deepEqual(reg.names(), ['primary']);
});

test('duplicate names and unknown names are rejected with stable errors', () => {
  const reg = createAdapterRegistry();
  reg.register(namedAdapter('dup'));
  assert.throws(() => reg.register(namedAdapter('dup')), (err) => err instanceof DatabaseAdapterError && err.code === 'DATABASE_ADAPTER_DUPLICATE');
  assert.throws(() => reg.require('missing'), (err) => err instanceof DatabaseAdapterError && err.code === 'DATABASE_ADAPTER_NOT_FOUND');
  assert.equal(reg.get('missing'), undefined);
});

test('register() validates adapter definitions before storing', () => {
  const reg = createAdapterRegistry();
  assert.throws(() => reg.register({ name: 'Bad Name', async connect() {}, async disconnect() {} }), TypeError);
  assert.equal(reg.size, 0);
});

test('matching() discovers adapters by declared capability', () => {
  const reg = createAdapterRegistry();
  const full = namedAdapter('full', { transactions: true, healthCheck: true });
  const minimal = namedAdapter('minimal', { transactions: false, healthCheck: false });
  reg.registerMany([full, minimal]);
  assert.equal(reg.size, 2);
  assert.deepEqual(reg.matching('transactions').map((a) => a.name), ['full']);
  assert.deepEqual(reg.matching('healthCheck').map((a) => a.name), ['full']);
  assert.equal(reg.matching('migrations').length, 0);
});

test('unregister and clear remove entries', () => {
  const reg = createAdapterRegistry();
  reg.register(createMemoryAdapter({ name: 'x' }).adapter);
  assert.equal(reg.unregister('x'), true);
  assert.equal(reg.unregister('x'), false);
  reg.register(createMemoryAdapter({ name: 'y' }).adapter);
  reg.clear();
  assert.equal(reg.size, 0);
});

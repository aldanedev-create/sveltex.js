import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, ProviderRegistry, token } from '../../dist/index.js';

test('does not mutate caller-owned config objects', () => {
  const metadata = { nested: { value: 'safe' } };
  createApplication({ config: { name: 'safe', metadata } });
  assert.equal(Object.isFrozen(metadata), false);
  assert.equal(Object.isFrozen(metadata.nested), false);
});

test('copies __proto__ as inert own data instead of changing the clone prototype', () => {
  const metadata = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const app = createApplication({ config: { name: 'prototype-test', metadata } });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(app.config.metadata), Object.prototype);
  assert.equal(Object.hasOwn(app.config.metadata, '__proto__'), true);
});

test('rejects non-plain objects in metadata', () => {
  const values = [new Date(), new Map(), new Set(), /secret/, new (class Secret {})()];
  for (const value of values) assert.throws(() => createApplication({ config: { name: 'x', metadata: { value } } }), { code: 'SX_CONFIG_INVALID' });
});

test('provider registry does not expose a mutable backing collection', () => {
  const registry = new ProviderRegistry(); const KEY = token('registry-immutability');
  registry.register({ provide: KEY, useValue: 1 });
  const entries = registry.entries();
  assert.equal(Object.isFrozen(entries), true);
  assert.throws(() => entries.push({ provide: 'injected', useValue: true }));
  assert.equal(registry.has('injected'), false);
});

test('token names are namespaced and blank names are rejected', () => {
  assert.equal(String(token('security.example')), 'Symbol(@sveltex/security.example)');
  assert.throws(() => token('  '), TypeError);
});

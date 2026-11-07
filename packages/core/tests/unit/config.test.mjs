import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, defineConfig } from '../../dist/index.js';

const valid = { name: ' config-test ', environment: 'test' };

test('trims the application name and preserves optional configuration', () => {
  const app = createApplication({ config: valid });
  assert.equal(app.config.name, 'config-test');
  assert.equal(app.config.environment, 'test');
  assert.equal(app.config.debug, undefined);
});

test('rejects arrays, dates, class instances, and null as top-level config', () => {
  class Custom { name = 'custom'; }
  for (const config of [null, [], new Date(), new Custom(), 'name']) {
    assert.throws(() => createApplication({ config }), { code: 'SX_CONFIG_INVALID' });
  }
});

test('rejects invalid optional config fields', () => {
  const invalid = [
    { name: 'x', environment: '' },
    { name: 'x', debug: 'true' },
    { name: 'x', metadata: [] },
    { name: 'x', metadata: new Date() },
  ];
  for (const config of invalid) assert.throws(() => createApplication({ config }), { code: 'SX_CONFIG_INVALID' });
});

test('clones and deeply freezes metadata without freezing caller objects', () => {
  const metadata = { nested: { enabled: true }, list: [{ value: 1 }] };
  const app = createApplication({ config: { name: 'x', metadata } });
  assert.notEqual(app.config.metadata, metadata);
  assert.notEqual(app.config.metadata.nested, metadata.nested);
  assert.equal(Object.isFrozen(app.config.metadata), true);
  assert.equal(Object.isFrozen(app.config.metadata.nested), true);
  assert.equal(Object.isFrozen(app.config.metadata.list[0]), true);
  metadata.nested.enabled = false;
  assert.equal(app.config.metadata.nested.enabled, true);
  assert.equal(Object.isFrozen(metadata.nested), false);
});

test('handles repeated references in metadata while preserving graph identity', () => {
  const shared = { flag: true };
  const app = createApplication({ config: { name: 'x', metadata: { a: shared, b: shared } } });
  assert.equal(app.config.metadata.a, app.config.metadata.b);
});

test('rejects functions, symbols, and bigint metadata values', () => {
  for (const value of [() => {}, Symbol('x'), 1n]) {
    assert.throws(() => createApplication({ config: { name: 'x', metadata: { value } } }), { code: 'SX_CONFIG_INVALID' });
  }
});

test('defineConfig clones and freezes nested values', () => {
  const source = { feature: { enabled: true }, values: [1, 2] };
  const config = defineConfig(source);
  source.feature.enabled = false;
  assert.equal(config.value.feature.enabled, true);
  assert.equal(Object.isFrozen(config.value.feature), true);
  assert.equal(Object.isFrozen(config.value.values), true);
});

test('defineConfig executes an explicit validator and preserves its identity', () => {
  let called = false;
  const validator = (value) => { called = true; assert.equal(value.port, 3000); };
  const result = defineConfig({ port: 3000 }, validator);
  assert.equal(called, true);
  assert.equal(result.validate, validator);
});

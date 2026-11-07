import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, defineModule, token } from '../../dist/index.js';

test('runtime compatibility: public package entrypoint imports as native ESM', async () => {
  const entry = await import('../../dist/index.js');
  assert.equal(typeof entry.createApplication, 'function');
  assert.equal(typeof entry.Container, 'function');
});

test('runtime compatibility: core does not require browser globals', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  try {
    delete globalThis.window;
    delete globalThis.document;
    const app = createApplication({ config: { name: 'headless' } });
    await app.start(); await app.stop();
  } finally {
    if (originalWindow !== undefined) globalThis.window = originalWindow;
    if (originalDocument !== undefined) globalThis.document = originalDocument;
  }
});

test('runtime compatibility: application instances have isolated state', async () => {
  const VALUE = token('compat.isolation');
  const a = createApplication({ config: { name: 'a' }, modules: [defineModule({ name: 'a', providers: [{ provide: VALUE, useValue: 'a' }] })] });
  const b = createApplication({ config: { name: 'b' }, modules: [defineModule({ name: 'b', providers: [{ provide: VALUE, useValue: 'b' }] })] });
  await Promise.all([a.start(), b.start()]);
  assert.equal(await a.resolve(VALUE), 'a'); assert.equal(await b.resolve(VALUE), 'b');
  await Promise.all([a.stop(), b.stop()]);
});

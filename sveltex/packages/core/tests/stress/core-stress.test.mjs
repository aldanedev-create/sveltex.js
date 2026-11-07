import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, ProviderRegistry, createApplication, defineModule, token } from '../../dist/index.js';

test('stress: resolves 1,000 concurrent singleton requests with one factory execution', async () => {
  const registry = new ProviderRegistry(); const KEY = token('stress.singleton'); let calls = 0;
  registry.register({ provide: KEY, useFactory: async () => { calls++; await new Promise((resolve) => setImmediate(resolve)); return Object.freeze({ value: 42 }); } });
  const container = new Container(registry);
  const values = await Promise.all(Array.from({ length: 1_000 }, () => container.resolve(KEY)));
  assert.equal(calls, 1);
  assert.ok(values.every((value) => value === values[0]));
  await container.dispose();
});

test('stress: isolates 250 concurrent request scopes and cleans each one', async () => {
  const registry = new ProviderRegistry(); const KEY = token('stress.request'); let created = 0; let disposed = 0;
  registry.register({ provide: KEY, scope: 'request', useFactory: () => ({ id: ++created, dispose: () => { disposed++; } }) });
  const root = new Container(registry);
  const scopes = Array.from({ length: 250 }, () => root.createRequestScope());
  const values = await Promise.all(scopes.map((scope) => scope.resolve(KEY)));
  assert.equal(new Set(values.map((value) => value.id)).size, 250);
  await Promise.all(scopes.map((scope) => scope.dispose()));
  assert.equal(created, 250); assert.equal(disposed, 250);
  await root.dispose();
});

test('stress: handles 500 modules and deterministic dependency ordering', async () => {
  const modules = [defineModule({ name: 'm0' })];
  for (let i = 1; i < 500; i++) modules.push(defineModule({ name: `m${i}`, dependencies: [`m${i - 1}`] }));
  const app = createApplication({ config: { name: 'stress-modules' }, modules: modules.reverse() });
  await app.start();
  assert.equal(app.orderedModules[0].name, 'm0');
  assert.equal(app.orderedModules.at(-1).name, 'm499');
  await app.stop();
});

test('stress: repeated application start/stop cycles leave no shared state', async () => {
  let started = 0; let stopped = 0;
  for (let i = 0; i < 100; i++) {
    const app = createApplication({ config: { name: `cycle-${i}` }, modules: [defineModule({ name: 'module', onStart: () => started++, onStop: () => stopped++ })] });
    await app.start(); await app.stop();
  }
  assert.equal(started, 100); assert.equal(stopped, 100);
});

test('stress: resolves a 100-provider dependency chain', async () => {
  const registry = new ProviderRegistry(); const tokens = Array.from({ length: 100 }, (_, i) => token(`stress.chain.${i}`));
  registry.register({ provide: tokens[0], useValue: 1 });
  for (let i = 1; i < tokens.length; i++) {
    const previous = tokens[i - 1];
    registry.register({ provide: tokens[i], useFactory: async ({ resolve }) => (await resolve(previous)) + 1 });
  }
  const container = new Container(registry);
  assert.equal(await container.resolve(tokens.at(-1)), 100);
  await container.dispose();
});

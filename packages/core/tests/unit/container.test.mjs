import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, ProviderRegistry, token } from '../../dist/index.js';

const setup = () => ({ registry: new ProviderRegistry(), container: null });

test('transient providers create a fresh value for every resolution', async () => {
  const { registry } = setup(); const KEY = token('transient'); let id = 0;
  registry.register({ provide: KEY, scope: 'transient', useFactory: () => ({ id: ++id }) });
  const container = new Container(registry);
  assert.notEqual(await container.resolve(KEY), await container.resolve(KEY));
  assert.equal(id, 2);
  await container.dispose();
});

test('request providers are cached within one request scope', async () => {
  const { registry } = setup(); const KEY = token('request-cache'); let calls = 0;
  registry.register({ provide: KEY, scope: 'request', useFactory: () => ({ id: ++calls }) });
  const root = new Container(registry); const request = root.createRequestScope();
  assert.equal(await request.resolve(KEY), await request.resolve(KEY));
  assert.equal(calls, 1);
  await root.dispose();
});

test('transient dependencies are not cached', async () => {
  const { registry } = setup(); const KEY = token('transient-dep'); const PARENT = token('transient-parent'); let calls = 0;
  registry.register({ provide: KEY, scope: 'transient', useFactory: () => ++calls });
  registry.register({ provide: PARENT, scope: 'transient', useFactory: async ({ resolve }) => [await resolve(KEY), await resolve(KEY)] });
  const container = new Container(registry);
  assert.deepEqual(await container.resolve(PARENT), [1, 2]);
  await container.dispose();
});

test('missing providers return a stable typed error', async () => {
  const container = new Container();
  await assert.rejects(container.resolve(token('missing')), { code: 'SX_PROVIDER_NOT_FOUND' });
  await container.dispose();
});

test('rejects all invalid provider construction strategies', () => {
  const registry = new ProviderRegistry();
  for (const provider of [
    {}, { provide: 'x' }, { provide: 'x', useValue: 1, useFactory: () => 1 },
    { provide: 'x', useFactory: 1 }, { provide: 'x', useClass: 1 },
    { provide: 'x', useValue: 1, scope: 'request' }, { provide: 'x', useFactory: () => 1, scope: 'invalid' },
    { provide: 'x', useClass: class {}, inject: [null] },
  ]) assert.throws(() => registry.register(provider), { code: 'SX_PROVIDER_INVALID' });
});

test('factory resolution context is frozen and resolves declared dependencies', async () => {
  const registry = new ProviderRegistry(); const DEP = token('factory-dep'); const KEY = token('factory-key');
  registry.register({ provide: DEP, useValue: 9 });
  registry.register({ provide: KEY, useFactory: async (context) => { assert.equal(Object.isFrozen(context), true); return (await context.resolve(DEP)) * 2; } });
  const container = new Container(registry);
  assert.equal(await container.resolve(KEY), 18);
  await container.dispose();
});

test('disposes transient instances in reverse creation order', async () => {
  const registry = new ProviderRegistry(); const KEY = token('transient-disposal'); const order = [];
  let created = 0;
  registry.register({ provide: KEY, scope: 'transient', useFactory: () => { const id = ++created; return { dispose: () => order.push(id) }; } });
  const container = new Container(registry);
  await container.resolve(KEY); await container.resolve(KEY); await container.resolve(KEY);
  await container.dispose();
  assert.deepEqual(order, [1, 2, 3].reverse());
});

test('root cannot be used after disposal', async () => {
  const container = new Container(); await container.dispose();
  await assert.rejects(container.resolve('anything'), { code: 'SX_APP_INVALID_STATE' });
  assert.throws(() => container.createRequestScope(), { code: 'SX_APP_INVALID_STATE' });
});

test('request scope cannot be used after disposal', async () => {
  const root = new Container(); const request = root.createRequestScope();
  await request.dispose();
  await assert.rejects(request.resolve('anything'), { code: 'SX_APP_INVALID_STATE' });
  await root.dispose();
});

test('request scope cleanup does not dispose root singletons', async () => {
  const registry = new ProviderRegistry(); const SINGLE = token('singleton-lifetime'); let disposed = 0;
  registry.register({ provide: SINGLE, useFactory: () => ({ dispose: () => disposed++ }) });
  const root = new Container(registry); const request = root.createRequestScope();
  await request.resolve(SINGLE); await request.dispose();
  assert.equal(disposed, 0);
  await root.dispose(); assert.equal(disposed, 1);
});

test('disposes factory-produced resources exactly once', async () => {
  const registry = new ProviderRegistry(); const KEY = token('once-dispose'); let count = 0;
  registry.register({ provide: KEY, useFactory: () => ({ dispose: () => count++ }) });
  const container = new Container(registry); await container.resolve(KEY);
  await Promise.all([container.dispose(), container.dispose(), container.dispose()]);
  assert.equal(count, 1);
});

test('handles non-Error thrown values without losing cleanup', async () => {
  const registry = new ProviderRegistry(); const KEY = token('non-error'); let disposed = false;
  registry.register({ provide: KEY, useValue: { dispose: () => { disposed = true; throw 'bad cleanup'; } } });
  const container = new Container(registry); await container.resolve(KEY);
  await assert.rejects(container.dispose(), AggregateError);
  assert.equal(disposed, true);
});

test('independent root containers do not share singleton instances', async () => {
  const registryA = new ProviderRegistry(); const registryB = new ProviderRegistry(); const KEY = token('root-isolation');
  registryA.register({ provide: KEY, useFactory: () => ({}) }); registryB.register({ provide: KEY, useFactory: () => ({}) });
  const a = new Container(registryA); const b = new Container(registryB);
  assert.notEqual(await a.resolve(KEY), await b.resolve(KEY));
  await Promise.all([a.dispose(), b.dispose()]);
});

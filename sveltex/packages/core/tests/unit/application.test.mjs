import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, defineModule, token } from '../../dist/index.js';

const config = { name: 'application-tests', environment: 'test' };

test('application starts only once when start is called repeatedly', async () => {
  let starts = 0;
  const app = createApplication({ config, modules: [defineModule({ name: 'module', onStart: () => starts++ })] });
  const [a, b, c] = await Promise.all([app.start(), app.start(), app.start()]);
  assert.equal(a, app); assert.equal(b, app); assert.equal(c, app);
  assert.equal(starts, 1);
  await app.stop();
});

test('rejects module registration after startup begins', async () => {
  let release;
  const app = createApplication({ config, modules: [defineModule({ name: 'slow', onStart: () => new Promise((resolve) => { release = resolve; }) })] });
  const starting = app.start();
  assert.throws(() => app.registerModule(defineModule({ name: 'late' })), { code: 'SX_APP_INVALID_STATE' });
  release(); await starting; await app.stop();
});

test('rejects service resolution before start and after stop', async () => {
  const KEY = token('app-state-service');
  const app = createApplication({ config, modules: [defineModule({ name: 'services', providers: [{ provide: KEY, useValue: 1 }] })] });
  await assert.rejects(app.resolve(KEY), { code: 'SX_APP_INVALID_STATE' });
  await app.start(); await app.stop();
  await assert.rejects(app.resolve(KEY), { code: 'SX_APP_INVALID_STATE' });
  assert.throws(() => app.createRequestScope(), { code: 'SX_APP_INVALID_STATE' });
});

test('stopping an application that was never started is safe and idempotent', async () => {
  const app = createApplication({ config });
  await Promise.all([app.stop(), app.stop()]);
  assert.equal(app.state, 'stopped');
});

test('module hooks receive immutable context with app configuration', async () => {
  let context;
  const app = createApplication({ config, modules: [defineModule({ name: 'ctx', onStart: (value) => { context = value; } })] });
  await app.start();
  assert.equal(context.moduleName, 'ctx');
  assert.equal(context.config.name, config.name);
  assert.equal(Object.isFrozen(context), true);
  await app.stop();
});

test('startup failure preserves the original thrown value when rollback succeeds', async () => {
  const sentinel = new Error('start failed');
  const app = createApplication({ config, modules: [defineModule({ name: 'broken', onStart: () => { throw sentinel; } })] });
  await assert.rejects(app.start(), (error) => error === sentinel);
  assert.equal(app.state, 'failed');
});

test('startup failure aggregates rollback failures and still attempts all rollback hooks', async () => {
  const calls = [];
  const app = createApplication({ config, modules: [
    defineModule({ name: 'a', onStart: () => {}, onStop: () => calls.push('a') }),
    defineModule({ name: 'b', dependencies: ['a'], onStart: () => { throw new Error('start'); }, onStop: () => { calls.push('b'); throw new Error('rollback'); } }),
  ] });
  await assert.rejects(app.start(), AggregateError);
  assert.deepEqual(calls, ['b', 'a']);
});

test('request scopes from one application remain isolated', async () => {
  const REQUEST = token('app-request-value'); let id = 0;
  const app = createApplication({ config, modules: [defineModule({ name: 'request', providers: [{ provide: REQUEST, scope: 'request', useFactory: () => ({ id: ++id }) }] })] });
  await app.start();
  const first = app.createRequestScope(); const second = app.createRequestScope();
  const a = await first.resolve(REQUEST); const b = await second.resolve(REQUEST);
  assert.notEqual(a.id, b.id);
  await Promise.all([first.dispose(), second.dispose()]);
  await app.stop();
});

test('module stop hooks execute even if an earlier stop hook fails', async () => {
  const calls = [];
  const app = createApplication({ config, modules: [
    defineModule({ name: 'a', onStart: () => {}, onStop: () => calls.push('a') }),
    defineModule({ name: 'b', onStart: () => {}, onStop: () => { calls.push('b'); throw new Error('b stop'); } }),
    defineModule({ name: 'c', onStart: () => {}, onStop: () => calls.push('c') }),
  ] });
  await app.start(); await assert.rejects(app.stop(), AggregateError);
  assert.deepEqual(calls, ['c', 'b', 'a']);
  assert.equal(app.state, 'stopped');
});

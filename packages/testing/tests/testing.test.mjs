import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeClock,
  LifecycleRecorder,
  TestApplication,
  createTestApplication,
  withTestApplication,
  createRequestFixture,
  defineTestModule,
  testToken,
  createValueProvider,
  createFactoryProvider,
  createClassProvider,
  FakeKeyValueAdapter,
  FakeMessageTransport,
  TestSetupError,
} from '../dist/index.js';

test('FakeClock is deterministic and does not advance on its own', () => {
  const clock = new FakeClock(1000);
  assert.equal(clock.now(), 1000);
  assert.equal(clock.now(), 1000);
  assert.equal(clock.advance(50), 1050);
  clock.set(2000);
  assert.equal(clock.now(), 2000);
  clock.reset();
  assert.equal(clock.now(), 1000);
  assert.throws(() => clock.advance(-1), { name: 'TestSetupError' });
  assert.throws(() => new FakeClock(NaN), { name: 'TestSetupError' });
  assert.throws(() => clock.set(Infinity), { name: 'TestSetupError' });
});

test('LifecycleRecorder stamps deterministic times and exposes phase/label views', () => {
  const clock = new FakeClock(5);
  const recorder = new LifecycleRecorder(() => clock.now());
  recorder.record('start', 'a');
  clock.advance(10);
  recorder.record('stop', 'b');
  assert.deepEqual(recorder.phases(), ['start', 'stop']);
  assert.deepEqual(recorder.labels(), ['a', 'b']);
  assert.deepEqual(recorder.events.map((e) => e.at), [5, 15]);
  assert.ok(Object.isFrozen(recorder.events));
  recorder.clear();
  assert.equal(recorder.events.length, 0);
});

test('testToken creates stable, namespaced symbols', () => {
  const a = testToken('widget');
  const b = testToken('widget');
  const c = testToken('other');
  assert.equal(typeof a, 'symbol');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('provider helpers produce valid providers for the real core registry', async () => {
  const VALUE = testToken('helper.value');
  const app = createTestApplication({
    modules: [defineTestModule({
      name: 'helpers',
      providers: [createValueProvider(VALUE, 42)],
      exports: [VALUE],
    })],
  });
  await app.start();
  assert.equal(await app.resolve(VALUE), 42);
  await app.stop();
});

test('createTestApplication drives the REAL core state machine created -> running -> stopped', async () => {
  const app = createTestApplication({ config: { name: 'audit-app' } });
  assert.ok(app.app instanceof Object);
  assert.equal(app.state, 'created');
  assert.equal(app.config.name, 'audit-app');
  assert.equal(app.config.environment, 'test');
  assert.ok(Object.isFrozen(app.config));
  const returned = await app.start();
  assert.equal(returned, app);
  assert.equal(app.state, 'running');
  await app.stop();
  assert.equal(app.state, 'stopped');
});

test('singleton and transient scopes use the real core container semantics', async () => {
  const SINGLETON = testToken('scope.singleton');
  const TRANSIENT = testToken('scope.transient');
  let singletonCount = 0;
  let transientCount = 0;
  const app = createTestApplication({
    modules: [defineTestModule({
      name: 'scopes',
      providers: [
        createFactoryProvider(SINGLETON, () => ({ id: ++singletonCount })),
        createFactoryProvider(TRANSIENT, () => ({ id: ++transientCount }), 'transient'),
      ],
    })],
  });
  await app.start();
  const s1 = await app.resolve(SINGLETON);
  const s2 = await app.resolve(SINGLETON);
  assert.equal(s1, s2, 'singleton instance is cached');
  assert.equal(singletonCount, 1);
  const t1 = await app.resolve(TRANSIENT);
  const t2 = await app.resolve(TRANSIENT);
  assert.notEqual(t1, t2, 'transient yields a fresh instance');
  assert.equal(transientCount, 2);
  await app.stop();
});

test('request-scoped providers resolve only through a request fixture', async () => {
  const REQUEST = testToken('scope.request');
  const app = createTestApplication({
    modules: [defineTestModule({
      name: 'request',
      providers: [createFactoryProvider(REQUEST, () => ({ at: Date.now() }), 'request')],
    })],
  });
  await app.start();
  await assert.rejects(() => app.resolve(REQUEST), (err) => {
    assert.equal(err.code, 'SX_PROVIDER_SCOPE_VIOLATION');
    return true;
  });
  const fixture = app.fixture();
  const a = await fixture.resolve(REQUEST);
  assert.ok(a);
  await fixture.dispose();
  assert.equal(fixture.disposed, true);
  await fixture.dispose(); // idempotent
  await app.stop();
});

test('createClassProvider wires constructor injection through core', async () => {
  const DEP = testToken('class.dep');
  const SERVICE = testToken('class.service');
  class Service {
    constructor(prefix) { this.prefix = prefix; }
    greet(name) { return `${this.prefix} ${name}`; }
  }
  const app = createTestApplication({
    modules: [defineTestModule({
      name: 'classes',
      providers: [
        createValueProvider(DEP, 'Hello'),
        createClassProvider(SERVICE, Service, [DEP]),
      ],
    })],
  });
  await app.start();
  const service = await app.resolve(SERVICE);
  assert.equal(service.greet('Ada'), 'Hello Ada');
  await app.stop();
});

test('module lifecycle hooks run in start order and reverse stop order (real core)', async () => {
  const recorder = new LifecycleRecorder();
  const a = defineTestModule({ name: 'mod.a' }, recorder);
  const b = defineTestModule({ name: 'mod.b', dependencies: ['mod.a'] }, recorder);
  const app = createTestApplication({ modules: [a, b], recorder });
  await app.start();
  const startOrder = recorder.events.filter((e) => e.phase === 'module:start').map((e) => e.label);
  await app.stop();
  const stopOrder = recorder.events.filter((e) => e.phase === 'module:stop').map((e) => e.label);
  assert.deepEqual(startOrder, ['mod.a', 'mod.b']);
  assert.deepEqual(stopOrder, ['mod.b', 'mod.a'], 'onStop runs in reverse order');
  assert.ok(recorder.phases().includes('app:start'));
  assert.ok(recorder.phases().includes('app:stopped'));
});

test('disposables are cleaned up in reverse construction order on stop', async () => {
  const A = testToken('dispose.a');
  const B = testToken('dispose.b');
  const order = [];
  const app = createTestApplication({
    modules: [defineTestModule({
      name: 'disposables',
      providers: [
        createFactoryProvider(A, () => ({ dispose: () => { order.push('a'); } })),
        createFactoryProvider(B, () => ({ dispose: () => { order.push('b'); } })),
      ],
    })],
  });
  await app.start();
  await app.resolve(A);
  await app.resolve(B);
  await app.stop();
  assert.deepEqual(order, ['b', 'a']);
});

test('TestApplication.stop() disposes request scopes the caller forgot', async () => {
  const VALUE = testToken('cleanup.value');
  const app = createTestApplication({
    modules: [defineTestModule({ name: 'm', providers: [createValueProvider(VALUE, 1)] })],
  });
  await app.start();
  const scope = app.requestScope();
  assert.equal(await scope.resolve(VALUE), 1);
  assert.equal(scope.isDisposed, false);
  await app.stop();
  assert.equal(scope.isDisposed, true);
});

test('withTestApplication guarantees stop() even when the body throws', async () => {
  let seenState;
  await assert.rejects(
    () => withTestApplication(async (app) => {
      seenState = app.state;
      throw new Error('boom');
    }),
    { message: 'boom' },
  );
  assert.equal(seenState, 'running');
});

test('withTestApplication returns the body result after cleanup', async () => {
  const result = await withTestApplication(async (app) => {
    assert.equal(app.state, 'running');
    return 7;
  });
  assert.equal(result, 7);
});

test('createRequestFixture works with a running core Application directly', async () => {
  const VALUE = testToken('direct.value');
  const app = createTestApplication({
    modules: [defineTestModule({ name: 'm', providers: [createValueProvider(VALUE, 'v')] })],
  });
  await app.start();
  const fixture = createRequestFixture(app.app);
  assert.equal(await fixture.resolve(VALUE), 'v');
  await fixture.dispose();
  assert.equal(fixture.disposed, true);
  await app.stop();
});

test('defineTestModule validates its name', () => {
  assert.throws(() => defineTestModule({ name: '  ' }), { name: 'TestSetupError' });
  assert.ok(TestApplication && TestSetupError);
});

test('createTestApplication validates config through core (name is required)', () => {
  // Validation is delegated to the real core Application constructor (validateConfig).
  assert.throws(() => createTestApplication({ config: { name: '' } }), { code: 'SX_CONFIG_INVALID' });
  assert.throws(() => createTestApplication({ config: { name: 'ok', debug: 'yes' } }), { code: 'SX_CONFIG_INVALID' });
});

test('FakeKeyValueAdapter is a real, observable in-memory fake', async () => {
  const recorder = new LifecycleRecorder();
  const kv = new FakeKeyValueAdapter({ recorder });
  await kv.set('a', 1);
  assert.equal(await kv.get('a'), 1);
  assert.equal(await kv.has('a'), true);
  assert.equal(await kv.delete('a'), true);
  assert.equal(await kv.get('a'), undefined);
  assert.equal(kv.calls.length, 5);
  assert.deepEqual(kv.calls.map((c) => c.method), ['set', 'get', 'has', 'delete', 'get']);
  assert.equal(recorder.events.length, 5);
  assert.ok(Object.isFrozen(kv.calls));
  await kv.close();
});

test('FakeKeyValueAdapter.failNext throws exactly once then recovers', async () => {
  const kv = new FakeKeyValueAdapter();
  kv.failNext(new Error('down'));
  await assert.rejects(() => kv.set('x', 1), { message: 'down' });
  await kv.set('x', 2);
  assert.equal(await kv.get('x'), 2);
  const snap = kv.snapshot();
  assert.equal(snap.x, 2);
  assert.ok(Object.isFrozen(snap), 'snapshot is a frozen defensive copy');
});

test('FakeKeyValueAdapter rejects use after close', async () => {
  const kv = new FakeKeyValueAdapter();
  await kv.close();
  await assert.rejects(() => kv.set('x', 1), { name: 'TestSetupError' });
});

test('FakeMessageTransport records deliveries and supports injectable failure', async () => {
  const clock = new FakeClock(10);
  const transport = new FakeMessageTransport({ clock: () => clock.now() });
  await transport.send({ hello: 1 });
  clock.advance(5);
  await transport.send({ hello: 2 });
  assert.equal(transport.sent.length, 2);
  assert.deepEqual(transport.sent.map((m) => m.at), [10, 15]);
  transport.failNext(new Error('broker down'));
  await assert.rejects(() => transport.send({ hello: 3 }), { message: 'broker down' });
  await transport.send({ hello: 4 });
  assert.equal(transport.sent.length, 3);
  await transport.close();
  await assert.rejects(() => transport.send({ hello: 5 }), { name: 'TestSetupError' });
});

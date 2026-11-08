import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeClock,
  LifecycleRecorder,
  createTestApplication,
  withTestApplication,
  defineTestModule,
  testToken,
  createFactoryProvider,
  FakeKeyValueAdapter,
  FakeMessageTransport,
  TestSetupError,
} from '../../dist/index.js';

test('SEC: withTestApplication never leaks a running app when the body throws', async () => {
  let observed;
  await assert.rejects(
    () => withTestApplication(async (app) => {
      observed = app;
      throw new Error('boom');
    }),
    { message: 'boom' },
  );
  assert.equal(observed.state, 'stopped');
});

test('SEC: TestApplication.stop() disposes request scopes the caller forgot', async () => {
  const app = createTestApplication();
  await app.start();
  const scope = app.requestScope();
  assert.equal(scope.isDisposed, false);
  await app.stop();
  assert.equal(scope.isDisposed, true, 'a forgotten request scope must not outlive the app');
});

test('SEC: config validation is delegated to real core — invalid config is rejected', () => {
  // The helper does NOT bypass core validation by supplying its own defaults.
  assert.throws(() => createTestApplication({ config: { name: '' } }), { code: 'SX_CONFIG_INVALID' });
  assert.throws(() => createTestApplication({ config: { name: 'ok', debug: 'yes' } }), { code: 'SX_CONFIG_INVALID' });
});

test('SEC: defineTestModule rejects blank or non-string names before they reach the registry', () => {
  for (const bad of ['', '   ', undefined, null, 42]) {
    assert.throws(() => defineTestModule({ name: bad }), { name: 'TestSetupError' });
  }
});

test('SEC: testToken is namespaced and stable — no collision with production tokens', () => {
  const a = testToken('tenant.a');
  const b = testToken('tenant.a');
  const c = testToken('tenant.b');
  assert.equal(typeof a, 'symbol');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(Symbol.keyFor(a), '@sveltex/test.tenant.a');
  assert.notEqual(Symbol.keyFor(a), Symbol.keyFor(c));
});

test('SEC: request-scoped providers cannot be resolved from the root (real core enforcement)', async () => {
  const REQUEST = testToken('sec.request');
  const app = createTestApplication({
    modules: [defineTestModule({
      name: 'sec.scope',
      providers: [createFactoryProvider(REQUEST, () => ({ token: 'sensitive' }), 'request')],
    })],
  });
  await app.start();
  await assert.rejects(() => app.resolve(REQUEST), { code: 'SX_PROVIDER_SCOPE_VIOLATION' });
  await app.stop();
});

test('SEC: fakes expose frozen defensive snapshots that cannot mutate internal state', async () => {
  const kv = new FakeKeyValueAdapter();
  await kv.set('secret', 'value');
  const snap = kv.snapshot();
  assert.ok(Object.isFrozen(snap));
  assert.throws(() => { snap.secret = 'tampered'; }, TypeError);
  assert.equal(await kv.get('secret'), 'value');

  const transport = new FakeMessageTransport();
  await transport.send({ m: 1 });
  const sent = transport.sent;
  assert.ok(Object.isFrozen(sent));
  assert.ok(Object.isFrozen(sent[0]));
  assert.throws(() => { sent[0].at = 9; }, TypeError);
});

test('SEC: closed fakes reject all further use rather than silently no-op', async () => {
  const kv = new FakeKeyValueAdapter();
  await kv.close();
  await assert.rejects(() => kv.set('x', 1), { name: 'TestSetupError' });
  await assert.rejects(() => kv.delete('x'), { name: 'TestSetupError' });
  await assert.rejects(() => kv.get('x'), { name: 'TestSetupError' });

  const transport = new FakeMessageTransport();
  await transport.close();
  await assert.rejects(() => transport.send(1), { name: 'TestSetupError' });
});

test('SEC: lifecycle hook failures are surfaced, never silently swallowed', async () => {
  const app = createTestApplication({
    modules: [defineTestModule({
      name: 'sec.hook',
      onStop: () => { throw new Error('cleanup failed'); },
    })],
  });
  await app.start();
  await assert.rejects(() => app.stop(), (err) => {
    assert.equal(err.name, 'SvelteXAggregateError');
    assert.ok(err.causes.some((e) => e.message === 'cleanup failed'));
    return true;
  });
});

test('SEC: FakeClock rejects non-finite input so determinism cannot be broken', () => {
  const clock = new FakeClock();
  for (const bad of [NaN, Infinity, -Infinity, '5']) {
    assert.throws(() => new FakeClock(bad), { name: 'TestSetupError' });
    assert.throws(() => clock.advance(bad), { name: 'TestSetupError' });
    assert.throws(() => clock.set(bad), { name: 'TestSetupError' });
  }
  // The constructor's default parameter legitimately treats a *missing* argument as 0;
  // explicit undefined/null are still rejected by advance()/set().
  for (const bad of [undefined, null]) {
    assert.throws(() => clock.advance(bad), { name: 'TestSetupError' });
    assert.throws(() => clock.set(bad), { name: 'TestSetupError' });
  }
  assert.throws(() => clock.advance(-1), { name: 'TestSetupError' });
  assert.equal(clock.now(), 0, 'no rejected call may have moved the clock');
});

test('SEC: recorder observations are frozen — test evidence cannot be mutated', () => {
  const recorder = new LifecycleRecorder();
  recorder.record('phase', 'label');
  const events = recorder.events;
  assert.ok(Object.isFrozen(events));
  assert.ok(Object.isFrozen(events[0]));
  assert.throws(() => { events[0].phase = 'tampered'; }, TypeError);
});

test('SEC: fakes are explicitly in-memory — close clears state and blocks later operations', async () => {
  const recorder = new LifecycleRecorder();
  const kv = new FakeKeyValueAdapter({ recorder });
  const transport = new FakeMessageTransport({ recorder });
  await kv.set('a', 1);
  await transport.send('m');
  assert.deepEqual(recorder.labels(), ['FakeKeyValueAdapter', 'FakeMessageTransport']);
  assert.equal(kv.size, 1);
  await kv.close();
  await transport.close();
  assert.equal(kv.size, 0, 'close clears in-memory state');
  assert.equal(transport.isClosed, true);
  await assert.rejects(() => kv.get('a'), { name: 'TestSetupError' });
  assert.ok(TestSetupError.prototype instanceof Error);
});

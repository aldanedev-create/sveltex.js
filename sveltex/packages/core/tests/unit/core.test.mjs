import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Application, createApplication, defineModule, token, Container, ProviderRegistry,
  orderModules, SvelteXError,
} from '../../dist/index.js';

const config = { name: 'test-app', environment: 'test' };

test('validates configuration at construction', () => {
  assert.throws(() => createApplication({ config: { name: '  ' } }), (error) => error.code === 'SX_CONFIG_INVALID');
});

test('orders modules dependency-first and deterministically', () => {
  const a = defineModule({ name: 'a' });
  const b = defineModule({ name: 'b', dependencies: ['a'] });
  const c = defineModule({ name: 'c', dependencies: ['a'] });
  assert.deepEqual(orderModules([b, c, a]).map((m) => m.name), ['a', 'b', 'c']);
});

test('detects missing dependencies and cycles', () => {
  assert.throws(() => orderModules([defineModule({ name: 'a', dependencies: ['missing'] })]), (e) => e.code === 'SX_MODULE_MISSING_DEPENDENCY');
  const a = defineModule({ name: 'a', dependencies: ['b'] });
  const b = defineModule({ name: 'b', dependencies: ['a'] });
  assert.throws(() => orderModules([a, b]), (e) => e.code === 'SX_MODULE_CYCLE');
});

test('singleton factory is shared across concurrent resolutions', async () => {
  const KEY = token('test.singleton');
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register({ provide: KEY, useFactory: async () => { calls++; await Promise.resolve(); return { calls }; } });
  const container = new Container(registry);
  const [a, b] = await Promise.all([container.resolve(KEY), container.resolve(KEY)]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  await container.dispose();
});

test('request providers are isolated and cannot resolve from root', async () => {
  const KEY = token('test.request');
  let next = 0;
  const registry = new ProviderRegistry();
  registry.register({ provide: KEY, scope: 'request', useFactory: () => ({ id: ++next }) });
  const root = new Container(registry);
  await assert.rejects(root.resolve(KEY), (e) => e.code === 'SX_PROVIDER_SCOPE_VIOLATION');
  const first = root.createRequestScope();
  const second = root.createRequestScope();
  assert.notEqual(await first.resolve(KEY), await second.resolve(KEY));
  await Promise.all([first.dispose(), second.dispose(), root.dispose()]);
});

test('detects dependency injection cycles', async () => {
  const A = token('cycle.a'); const B = token('cycle.b');
  const registry = new ProviderRegistry();
  registry.register({ provide: A, useFactory: ({ resolve }) => resolve(B) });
  registry.register({ provide: B, useFactory: ({ resolve }) => resolve(A) });
  const container = new Container(registry);
  await assert.rejects(container.resolve(A), (e) => e.code === 'SX_DI_CYCLE');
});

test('starts dependency-first and stops in reverse order', async () => {
  const events = [];
  const app = new Application({ config, modules: [
    defineModule({ name: 'web', dependencies: ['database'], onStart: () => events.push('start:web'), onStop: () => events.push('stop:web') }),
    defineModule({ name: 'database', onStart: () => events.push('start:database'), onStop: () => events.push('stop:database') }),
  ] });
  await app.start();
  assert.deepEqual(events, ['start:database', 'start:web']);
  await Promise.all([app.stop(), app.stop()]);
  assert.deepEqual(events, ['start:database', 'start:web', 'stop:web', 'stop:database']);
  assert.equal(app.state, 'stopped');
});

test('rolls back initialized modules after startup failure', async () => {
  const events = [];
  const app = createApplication({ config, modules: [
    defineModule({ name: 'a', onStart: () => events.push('start:a'), onStop: () => events.push('stop:a') }),
    defineModule({ name: 'b', dependencies: ['a'], onStart: () => { events.push('start:b'); throw new Error('boom'); }, onStop: () => events.push('stop:b') }),
  ] });
  await assert.rejects(app.start(), /boom/);
  assert.deepEqual(events, ['start:a', 'start:b', 'stop:b', 'stop:a']);
  assert.equal(app.state, 'failed');
});

test('attempts every cleanup even when one fails', async () => {
  const events = [];
  const app = createApplication({ config, modules: [
    defineModule({ name: 'a', onStart: () => {}, onStop: () => { events.push('a'); throw new Error('cleanup'); } }),
    defineModule({ name: 'b', onStart: () => {}, onStop: () => events.push('b') }),
  ] });
  await app.start();
  await assert.rejects(app.stop(), AggregateError);
  assert.deepEqual(events, ['b', 'a']);
  assert.equal(app.state, 'stopped');
});

test('request scope is unavailable before startup', () => {
  const app = createApplication({ config });
  assert.throws(() => app.createRequestScope(), SvelteXError);
});

test('retries a singleton after its factory fails', async () => {
  const KEY = token('test.retry');
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register({ provide: KEY, useFactory: () => { calls++; if (calls === 1) throw new Error('temporary'); return 42; } });
  const container = new Container(registry);
  await assert.rejects(container.resolve(KEY), /temporary/);
  assert.equal(await container.resolve(KEY), 42);
  assert.equal(calls, 2);
  await container.dispose();
});

test('waits for in-flight factories before disposing their instances', async () => {
  const KEY = token('test.pending-disposal');
  let release;
  const disposed = [];
  const registry = new ProviderRegistry();
  registry.register({ provide: KEY, useFactory: () => new Promise((resolve) => { release = () => resolve({ dispose: () => disposed.push('done') }); }) });
  const container = new Container(registry);
  const resolving = container.resolve(KEY);
  await Promise.resolve();
  const stopping = container.dispose();
  release();
  await Promise.all([resolving, stopping]);
  assert.deepEqual(disposed, ['done']);
});

test('root disposal closes outstanding request scopes', async () => {
  const KEY = token('test.request-cleanup');
  const disposed = [];
  const registry = new ProviderRegistry();
  registry.register({ provide: KEY, scope: 'request', useFactory: () => ({ dispose: () => disposed.push('request') }) });
  const root = new Container(registry);
  const request = root.createRequestScope();
  await request.resolve(KEY);
  await root.dispose();
  assert.equal(request.isDisposed, true);
  assert.deepEqual(disposed, ['request']);
});

test('disposes singleton value providers and rejects non-singleton value scope', async () => {
  const KEY = token('test.value-disposal');
  const disposed = [];
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register({ provide: KEY, scope: 'transient', useValue: {} }), (e) => e.code === 'SX_PROVIDER_INVALID');
  registry.register({ provide: KEY, useValue: { dispose: () => disposed.push('value') } });
  const container = new Container(registry);
  await container.resolve(KEY);
  await container.dispose();
  assert.deepEqual(disposed, ['value']);
});

test('rejects duplicate provider tokens and duplicate modules', () => {
  const KEY = token('test.duplicate');
  const registry = new ProviderRegistry();
  registry.register({ provide: KEY, useValue: 1 });
  assert.throws(() => registry.register({ provide: KEY, useValue: 2 }), (e) => e.code === 'SX_PROVIDER_DUPLICATE');
  const app = createApplication({ config, modules: [defineModule({ name: 'one' })] });
  assert.throws(() => app.registerModule(defineModule({ name: 'one' })), (e) => e.code === 'SX_MODULE_DUPLICATE');
});

test('concurrent container disposal callers await the same cleanup', async () => {
  const KEY = token('test.concurrent-dispose');
  let release;
  const registry = new ProviderRegistry();
  registry.register({ provide: KEY, useValue: { dispose: () => new Promise((resolve) => { release = resolve; }) } });
  const container = new Container(registry);
  await container.resolve(KEY);
  let finished = false;
  const first = container.dispose().then(() => { finished = true; });
  const second = container.dispose();
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await Promise.all([first, second]);
  assert.equal(finished, true);
});

test('concurrent stop calls during startup share shutdown', async () => {
  let release;
  const events = [];
  const app = createApplication({ config, modules: [defineModule({
    name: 'slow-start',
    onStart: () => new Promise((resolve) => { release = () => { events.push('started'); resolve(); }; }),
    onStop: () => events.push('stopped'),
  })] });
  const starting = app.start();
  const firstStop = app.stop();
  const secondStop = app.stop();
  release();
  await Promise.all([starting, firstStop, secondStop]);
  assert.deepEqual(events, ['started', 'stopped']);
  assert.equal(app.state, 'stopped');
});

test('constructs classes using explicit injection tokens', async () => {
  const DEP = token('test.class-dependency');
  const SERVICE = token('test.class-service');
  class Dependency { value() { return 'ready'; } }
  class Service { constructor(dependency) { this.dependency = dependency; } }
  const registry = new ProviderRegistry();
  registry.register({ provide: DEP, useClass: Dependency });
  registry.register({ provide: SERVICE, useClass: Service, inject: [DEP] });
  const container = new Container(registry);
  const service = await container.resolve(SERVICE);
  assert.equal(service.dependency.value(), 'ready');
  await container.dispose();
});

test('locks the provider registry when its container is sealed', () => {
  const registry = new ProviderRegistry();
  const container = new Container(registry);
  container.seal();
  assert.throws(() => registry.register({ provide: token('test.after-seal'), useValue: true }), (e) => e.code === 'SX_APP_INVALID_STATE');
});

test('freezes module provider definitions and injection arrays', () => {
  const KEY = token('test.frozen-provider');
  const dependency = token('test.frozen-dependency');
  const provider = { provide: KEY, useClass: class Example {}, inject: [dependency] };
  const module = defineModule({ name: 'frozen', providers: [provider] });
  assert.equal(Object.isFrozen(module.providers), true);
  assert.equal(Object.isFrozen(module.providers[0]), true);
  assert.equal(Object.isFrozen(module.providers[0].inject), true);
});

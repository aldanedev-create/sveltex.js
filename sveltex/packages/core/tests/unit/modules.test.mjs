import test from 'node:test';
import assert from 'node:assert/strict';
import { defineModule, orderModules, createApplication, token } from '../../dist/index.js';

test('normalizes module names and freezes descriptor collections', () => {
  const providers = [{ provide: 'x', useValue: 1 }];
  const module = defineModule({ name: '  api  ', dependencies: ['db'], providers, exports: ['x'] });
  assert.equal(module.name, 'api');
  assert.equal(Object.isFrozen(module.dependencies), true);
  assert.equal(Object.isFrozen(module.providers), true);
  assert.equal(Object.isFrozen(module.exports), true);
  assert.notEqual(module.providers, providers);
});

test('rejects malformed module descriptors', () => {
  const invalid = [null, {}, { name: '' }, { name: 'x', dependencies: [''] }, { name: 'x', dependencies: ['a', 'a'] }, { name: 'x', onStart: true }, { name: 'x', onStop: 1 }, { name: 'x', providers: [null] }, { name: 'x', exports: [null] }];
  for (const descriptor of invalid) assert.throws(() => defineModule(descriptor), { code: 'SX_MODULE_INVALID' });
});

test('detects direct self-dependency', () => {
  assert.throws(() => orderModules([defineModule({ name: 'self', dependencies: ['self'] })]), { code: 'SX_MODULE_CYCLE' });
});

test('detects longer cycles and reports the cycle path', () => {
  const modules = [
    defineModule({ name: 'a', dependencies: ['c'] }),
    defineModule({ name: 'b', dependencies: ['a'] }),
    defineModule({ name: 'c', dependencies: ['b'] }),
  ];
  assert.throws(() => orderModules(modules), (error) => error.code === 'SX_MODULE_CYCLE' && Array.isArray(error.details.cycle));
});

test('orders disconnected modules in registration order', () => {
  const result = orderModules(['z', 'a', 'm'].map((name) => defineModule({ name })));
  assert.deepEqual(result.map((module) => module.name), ['z', 'a', 'm']);
});

test('orders a deep dependency chain correctly', () => {
  const modules = [defineModule({ name: 'leaf' })];
  for (let i = 1; i <= 100; i++) modules.push(defineModule({ name: `m${i}`, dependencies: [i === 1 ? 'leaf' : `m${i - 1}`] }));
  const ordered = orderModules(modules.reverse());
  assert.equal(ordered[0].name, 'leaf');
  assert.equal(ordered.at(-1).name, 'm100');
});

test('module provider exports must refer to providers owned by that module', async () => {
  const app = createApplication({ config: { name: 'bad-export' }, modules: [defineModule({ name: 'api', exports: ['missing'] })] });
  await assert.rejects(app.start(), { code: 'SX_MODULE_INVALID' });
});

test('providers from modules are resolvable after startup', async () => {
  const SERVICE = token('module.service');
  const app = createApplication({ config: { name: 'module-app' }, modules: [defineModule({ name: 'services', providers: [{ provide: SERVICE, useValue: { ok: true } }] })] });
  await app.start();
  assert.deepEqual(await app.resolve(SERVICE), { ok: true });
  await app.stop();
});

test('rejects duplicate providers across modules before running lifecycle hooks', async () => {
  const events = [];
  const app = createApplication({ config: { name: 'duplicates' }, modules: [
    defineModule({ name: 'a', providers: [{ provide: 'same', useValue: 1 }], onStart: () => events.push('a') }),
    defineModule({ name: 'b', providers: [{ provide: 'same', useValue: 2 }], onStart: () => events.push('b') }),
  ] });
  await assert.rejects(app.start(), { code: 'SX_PROVIDER_DUPLICATE' });
  assert.deepEqual(events, []);
});

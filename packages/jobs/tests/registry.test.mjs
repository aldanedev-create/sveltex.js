import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRegistry } from '../dist/registry.js';
import { JobsConfigurationError, JobsError } from '../dist/index.js';

const handlerA = () => {};
const handlerB = () => {};

test('registry: register / get / has / names / size', () => {
  const registry = new JobRegistry();
  assert.equal(registry.register('email.send', handlerA), registry);
  registry.register('report.build', handlerB);
  assert.equal(registry.size, 2);
  assert.equal(registry.has('email.send'), true);
  assert.equal(registry.has('missing'), false);
  assert.equal(registry.get('email.send'), handlerA);
  assert.deepEqual(registry.names(), ['email.send', 'report.build']);
  assert.equal(Object.isFrozen(registry.names()), true);
});

test('registry: registerAll registers every entry and rejects invalid names', () => {
  const registry = new JobRegistry();
  registry.registerAll({ 'a.one': handlerA, 'b.two': handlerB });
  assert.equal(registry.size, 2);
  assert.throws(() => registry.registerAll({ '../bad': handlerA }), { name: 'JobsValidationError' });
  assert.ok(JobsConfigurationError);
});

test('registry: duplicate names, invalid grammar and non-function handlers are rejected', () => {
  const registry = new JobRegistry();
  registry.register('email.send', handlerA);
  assert.throws(() => registry.register('email.send', handlerB), { name: 'JobsConfigurationError' });
  assert.throws(() => registry.register('bad name', handlerB), { name: 'JobsValidationError' });
  assert.throws(() => registry.register('ok', 'not-a-function'), { name: 'JobsConfigurationError' });
  assert.equal(registry.size, 1);
});

test('registry: createHandler routes by job.name and preserves the context', async () => {
  const seen = [];
  const registry = new JobRegistry();
  registry.register('email.send', (job, ctx) => { seen.push([job.name, ctx.attempts, job.payload]); });
  const handler = registry.createHandler();
  const context = Object.freeze({ attempts: 2, signal: new AbortController().signal });
  await handler({ name: 'email.send', payload: { to: 'a' } }, context);
  assert.deepEqual(seen, [['email.send', 2, { to: 'a' }]]);
});

test('registry: an unregistered job throws a typed JobsError (worker retry/dead-letter applies)', async () => {
  const registry = new JobRegistry();
  const handler = registry.createHandler();
  const context = Object.freeze({ attempts: 1, signal: new AbortController().signal });
  await assert.rejects(
    () => handler({ name: 'unknown.job', payload: 1 }, context),
    (error) => error instanceof JobsError && error.code === 'SX_JOBS_UNREGISTERED',
  );
});

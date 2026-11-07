import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getSvelteXContext, composeHandlers, HandlerPipeline, defineSvelteXKitConfig } from '../../dist/index.js';
import { makeApplication, makeEvent, SERVICE, resolveOk } from '../helpers.mjs';

test('starts app once, attaches context, and removes it after resolve', async () => {
  const app = makeApplication(); const handle = createSvelteXHandler(app); const event = makeEvent();
  const response = await handle({ event, resolve: async e => { assert.equal(app.state, 'running'); const ctx = getSvelteXContext(e.locals); assert.equal(await ctx.resolve(SERVICE) instanceof Object, true); return resolveOk(); } });
  assert.equal(response.status, 200); assert.equal(Object.hasOwn(event.locals, 'sveltex'), false);
  await app.stop();
});

test('disposes request scope when route resolution throws and preserves original error', async () => {
  let disposed = 0; const app = makeApplication({ dispose: () => { disposed++; } }); const handle = createSvelteXHandler(app); const event = makeEvent();
  const failure = new Error('route failed');
  await assert.rejects(handle({ event, resolve: async e => { await getSvelteXContext(e.locals).resolve(SERVICE); throw failure; } }), error => error === failure);
  assert.equal(disposed, 1); assert.equal(Object.hasOwn(event.locals, 'sveltex'), false); await app.stop();
});

test('does not overwrite an existing locals property', async () => {
  const app = makeApplication(); const handle = createSvelteXHandler(app); const event = makeEvent(); event.locals.sveltex = 'owned';
  await assert.rejects(handle({ event, resolve: resolveOk }), /already defined/); await app.stop();
});

test('supports a custom locals key and does not expose the property in enumeration', async () => {
  const app = makeApplication(); const event = makeEvent(); const handle = createSvelteXHandler(app, { localsKey: 'services' });
  await handle({ event, resolve: async e => { assert.ok(getSvelteXContext(e.locals, 'services')); assert.deepEqual(Object.keys(e.locals), []); return resolveOk(); } });
  await app.stop();
});

test('composes handlers in declared order', async () => {
  const order = []; const a = async ({ event, resolve }) => { order.push('a-in'); const r = await resolve(event); order.push('a-out'); return r; };
  const b = async ({ event, resolve }) => { order.push('b-in'); const r = await resolve(event); order.push('b-out'); return r; };
  const response = await composeHandlers(a, b)({ event: makeEvent(), resolve: async () => { order.push('route'); return resolveOk(); } });
  assert.equal(response.status, 200); assert.deepEqual(order, ['a-in', 'b-in', 'route', 'b-out', 'a-out']);
});

test('handler pipeline builds a composed handler', async () => {
  const pipeline = new HandlerPipeline(); let called = false; pipeline.use(async ({ event, resolve }) => { called = true; return resolve(event); });
  assert.equal(pipeline.size, 1); await pipeline.build()({ event: makeEvent(), resolve: resolveOk }); assert.equal(called, true);
});

test('validates and freezes adapter configuration', () => { const config = defineSvelteXKitConfig({ localsKey: 'services', autoStart: false }); assert.equal(Object.isFrozen(config), true); assert.throws(() => defineSvelteXKitConfig({ localsKey: ' ' }), /localsKey/); });


test('preserves the original route error when request disposal also fails', async () => {
  const routeError = { status: 303, location: '/login' };
  const app = makeApplication({ dispose: () => { throw new Error('cleanup failed'); } });
  const handle = createSvelteXHandler(app);
  await assert.rejects(handle({ event: makeEvent(), resolve: async e => { await getSvelteXContext(e.locals).resolve(SERVICE); throw routeError; } }), error => error === routeError);
  await app.stop();
});

test('passes resolve options through composed handles', async () => {
  const options = { transformPageChunk: { filter: () => true } };
  let received;
  const first = async ({ event, resolve }) => resolve(event, options);
  const second = async ({ event, resolve }) => resolve(event, options);
  await composeHandlers(first, second)({ event: makeEvent(), resolve: async (_event, actual) => { received = actual; return resolveOk(); } });
  assert.equal(received, options);
});

test('supports explicit application initialization when autoStart is disabled', async () => {
  const app = makeApplication(); const handle = createSvelteXHandler(app, { autoStart: false });
  await assert.rejects(handle({ event: makeEvent(), resolve: resolveOk }), /must be running/);
  await app.start();
  const response = await handle({ event: makeEvent(), resolve: resolveOk });
  assert.equal(response.status, 200); await app.stop();
});

test('calls onRequestDisposed after scope cleanup and locals removal', async () => {
  const app = makeApplication(); const event = makeEvent(); let callbackContext;
  const handle = createSvelteXHandler(app, { onRequestDisposed(context) { callbackContext = context; assert.equal('sveltex' in event.locals, false); } });
  await handle({ event, resolve: resolveOk });
  assert.equal(callbackContext.isDisposed, true); await app.stop();
});

test('composed handle rejects a second call to its next resolver', async () => {
  const twice = async ({ event, resolve }) => {
    await resolve(event);
    return resolve(event);
  };
  await assert.rejects(
    composeHandlers(twice)({ event: makeEvent(), resolve: resolveOk }),
    /more than once/
  );
});

test('composed handle can short-circuit without invoking later handlers', async () => {
  let laterCalled = false;
  const shortCircuit = async () => new Response('cached', { status: 200 });
  const later = async ({ event, resolve }) => { laterCalled = true; return resolve(event); };
  const response = await composeHandlers(shortCircuit, later)({ event: makeEvent(), resolve: resolveOk });
  assert.equal(await response.text(), 'cached');
  assert.equal(laterCalled, false);
});

test('composed handles can replace the event passed to the next handler', async () => {
  const replacement = makeEvent('/rewritten');
  let routeEvent;
  const rewrite = async ({ resolve }) => resolve(replacement);
  const response = await composeHandlers(rewrite)({
    event: makeEvent('/original'),
    resolve: async event => { routeEvent = event; return resolveOk(); }
  });
  assert.equal(response.status, 200);
  assert.equal(routeEvent.url.pathname, '/rewritten');
});

test('successful requests report cleanup failures instead of silently swallowing them', async () => {
  const app = makeApplication({ dispose: () => { throw new Error('dispose failed'); } });
  const handle = createSvelteXHandler(app);
  await assert.rejects(handle({
    event: makeEvent(),
    resolve: async event => {
      await getSvelteXContext(event.locals).resolve(SERVICE);
      return resolveOk();
    }
  }), error => error instanceof AggregateError && error.errors.some(item => /dispose failed/.test(item.message)));
  await app.stop();
});

test('cleanup observer failures do not replace route failures', async () => {
  const app = makeApplication();
  const routeError = { status: 302, location: '/signin' };
  const handle = createSvelteXHandler(app, { onRequestDisposed() { throw new Error('observer failed'); } });
  await assert.rejects(handle({ event: makeEvent(), resolve: async () => { throw routeError; } }), error => error === routeError);
  await app.stop();
});

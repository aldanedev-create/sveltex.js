import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getSvelteXContext, getRequestContext, setRequestContext, clearRequestContext } from '../../dist/index.js';
import { makeApplication, makeEvent, resolveOk } from '../helpers.mjs';

test('context captures immutable route params and request metadata', async () => {
  const app = makeApplication();
  const event = makeEvent('/users/42');
  event.params = { id: '42' };
  const handle = createSvelteXHandler(app);
  await handle({ event, resolve: async current => {
    const context = getSvelteXContext(current.locals);
    assert.equal(context.url.pathname, '/users/42');
    assert.equal(context.request, current.request);
    assert.equal(context.params.id, '42');
    assert.equal(Object.isFrozen(context.params), true);
    assert.throws(() => { context.params.id = 'other'; }, TypeError);
    assert.equal(typeof context.startedAt, 'number');
    return resolveOk();
  }});
  await app.stop();
});

test('context accessor rejects inherited and malformed values', () => {
  const inherited = Object.create({ sveltex: { resolve() {}, dispose() {} } });
  assert.throws(() => getRequestContext(inherited), /unavailable/);
  assert.throws(() => getRequestContext({ sveltex: { resolve: true, dispose: true } }), /not a valid/);
});

test('context cleanup only removes the context it installed', async () => {
  const event = makeEvent();
  const context = { resolve() {}, dispose() {}, application: {}, container: {}, request: event.request, url: event.url, params: {}, startedAt: 0, isDisposed: false };
  setRequestContext(event, context);
  Object.defineProperty(event.locals, 'sveltex', { configurable: true, value: 'replaced' });
  clearRequestContext(event, 'sveltex', context);
  assert.equal(event.locals.sveltex, 'replaced');
});

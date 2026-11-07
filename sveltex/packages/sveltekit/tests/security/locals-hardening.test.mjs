import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getSvelteXContext } from '../../dist/index.js';
import { makeApplication, makeEvent, resolveOk } from '../helpers.mjs';

test('does not trust inherited locals properties', async () => {
  const app = makeApplication();
  const event = makeEvent();
  event.locals = Object.create({ sveltex: 'attacker-controlled' });
  const handle = createSvelteXHandler(app);
  await handle({ event, resolve: async e => {
    assert.notEqual(getSvelteXContext(e.locals), 'attacker-controlled');
    return resolveOk();
  }});
  assert.equal(Object.hasOwn(event.locals, 'sveltex'), false);
  await app.stop();
});

test('rejects frozen locals without leaking an active request lease', async () => {
  const app = makeApplication();
  const event = makeEvent();
  event.locals = Object.freeze({});
  const handle = createSvelteXHandler(app);
  await assert.rejects(handle({ event, resolve: resolveOk }));
  await app.stop();
});

test('does not delete a locals value installed by another owner after attachment', async () => {
  const app = makeApplication();
  const event = makeEvent();
  const handle = createSvelteXHandler(app);
  await handle({ event, resolve: async e => {
    Object.defineProperty(e.locals, 'sveltex', { configurable: true, value: 'other-owner' });
    return resolveOk();
  }});
  assert.equal(event.locals.sveltex, 'other-owner');
  await app.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getSvelteXContext } from '../../dist/index.js';
import { makeApplication, makeEvent, SERVICE, resolveOk } from '../helpers.mjs';

test('request context is non-enumerable and removed after request', async () => {
  const app = makeApplication(); const event = makeEvent(); const handle = createSvelteXHandler(app);
  await handle({ event, resolve: async e => { assert.equal(Object.keys(e.locals).includes('sveltex'), false); assert.ok(getSvelteXContext(e.locals)); return resolveOk(); } });
  assert.equal('sveltex' in event.locals, false); await app.stop();
});

test('cannot resolve a request context after disposal', async () => {
  const app = makeApplication(); let saved; const handle = createSvelteXHandler(app);
  await handle({ event: makeEvent(), resolve: async e => { saved = getSvelteXContext(e.locals); await saved.resolve(SERVICE); return resolveOk(); } });
  await assert.rejects(saved.resolve(SERVICE), /disposed/); await app.stop();
});

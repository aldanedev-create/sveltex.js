import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getSvelteXContext } from '../../dist/index.js';
import { makeApplication, makeEvent, SERVICE, resolveOk } from '../helpers.mjs';

test('parallel requests receive distinct request-scoped instances', async () => {
  const app = makeApplication(); const handle = createSvelteXHandler(app); const seen = [];
  await Promise.all(Array.from({ length: 100 }, (_, i) => { const event = makeEvent(`/r/${i}`); return handle({ event, resolve: async e => { const context = getSvelteXContext(e.locals); const value = await context.resolve(SERVICE); seen.push(value); await new Promise(r => setTimeout(r, i % 4)); assert.equal(context.url.pathname, `/r/${i}`); return resolveOk(); } }); }));
  assert.equal(new Set(seen).size, 100); await app.stop();
});

test('concurrent first requests share one app startup', async () => {
  let starts = 0; const app = makeApplication(); const original = app.start.bind(app); app.start = async () => { starts++; await new Promise(r => setTimeout(r, 5)); return original(); };
  const handle = createSvelteXHandler(app);
  await Promise.all(Array.from({ length: 30 }, (_, i) => handle({ event: makeEvent(`/parallel/${i}`), resolve: resolveOk })));
  assert.equal(starts, 1); await app.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getSvelteXContext } from '../../dist/index.js';
import { makeApplication, makeEvent, SERVICE, resolveOk } from '../helpers.mjs';

test('handles a burst of 1000 requests without retaining request locals', async () => {
  const app = makeApplication(); const handle = createSvelteXHandler(app); let count = 0;
  await Promise.all(Array.from({ length: 1000 }, (_, i) => { const event = makeEvent(`/stress/${i}`); return handle({ event, resolve: async e => { await getSvelteXContext(e.locals).resolve(SERVICE); count++; return resolveOk(); } }).then(() => assert.equal('sveltex' in event.locals, false)); }));
  assert.equal(count, 1000); await app.stop();
});

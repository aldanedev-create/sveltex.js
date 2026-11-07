import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getSvelteXContext } from '../../dist/index.js';
import { makeApplication, makeEvent, SERVICE } from '../helpers.mjs';

test('adapter follows the SvelteKit Handle event/resolve contract', async () => {
  const app = makeApplication(); const event = makeEvent('/api/health?full=1'); const handle = createSvelteXHandler(app);
  const response = await handle({ event, resolve: async received => { assert.equal(received, event); assert.equal(received.request.method, 'GET'); assert.equal(getSvelteXContext(received.locals).url.pathname, '/api/health'); await getSvelteXContext(received.locals).resolve(SERVICE); return Response.json({ ok: true }); } });
  assert.deepEqual(await response.json(), { ok: true }); await app.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvelteXHandler, getActiveRequestCount, getSvelteXContext, shutdownApplication } from '../../dist/index.js';
import { makeApplication, makeEvent, resolveOk } from '../helpers.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('shutdown drains active requests before stopping Core', async () => {
  const app = makeApplication();
  const handle = createSvelteXHandler(app);
  const entered = deferred();
  const finish = deferred();
  const request = handle({ event: makeEvent('/slow'), resolve: async event => {
    getSvelteXContext(event.locals);
    entered.resolve();
    await finish.promise;
    return resolveOk();
  }});

  await entered.promise;
  assert.equal(getActiveRequestCount(app), 1);
  const shutdown = shutdownApplication(app);
  await assert.rejects(
    handle({ event: makeEvent('/late'), resolve: resolveOk }),
    /shutting down|stopped/
  );
  assert.equal(app.state, 'running');
  finish.resolve();
  await request;
  await shutdown;
  assert.equal(getActiveRequestCount(app), 0);
  assert.equal(app.state, 'stopped');
});

test('shutdown is idempotent when called concurrently', async () => {
  const app = makeApplication();
  const handle = createSvelteXHandler(app);
  await handle({ event: makeEvent(), resolve: resolveOk });
  await Promise.all([shutdownApplication(app), shutdownApplication(app)]);
  assert.equal(app.state, 'stopped');
});

test('active request count returns to zero when route resolution throws', async () => {
  const app = makeApplication();
  const handle = createSvelteXHandler(app);
  await assert.rejects(handle({ event: makeEvent(), resolve: async () => { throw new Error('route'); } }), /route/);
  assert.equal(getActiveRequestCount(app), 0);
  await shutdownApplication(app);
});

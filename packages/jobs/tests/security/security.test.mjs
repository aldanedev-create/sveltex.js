import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, JobsValidationError, JobsClosedError } from '../../dist/index.js';
import { InMemoryJobQueue } from '../../dist/in-memory.js';

test('SEC: at-least-once claim cannot double-execute a side effect', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ name: 'charge', payload: { amount: 100 } }, 0);
  let executions = 0;
  const worker = new Worker({ queue: q, now: () => 0, handler: () => { executions += 1; } });
  // Two overlapping ticks are serialized by the worker; plus two independent queue claims.
  await Promise.all([worker.tick(0), worker.tick(0)]);
  const [a, b] = await Promise.all([q.claim(0, 10), q.claim(0, 10)]);
  assert.equal(a.length + b.length, 0, 'a completed job cannot be re-claimed');
  assert.equal(executions, 1, 'side effect must run exactly once');
  await worker.stop();
  await q.close();
});

test('SEC: fail/complete after dead-letter cannot resurrect a job', async () => {
  const q = new InMemoryJobQueue();
  const r = await q.enqueue({ name: 'x', payload: 1, maxAttempts: 1 }, 0);
  const [job] = await q.claim(0, 1);
  await q.fail(job.id, { error: 'boom' }); // dead (no retryAt)
  await q.fail(job.id, { error: 'retry?', retryAt: 5 });
  await q.complete(job.id);
  assert.equal((await q.get(r.job.id)).status, 'dead');
  assert.equal((await q.claim(100, 10)).length, 0);
  await q.close();
});

test('SEC: dedupeKey is bounded (empty / oversized rejected) and never used as a path', async () => {
  const q = new InMemoryJobQueue();
  await assert.rejects(
    () => q.enqueue({ name: 'x', payload: 1, dedupeKey: '' }, 0),
    { name: 'JobsValidationError' },
  );
  await assert.rejects(
    () => q.enqueue({ name: 'x', payload: 1, dedupeKey: 'k'.repeat(257) }, 0),
    { name: 'JobsValidationError' },
  );
  // dedupeKey is only ever an in-memory Map key, never interpolated into a filesystem path or
  // shell command, so control characters are inert and are accepted as a valid opaque key.
  const first = await q.enqueue({ name: 'x', payload: 1, dedupeKey: '../../etc/passwd' }, 0);
  const dup = await q.enqueue({ name: 'x', payload: 2, dedupeKey: '../../etc/passwd' }, 0);
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.job.id, first.job.id);
  assert.equal(q.size, 1);
  await q.close();
});

test('SEC: job name rejects traversal/injection characters', async () => {
  const q = new InMemoryJobQueue();
  for (const bad of ['', '../../etc/passwd', 'a b', 'x\ny', 'a'.repeat(129)]) {
    await assert.rejects(() => q.enqueue({ name: bad, payload: 1 }, 0), { name: 'JobsValidationError' });
  }
  await q.close();
});

test('SEC: errors thrown by a handler are reported but never crash the worker', async () => {
  const q = new InMemoryJobQueue();
  const reported = [];
  const worker = new Worker({
    queue: q,
    now: () => 0,
    backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 1 },
    onError: (err, job) => reported.push([err.message, job.name]),
    handler: () => { throw new Error('handler exploded'); },
  });
  await q.enqueue({ name: 'x', payload: 1, maxAttempts: 1 }, 0);
  const result = await worker.tick(0);
  assert.equal(result.dead, 1);
  assert.deepEqual(reported, [['handler exploded', 'x']]);
  assert.equal(worker.isStopped, false);
  await worker.stop();
  await q.close();
});

test('SEC: a closed queue rejects new work; worker tick surfaces a wrapped claim error', async () => {
  const q = new InMemoryJobQueue();
  const worker = new Worker({ queue: q, now: () => 0, handler: () => {} });
  await q.close();
  await assert.rejects(() => q.enqueue({ name: 'x', payload: 1 }, 0), { name: 'JobsClosedError' });
  await assert.rejects(() => worker.tick(0), (err) => {
    assert.equal(err.name, 'JobsError');
    assert.equal(err.cause.name, 'JobsClosedError');
    return true;
  });
  await worker.stop();
});

test('SEC: exhausted retries are capped and the job is retained as dead-letter evidence', async () => {
  const q = new InMemoryJobQueue();
  let attempts = 0;
  const worker = new Worker({
    queue: q,
    now: () => 0,
    backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 1 },
    handler: () => { attempts += 1; throw new Error('nope'); },
  });
  await q.enqueue({ name: 'x', payload: 1, maxAttempts: 2 }, 0);
  await worker.tick(0);
  await worker.tick(1);
  assert.equal(attempts, 2, 'must not retry beyond maxAttempts');
  const job = (await q.list())[0];
  assert.equal(job.status, 'dead');
  assert.equal(job.lastError, 'nope');
  await worker.stop();
  await q.close();
});

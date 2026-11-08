import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Worker,
  computeBackoffDelay,
  DEFAULT_BACKOFF,
  JobsValidationError,
  JobsClosedError,
} from '../dist/index.js';
import { InMemoryJobQueue } from '../dist/in-memory.js';

function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; return value; },
    set: (v) => { value = v; return value; },
  };
}

test('computeBackoffDelay is exponential and capped', () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 1000, factor: 2 };
  assert.equal(computeBackoffDelay(1, policy), 100);
  assert.equal(computeBackoffDelay(2, policy), 200);
  assert.equal(computeBackoffDelay(3, policy), 400);
  assert.equal(computeBackoffDelay(4, policy), 800);
  assert.equal(computeBackoffDelay(5, policy), 1000);
  assert.equal(computeBackoffDelay(99, policy), 1000);
  assert.ok(DEFAULT_BACKOFF.factor >= 1);
});

test('enqueue validates name, maxAttempts, delayMs, dedupeKey and now', async () => {
  const q = new InMemoryJobQueue();
  await assert.rejects(() => q.enqueue({ name: 'bad name', payload: 1 }, 0), { name: 'JobsValidationError' });
  await assert.rejects(() => q.enqueue({ name: '../../etc', payload: 1 }, 0), { name: 'JobsValidationError' });
  await assert.rejects(() => q.enqueue({ name: 'ok', payload: 1, maxAttempts: 0 }, 0), { name: 'JobsValidationError' });
  await assert.rejects(() => q.enqueue({ name: 'ok', payload: 1, delayMs: -1 }, 0), { name: 'JobsValidationError' });
  await assert.rejects(() => q.enqueue({ name: 'ok', payload: 1, dedupeKey: '' }, 0), { name: 'JobsValidationError' });
  await assert.rejects(() => q.enqueue({ name: 'ok', payload: 1 }, NaN), { name: 'JobsValidationError' });
  await q.close();
});

test('enqueue with dedupeKey collapses duplicate pending jobs into one', async () => {
  const q = new InMemoryJobQueue();
  const first = await q.enqueue({ name: 'email', payload: { to: 'a' }, dedupeKey: 'email:a' }, 0);
  const second = await q.enqueue({ name: 'email', payload: { to: 'a' }, dedupeKey: 'email:a' }, 0);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(q.size, 1);
  await q.close();
});

test('a completed dedupeKey can be re-enqueued as a fresh job', async () => {
  const q = new InMemoryJobQueue();
  const first = await q.enqueue({ name: 'email', payload: 1, dedupeKey: 'k' }, 0);
  const claimed = await q.claim(0, 1);
  await q.complete(claimed[0].id);
  const again = await q.enqueue({ name: 'email', payload: 2, dedupeKey: 'k' }, 1);
  assert.equal(again.deduplicated, false);
  assert.notEqual(again.job.id, first.job.id);
  await q.close();
});

test('claim respects delayed visibility (delayMs)', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ name: 'later', payload: 1, delayMs: 500 }, 100);
  assert.equal((await q.claim(100, 10)).length, 0);
  assert.equal((await q.claim(599, 10)).length, 0);
  const due = await q.claim(600, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].status, 'active');
  assert.equal(due[0].attempts, 1);
  await q.close();
});

test('claim is atomic: a second concurrent claim cannot take the same job', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ name: 'once', payload: 1 }, 0);
  const [a, b] = await Promise.all([q.claim(0, 10), q.claim(0, 10)]);
  const total = a.length + b.length;
  assert.equal(total, 1, 'job must be claimed exactly once');
  await q.close();
});

test('complete / fail are idempotent (duplicate delivery cannot double-finalize)', async () => {
  const q = new InMemoryJobQueue();
  const r = await q.enqueue({ name: 'x', payload: 1 }, 0);
  const [job] = await q.claim(0, 1);
  await q.complete(job.id);
  await q.complete(job.id);
  await q.fail(job.id, { error: 'late' });
  assert.equal((await q.get(r.job.id)).status, 'completed');
  await q.close();
});

test('cancel removes a pending job; active jobs cannot be cancelled', async () => {
  const q = new InMemoryJobQueue();
  const r = await q.enqueue({ name: 'x', payload: 1 }, 0);
  assert.equal(await q.cancel(r.job.id), true);
  assert.equal(await q.cancel(r.job.id), false);
  assert.equal((await q.get(r.job.id)).status, 'cancelled');
  assert.equal((await q.claim(0, 10)).length, 0);
  await q.close();
});

test('close() is idempotent and rejects further enqueue/claim', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ name: 'x', payload: 1 }, 0);
  await q.close();
  await q.close();
  assert.equal(q.isClosed, true);
  await assert.rejects(() => q.enqueue({ name: 'y', payload: 2 }, 1), { name: 'JobsClosedError' });
  await assert.rejects(() => q.claim(1, 1), { name: 'JobsClosedError' });
});

test('Worker processes an enqueued job to completion', async () => {
  const c = clock();
  const q = new InMemoryJobQueue({ now: c.now });
  const seen = [];
  const worker = new Worker({ queue: q, handler: (job) => { seen.push(job.payload); }, now: c.now });
  await q.enqueue({ name: 'greet', payload: 'world' }, c.now());
  const result = await worker.tick(c.now());
  assert.equal(result.claimed, 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(seen, ['world']);
  assert.equal((await q.get((await q.list())[0].id)).status, 'completed');
  await worker.stop();
  await q.close();
});

test('Worker retries with capped exponential backoff until success', async () => {
  const c = clock();
  const q = new InMemoryJobQueue({ now: c.now });
  let calls = 0;
  const worker = new Worker({
    queue: q,
    now: c.now,
    backoff: { baseDelayMs: 100, maxDelayMs: 1000, factor: 2 },
    handler: (job, ctx) => {
      calls += 1;
      assert.equal(ctx.attempts, calls);
      if (calls < 3) throw new Error('transient');
    },
  });
  await q.enqueue({ name: 'flaky', payload: 1, maxAttempts: 5 }, c.now());
  const t1 = await worker.tick(c.now());
  assert.equal(t1.failed, 1);
  assert.equal(t1.retried, 1);
  let job = (await q.list())[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.availableAt, 100); // now(0) + baseDelayMs(100)
  assert.equal((await worker.tick(99)).claimed, 0, 'not yet due');
  c.set(100);
  await worker.tick(c.now());
  job = (await q.list())[0];
  assert.equal(job.availableAt, 300); // 100 + 200
  c.set(300);
  const t3 = await worker.tick(c.now());
  assert.equal(t3.succeeded, 1);
  assert.equal(calls, 3);
  assert.equal((await q.get(job.id)).status, 'completed');
  await worker.stop();
  await q.close();
});

test('Worker dead-letters a job that exhausts maxAttempts', async () => {
  const c = clock();
  const q = new InMemoryJobQueue({ now: c.now });
  const errors = [];
  const worker = new Worker({
    queue: q,
    now: c.now,
    backoff: { baseDelayMs: 10, maxDelayMs: 10, factor: 1 },
    onError: (err) => errors.push(err.message),
    handler: () => { throw new Error('always fails'); },
  });
  await q.enqueue({ name: 'doomed', payload: 1, maxAttempts: 3 }, c.now());
  await worker.tick(0);
  await worker.tick(10);
  const t3 = await worker.tick(20);
  assert.equal(t3.dead, 1);
  const job = (await q.list())[0];
  assert.equal(job.status, 'dead');
  assert.equal(job.attempts, 3);
  assert.equal(job.lastError, 'always fails');
  assert.deepEqual(errors, ['always fails', 'always fails', 'always fails']);
  assert.equal((await worker.tick(100)).claimed, 0, 'dead jobs are not re-claimed');
  await worker.stop();
  await q.close();
});

test('Worker enforces concurrency: one tick never claims more than the budget', async () => {
  const q = new InMemoryJobQueue();
  for (let i = 0; i < 10; i += 1) await q.enqueue({ name: 'x', payload: i }, 0);
  const worker = new Worker({ queue: q, concurrency: 3, handler: () => {}, now: () => 0 });
  const result = await worker.tick(0);
  assert.equal(result.claimed, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(worker.metrics.claimed, 3);
  await worker.stop();
  await q.close();
});

test('Worker honors AbortSignal via handler context and stops polling', async () => {
  const q = new InMemoryJobQueue();
  const controller = new AbortController();
  let sawSignal = false;
  const worker = new Worker({
    queue: q,
    now: () => 0,
    signal: controller.signal,
    handler: (_job, ctx) => { sawSignal = ctx.signal.aborted; },
  });
  await q.enqueue({ name: 'x', payload: 1 }, 0);
  await worker.tick(0);
  assert.equal(sawSignal, false);
  controller.abort();
  await worker.stop();
  assert.equal(worker.isStopped, true);
  await q.close();
});

test('graceful stop drains an in-flight handler before resolving', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ name: 'slow', payload: 1 }, 0);
  let finished = false;
  const worker = new Worker({
    queue: q,
    now: () => 0,
    handler: async () => { await new Promise((r) => setTimeout(r, 15)); finished = true; },
  });
  const running = worker.tick(0);
  await worker.stop();
  await running;
  assert.equal(finished, true, 'stop must wait for in-flight work');
  assert.equal((await q.get((await q.list())[0].id)).status, 'completed');
  await worker.stop(); // idempotent
  await q.close();
});

test('start()/stop() run idempotently with a real timer (no hanging handles)', async (t) => {
  const q = new InMemoryJobQueue();
  const seen = [];
  const worker = new Worker({ queue: q, pollIntervalMs: 5, now: () => 0, handler: (j) => { seen.push(j.payload); } });
  await q.enqueue({ name: 'x', payload: 'tick' }, 0);
  worker.start();
  worker.start();
  assert.equal(worker.isRunning, true);
  t.after(async () => { await worker.stop(); await q.close(); });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(seen.includes('tick'));
  await worker.stop();
  assert.equal(worker.isRunning, false);
  await worker.stop();
});

test('constructor validates queue, handler, concurrency and pollIntervalMs', () => {
  const q = new InMemoryJobQueue();
  assert.throws(() => new Worker({ handler: () => {} }), { name: 'JobsValidationError' });
  assert.throws(() => new Worker({ queue: q }), { name: 'JobsValidationError' });
  assert.throws(() => new Worker({ queue: q, handler: () => {}, concurrency: 0 }), { name: 'JobsValidationError' });
  assert.throws(() => new Worker({ queue: q, handler: () => {}, pollIntervalMs: -1 }), { name: 'JobsValidationError' });
  assert.ok(JobsValidationError);
  assert.ok(JobsClosedError);
});

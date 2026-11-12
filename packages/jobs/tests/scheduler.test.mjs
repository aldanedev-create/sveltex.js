import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDelayMs, JobScheduler } from '../dist/scheduler.js';
import { InMemoryJobQueue } from '../dist/in-memory.js';
import { Worker } from '../dist/index.js';

test('scheduler: computeDelayMs clamps past run times and validates timestamps', () => {
  assert.equal(computeDelayMs(500, 100), 400);
  assert.equal(computeDelayMs(50, 100), 0);
  assert.throws(() => computeDelayMs(Number.NaN, 1), { name: 'JobsValidationError' });
  assert.throws(() => computeDelayMs(1, Number.POSITIVE_INFINITY), { name: 'JobsValidationError' });
});

test('scheduler: scheduleAt / scheduleIn set delayed visibility via delayMs', async () => {
  const queue = new InMemoryJobQueue();
  const scheduler = new JobScheduler(queue, { now: () => 1000 });
  const at = await scheduler.scheduleAt({ name: 'later', payload: 1, delayMs: 999 }, 1500, 1000);
  assert.equal(at.job.availableAt, 1500, 'scheduleAt overrides delayMs');
  const after = await scheduler.scheduleIn({ name: 'later2', payload: 2 }, 600, 1000);
  assert.equal(after.job.availableAt, 1600);
  assert.equal((await queue.claim(1000, 10)).length, 0);
  assert.equal((await queue.claim(1499, 10)).length, 0);
  const due = await queue.claim(1500, 10);
  assert.deepEqual(due.map((j) => j.name), ['later']);
  assert.equal((await queue.claim(1599, 10)).length, 0);
  const later = await queue.claim(1600, 10);
  assert.deepEqual(later.map((j) => j.name), ['later2']);
  await queue.close();
});

test('scheduler: enqueue delegates and a Worker executes scheduled jobs', async () => {
  const queue = new InMemoryJobQueue();
  const scheduler = new JobScheduler(queue, { now: () => 0 });
  assert.equal(scheduler.queue, queue);
  const direct = await scheduler.enqueue({ name: 'now', payload: 'a' }, 0);
  const scheduled = await scheduler.scheduleIn({ name: 'soon', payload: 'b' }, 10, 0);
  assert.equal(direct.deduplicated, false);
  assert.equal(scheduled.job.availableAt, 10);
  const seen = [];
  const worker = new Worker({ queue, now: () => 0, handler: (job) => { seen.push(job.payload); } });
  assert.equal((await worker.tick(0)).succeeded, 1);
  assert.equal((await worker.tick(10)).succeeded, 1);
  assert.deepEqual(seen, ['a', 'b']);
  await worker.stop();
  await queue.close();
});

test('scheduler: invalid arguments are rejected before touching the queue', () => {
  const queue = new InMemoryJobQueue();
  const scheduler = new JobScheduler(queue);
  assert.throws(() => new JobScheduler(null), TypeError);
  assert.throws(() => scheduler.scheduleIn({ name: 'x', payload: 1 }, -1, 0), TypeError);
  assert.throws(() => scheduler.scheduleIn({ name: 'x', payload: 1 }, Number.NaN, 0), TypeError);
  queue.close();
});

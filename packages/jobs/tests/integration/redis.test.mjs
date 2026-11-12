import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisJobQueue } from '../../dist/redis.js';
import { Worker, JobsClosedError } from '../../dist/index.js';
import { JobRegistry } from '../../dist/registry.js';

/**
 * Real Redis integration tests. These require an actual Redis server (CI runs
 * `redis:7`; locally use REDIS_URL). Nothing is mocked and no test is skipped:
 * every queue below constructs its own ioredis client, so a two-instance test
 * is genuinely two independent consumers competing over the same durable keys.
 */
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const namespace = `p6it:${randomBytes(5).toString('hex')}:`;
const cleaner = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });

before(async () => {
  await cleaner.connect();
  assert.equal(await cleaner.ping(), 'PONG', 'a real Redis server must be reachable');
});

after(async () => {
  try {
    const keys = await cleaner.keys(`${namespace}*`);
    if (keys.length > 0) await cleaner.del(...keys);
  } finally {
    await cleaner.quit();
  }
});

async function withQueues(label, count, body) {
  const prefix = `${namespace}${label}:`;
  const queues = Array.from(
    { length: count },
    () => new RedisJobQueue({ url, keyPrefix: prefix, now: () => 0 }),
  );
  try {
    return await body(queues);
  } finally {
    for (const queue of queues) await queue.close();
  }
}

test('R-1: two independent Redis clients share the same durable job state', async () => {
  await withQueues('r1', 2, async ([a, b]) => {
    const { job, deduplicated } = await a.enqueue(
      { name: 'email.send', payload: { to: 'a@b.com', tags: [1, 'x'] }, delayMs: 50, dedupeKey: 'k1' },
      1000,
    );
    assert.equal(deduplicated, false);
    assert.equal(job.status, 'pending');
    assert.equal(job.availableAt, 1050);
    assert.equal(job.attempts, 0);
    assert.equal(Object.isFrozen(job), true);

    const fromB = await b.get(job.id);
    assert.ok(fromB, 'the second client must read the first client\'s persisted job');
    assert.equal(fromB.id, job.id);
    assert.equal(fromB.name, 'email.send');
    assert.deepEqual(fromB.payload, { to: 'a@b.com', tags: [1, 'x'] });
    assert.equal(fromB.dedupeKey, 'k1');
    assert.equal(fromB.status, 'pending');
    assert.equal(Object.isFrozen(fromB), true);

    const all = await b.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, job.id);
  });
});

test('R-2: concurrent atomic claim across independent clients never delivers a job twice', async () => {
  await withQueues('r2', 2, async ([a, b]) => {
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const { job } = await a.enqueue({ name: 'bulk.item', payload: { i } }, 0);
      ids.push(job.id);
    }
    const [left, right] = await Promise.all([a.claim(0, 12), b.claim(0, 12)]);
    const claimed = [...left, ...right];
    assert.equal(claimed.length, 12, 'every due job is claimed exactly once');
    assert.equal(new Set(claimed.map((j) => j.id)).size, 12, 'no duplicate delivery');
    assert.deepEqual(new Set(claimed.map((j) => j.id)), new Set(ids));
    for (const job of claimed) {
      assert.equal(job.status, 'active');
      assert.equal(job.attempts, 1);
    }
    assert.deepEqual(await a.claim(0, 12), [], 'claimed jobs leave the ready ZSET');
  });
});

test('R-3: delayed visibility is enforced server-side by the ready ZSET', async () => {
  await withQueues('r3', 1, async ([q]) => {
    const { job } = await q.enqueue({ name: 'later', payload: 7, delayMs: 100 }, 0);
    assert.deepEqual(await q.claim(99, 10), []);
    const claimed = await q.claim(100, 10);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, job.id);
    assert.equal(claimed[0].payload, 7);
  });
});

test('R-4: dedupe keys are atomic across clients and released after finalization', async () => {
  await withQueues('r4', 2, async ([a, b]) => {
    const first = await a.enqueue({ name: 'dedupe', payload: 1, dedupeKey: 'same' }, 0);
    const second = await b.enqueue({ name: 'dedupe', payload: 2, dedupeKey: 'same' }, 0);
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.job.id, first.job.id);
    assert.equal((await b.list()).length, 1, 'no duplicate row was created');

    const [claimed] = await a.claim(0, 1);
    await a.complete(claimed.id);
    assert.equal((await b.get(first.job.id)).status, 'completed');

    const third = await b.enqueue({ name: 'dedupe', payload: 3, dedupeKey: 'same' }, 0);
    assert.equal(third.deduplicated, false, 'a completed job releases its dedupe key');
    assert.notEqual(third.job.id, first.job.id);
  });
});

test('R-5: complete / fail-retry / dead-letter / cancel transitions are idempotent', async () => {
  await withQueues('r5', 1, async ([q]) => {
    const { job } = await q.enqueue({ name: 'state', payload: { x: 1 }, maxAttempts: 2 }, 0);
    assert.equal(await q.cancel(job.id), true);
    assert.equal((await q.get(job.id)).status, 'cancelled');
    assert.equal(await q.cancel(job.id), false, 'cancel is idempotent');
    assert.deepEqual(await q.claim(0, 10), [], 'a cancelled job is never claimable');

    const retry = await q.enqueue({ name: 'state', payload: 2, maxAttempts: 2 }, 0);
    const [c1] = await q.claim(0, 1);
    assert.equal(c1.attempts, 1);
    await q.fail(c1.id, { error: 'retry me', retryAt: 500 });
    const requeued = await q.get(retry.job.id);
    assert.equal(requeued.status, 'pending');
    assert.equal(requeued.availableAt, 500);
    assert.equal(requeued.lastError, 'retry me');
    assert.deepEqual(await q.claim(499, 1), []);
    const [c2] = await q.claim(500, 1);
    assert.equal(c2.attempts, 2);
    await q.fail(c2.id, { error: 'give up' });
    const dead = await q.get(retry.job.id);
    assert.equal(dead.status, 'dead');
    assert.equal(dead.lastError, 'give up');
    await q.complete(retry.job.id);
    assert.equal((await q.get(retry.job.id)).status, 'dead', 'a dead job cannot be resurrected');
  });
});

test('R-6: a Worker processes Redis-backed jobs end to end through a JobRegistry', async () => {
  await withQueues('r6', 1, async ([q]) => {
    const seen = [];
    const registry = new JobRegistry();
    registry.register('email.send', (job) => { seen.push(job.payload); });
    const worker = new Worker({
      queue: q,
      handler: registry.createHandler(),
      concurrency: 3,
      now: () => 0,
      backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 1 },
    });
    for (let i = 0; i < 4; i += 1) await q.enqueue({ name: 'email.send', payload: { i } }, 0);
    const first = await worker.tick(0);
    assert.equal(first.claimed, 3);
    assert.equal(first.succeeded, 3);
    assert.equal(seen.length, 3);
    const second = await worker.tick(0);
    assert.equal(second.succeeded, 1);
    assert.equal(seen.length, 4);
    assert.equal((await q.list()).every((job) => job.status === 'completed'), true);
    await worker.stop();
  });
});

test('R-7: close() disconnects the client and rejects further work', async () => {
  const queue = new RedisJobQueue({ url, keyPrefix: `${namespace}r7:`, now: () => 0 });
  await queue.connect();
  await queue.enqueue({ name: 'x', payload: 1 }, 0);
  await queue.close();
  assert.equal(queue.isClosed, true);
  await assert.rejects(
    () => queue.claim(0, 1),
    (error) => error instanceof JobsClosedError,
  );
  await queue.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@sveltex/database';
import { SqliteAdapter } from '@sveltex/database/sqlite';
import { PostgresAdapter } from '@sveltex/database/postgres';
import { SqlJobQueue } from '../../dist/sql.js';
import { Worker } from '../../dist/index.js';
import { JobRegistry } from '../../dist/registry.js';

/**
 * Real SQL integration tests. `SqlJobQueue` is driven through the actual
 * `@sveltex/database` facade with real SQLite (`node:sqlite`) and real
 * PostgreSQL (`pg.Pool`) adapters — no mock executor, no skipped cases.
 * CI supplies PostgreSQL via a service container and REDIS_URL separately.
 */
const pgUrl = process.env.SVELTEX_TEST_POSTGRES_URL
  ?? 'postgresql://sveltex:sveltex_test_pw@127.0.0.1:5432/sveltex_test';
const runId = randomBytes(4).toString('hex');

async function openSqlite(path = ':memory:') {
  const db = new Database(new SqliteAdapter({ path }));
  await db.connect();
  return db;
}

async function openPostgres() {
  const db = new Database(new PostgresAdapter({ connectionString: pgUrl, pool: { max: 4 } }));
  await db.connect();
  return db;
}

function tableFor(label) {
  return `p6_${runId}_${label}`;
}

async function withDb(dialect, label, body) {
  const db = dialect === 'postgres' ? await openPostgres() : await openSqlite();
  const tableName = tableFor(label);
  try {
    return await body({ db, tableName, dialect });
  } finally {
    try {
      await db.query(`DROP TABLE IF EXISTS ${tableName}`);
    } finally {
      await db.close();
    }
  }
}

function makeQueue(db, dialect, tableName) {
  return new SqlJobQueue(db, { dialect, tableName, now: () => 0 });
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`S-${dialect}-1: real ${dialect} queue persists strict payloads and cancels`, async () => {
    await withDb(dialect, `${dialect}_1`, async ({ db, tableName }) => {
      const q = makeQueue(db, dialect, tableName);
      assert.equal(q.schemaStatements().length, 2);
      await q.ensureSchema();
      await q.ensureSchema();

      const { job, deduplicated } = await q.enqueue(
        { name: 'email.send', payload: { to: 'a@b.com', tags: [1, 'x'] }, delayMs: 50, dedupeKey: 'k1' },
        1000,
      );
      assert.equal(deduplicated, false);
      assert.equal(job.status, 'pending');
      assert.equal(job.availableAt, 1050);
      assert.equal(job.attempts, 0);

      const loaded = await q.get(job.id);
      assert.ok(loaded);
      assert.equal(loaded.name, 'email.send');
      assert.deepEqual(loaded.payload, { to: 'a@b.com', tags: [1, 'x'] });
      assert.equal(loaded.dedupeKey, 'k1');
      assert.equal(Object.isFrozen(loaded), true);
      assert.equal((await q.list()).length, 1);

      assert.equal(await q.cancel(job.id), true);
      assert.equal((await q.get(job.id)).status, 'cancelled');
      assert.equal(await q.cancel(job.id), false);
      assert.deepEqual(await q.claim(9999, 10), [], 'a cancelled job is never claimable');
      await q.close();
    });
  });

  test(`S-${dialect}-2: claim increments attempts exactly once and enforces delayed visibility`, async () => {
    await withDb(dialect, `${dialect}_2`, async ({ db, tableName }) => {
      const q = makeQueue(db, dialect, tableName);
      const { job } = await q.enqueue({ name: 'later', payload: { n: 9 }, delayMs: 100 }, 0);
      assert.deepEqual(await q.claim(99, 10), []);
      const claimed = await q.claim(100, 10);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].id, job.id);
      assert.equal(claimed[0].status, 'active');
      assert.equal(claimed[0].attempts, 1);
      assert.deepEqual(claimed[0].payload, { n: 9 });
      assert.equal((await q.get(job.id)).attempts, 1);
      assert.deepEqual(await q.claim(100, 10), [], 'active jobs are not re-claimed');
      await q.complete(job.id);
      await q.complete(job.id);
      assert.equal((await q.get(job.id)).status, 'completed');
      await q.close();
    });
  });

  test(`S-${dialect}-3: the partial unique dedupe index prevents duplicate pending rows`, async () => {
    await withDb(dialect, `${dialect}_3`, async ({ db, tableName }) => {
      const a = makeQueue(db, dialect, tableName);
      const b = makeQueue(db, dialect, tableName);
      const [one, two] = await Promise.all([
        a.enqueue({ name: 'dedupe', payload: 1, dedupeKey: 'same' }, 0),
        b.enqueue({ name: 'dedupe', payload: 2, dedupeKey: 'same' }, 0),
      ]);
      assert.equal(one.deduplicated === false || two.deduplicated === false, true);
      assert.equal(one.deduplicated !== two.deduplicated, true, 'exactly one insert wins');
      assert.equal((await a.list()).length, 1, 'only one row exists');
      const winner = one.deduplicated ? two.job.id : one.job.id;
      assert.equal(one.deduplicated ? one.job.id : two.job.id, winner, 'both callers resolve the same id');

      const [claimed] = await a.claim(0, 1);
      await a.complete(claimed.id);
      const again = await b.enqueue({ name: 'dedupe', payload: 3, dedupeKey: 'same' }, 0);
      assert.equal(again.deduplicated, false, 'a completed row releases its dedupe key');
      await a.close();
      await b.close();
    });
  });

  test(`S-${dialect}-4: fail/retry/dead-letter and Worker processing are durable`, async () => {
    await withDb(dialect, `${dialect}_4`, async ({ db, tableName }) => {
      const q = makeQueue(db, dialect, tableName);
      const retry = await q.enqueue({ name: 'state', payload: 2, maxAttempts: 2 }, 0);
      const [c1] = await q.claim(0, 1);
      await q.fail(c1.id, { error: 'retry me', retryAt: 500 });
      const requeued = await q.get(retry.job.id);
      assert.equal(requeued.status, 'pending');
      assert.equal(requeued.availableAt, 500);
      assert.equal(requeued.lastError, 'retry me');
      assert.deepEqual(await q.claim(499, 1), []);
      const [c2] = await q.claim(500, 1);
      assert.equal(c2.attempts, 2);
      await q.fail(c2.id, { error: 'give up' });
      assert.equal((await q.get(retry.job.id)).status, 'dead');

      const seen = [];
      const registry = new JobRegistry();
      registry.register('email.send', (job) => { seen.push(job.payload); });
      const worker = new Worker({
        queue: q,
        handler: registry.createHandler(),
        concurrency: 2,
        now: () => 0,
        backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 1 },
      });
      for (let i = 0; i < 3; i += 1) await q.enqueue({ name: 'email.send', payload: { i } }, 0);
      assert.equal((await worker.tick(0)).succeeded, 2);
      assert.equal((await worker.tick(0)).succeeded, 1);
      assert.equal(seen.length, 3);
      assert.equal((await q.list()).filter((j) => j.status === 'completed').length, 3);
      await worker.stop();
      await q.close();
    });
  });
}

test('S-pg-5: two independent PostgreSQL connections never claim the same job twice', async () => {
  const tableName = tableFor('pg5');
  const dbA = await openPostgres();
  const dbB = await openPostgres();
  const a = makeQueue(dbA, 'postgres', tableName);
  const b = makeQueue(dbB, 'postgres', tableName);
  try {
    const ids = [];
    for (let i = 0; i < 10; i += 1) {
      const { job } = await a.enqueue({ name: 'concurrent', payload: i }, 0);
      ids.push(job.id);
    }
    const [left, right] = await Promise.all([a.claim(0, 10), b.claim(0, 10)]);
    const claimed = [...left, ...right];
    assert.equal(claimed.length, 10, 'every due job is delivered exactly once');
    assert.equal(new Set(claimed.map((job) => job.id)).size, 10, 'no duplicate delivery');
    assert.deepEqual(new Set(claimed.map((job) => job.id)), new Set(ids));
  } finally {
    await a.close();
    await b.close();
    try {
      await dbA.query(`DROP TABLE IF EXISTS ${tableName}`);
    } finally {
      await dbA.close();
      await dbB.close();
    }
  }
});

test('S-sqlite-5: a file-backed SQLite queue survives a complete reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sveltex-jobs-'));
  const path = join(dir, 'jobs.db');
  const tableName = tableFor('sqlite5');
  let db1;
  let db2;
  try {
    db1 = await openSqlite(path);
    const q1 = makeQueue(db1, 'sqlite', tableName);
    const { job } = await q1.enqueue({ name: 'persist', payload: { n: 42 } }, 0);
    await q1.close();
    await db1.close();
    db1 = undefined;

    db2 = await openSqlite(path);
    const q2 = makeQueue(db2, 'sqlite', tableName);
    const loaded = await q2.get(job.id);
    assert.ok(loaded, 'the job survived a full close/reopen cycle');
    assert.deepEqual(loaded.payload, { n: 42 });
    const [claimed] = await q2.claim(0, 1);
    assert.equal(claimed.id, job.id);
    await q2.complete(claimed.id);
    assert.equal((await q2.get(job.id)).status, 'completed');
    await q2.close();
  } finally {
    if (db1) await db1.close().catch(() => undefined);
    if (db2) await db2.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

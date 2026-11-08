import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createDrizzleAdapter } from '../../dist/adapters/drizzle.js';
import { createConnection, runAdapterConformance, defineAdapterContext } from '../../dist/index.js';

const URL = process.env.SVELTEX_TEST_POSTGRES_URL
  ?? 'postgresql://sveltex:sveltex_test_pw@127.0.0.1:5432/sveltex_test';
const SKIP = process.env.SVELTEX_SKIP_DB_INTEGRATION === '1';
const TABLE = 'sveltex_drizzle_it';

function dbTest(name, fn) {
  test(name, { skip: SKIP ? 'SVELTEX_SKIP_DB_INTEGRATION=1' : false }, fn);
}

function makeAdapter(overrides = {}) {
  return createDrizzleAdapter({
    name: 'drizzle-pg',
    create: (config) => drizzle(new pg.Pool({ connectionString: config.connectionString ?? URL, max: 4 })),
    ...overrides,
  });
}

async function withConn(fn) {
  const conn = createConnection(makeAdapter(), Object.freeze({ connectionString: URL }));
  await conn.connect();
  try { return await fn(conn); }
  finally { await conn.close(); }
}

test('createDrizzleAdapter resolves capabilities and validates options', () => {
  const adapter = makeAdapter();
  assert.equal(adapter.name, 'drizzle-pg');
  assert.equal(adapter.capabilities.transactions, true);
  assert.equal(adapter.capabilities.healthCheck, true);
  assert.equal(adapter.capabilities.migrations, false);
  assert.throws(() => createDrizzleAdapter({}), TypeError);
  assert.throws(() => createDrizzleAdapter(null), TypeError);
});

test('drizzle migrate() delegates to the ORM-native migrator, never a competing engine', async () => {
  const calls = [];
  const adapter = makeAdapter({
    migrate: async (_client, request) => {
      calls.push(request?.action ?? 'status');
      return { action: request?.action ?? 'status', applied: 2, pending: 0 };
    },
  });
  assert.equal(adapter.capabilities.migrations, true);
  const ctx = defineAdapterContext('drizzle-pg', {}, Object.freeze({}));
  const status = await adapter.migrate(ctx, { action: 'up' });
  assert.equal(status.applied, 2);
  assert.deepEqual(calls, ['up']);
});

dbTest('drizzle adapter passes the shared conformance suite against real PostgreSQL', async () => {
  const report = await runAdapterConformance({
    name: 'drizzle-pg',
    async create() { return { adapter: makeAdapter(), config: Object.freeze({ connectionString: URL }) }; },
  });
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(report.passed, true, JSON.stringify(failed));
});

dbTest('drizzle health check, native API, real transaction commit and rollback', async () => {
  await withConn(async (conn) => {
    const report = await conn.healthCheck();
    assert.equal(report.healthy, true);

    const db = conn.native();
    assert.equal(typeof db.execute, 'function'); // native Drizzle API preserved
    // TABLE is a hard-coded constant; sql.raw is safe here (no user input).
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
    await db.execute(sql.raw(`CREATE TABLE ${TABLE} (id INT)`));

    const inserted = await conn.transaction(async (tx) => {
      assert.equal(typeof tx.client.execute, 'function'); // native tx API preserved
      await tx.client.execute(sql.raw(`INSERT INTO ${TABLE} VALUES (7)`));
      const r = await tx.client.execute(sql.raw(`SELECT count(*)::int AS c FROM ${TABLE}`));
      return r.rows[0].c;
    });
    assert.equal(inserted, 1);

    await assert.rejects(() => conn.transaction(async (tx) => {
      await tx.client.execute(sql.raw(`INSERT INTO ${TABLE} VALUES (8)`));
      throw new Error('force rollback');
    }), /force rollback/);

    const after = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${TABLE}`));
    assert.equal(after.rows[0].c, 1);

    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
    await conn.close();
    assert.equal(conn.state, 'closed');
  });
});

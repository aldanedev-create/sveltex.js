import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createKyselyAdapter } from '../../dist/adapters/kysely.js';
import { createConnection, runAdapterConformance, defineAdapterContext } from '../../dist/index.js';

const URL = process.env.SVELTEX_TEST_POSTGRES_URL
  ?? 'postgresql://sveltex:sveltex_test_pw@127.0.0.1:5432/sveltex_test';
const SKIP = process.env.SVELTEX_SKIP_DB_INTEGRATION === '1';
const TABLE = 'sveltex_kysely_it';

function dbTest(name, fn) {
  test(name, { skip: SKIP ? 'SVELTEX_SKIP_DB_INTEGRATION=1' : false }, fn);
}

function makeAdapter(overrides = {}) {
  return createKyselyAdapter({
    name: 'kysely-pg',
    create: (config) => new Kysely({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: config.connectionString ?? URL, max: 4 }) }),
    }),
    ...overrides,
  });
}

async function withConn(fn) {
  const conn = createConnection(makeAdapter(), Object.freeze({ connectionString: URL }));
  await conn.connect();
  try { return await fn(conn); }
  finally { await conn.close(); }
}

test('createKyselyAdapter resolves capabilities and validates options', () => {
  const adapter = makeAdapter();
  assert.equal(adapter.name, 'kysely-pg');
  assert.equal(adapter.capabilities.transactions, true);
  assert.equal(adapter.capabilities.healthCheck, true);
  assert.equal(adapter.capabilities.migrations, false);
  assert.throws(() => createKyselyAdapter({}), TypeError);
});

test('kysely migrate() delegates to the ORM-native migrator', async () => {
  const calls = [];
  const adapter = makeAdapter({
    migrate: async (_client, request) => {
      calls.push(request?.action ?? 'status');
      return { action: 'down', applied: 0, pending: 1 };
    },
  });
  assert.equal(adapter.capabilities.migrations, true);
  const ctx = defineAdapterContext('kysely-pg', {}, Object.freeze({}));
  const status = await adapter.migrate(ctx, { action: 'down' });
  assert.equal(status.action, 'down');
  assert.deepEqual(calls, ['down']);
});

dbTest('kysely adapter passes the shared conformance suite against real PostgreSQL', async () => {
  const report = await runAdapterConformance({
    name: 'kysely-pg',
    async create() { return { adapter: makeAdapter(), config: Object.freeze({ connectionString: URL }) }; },
  });
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(report.passed, true, JSON.stringify(failed));
});

dbTest('kysely health check, native API, real transaction commit and rollback', async () => {
  await withConn(async (conn) => {
    assert.equal((await conn.healthCheck()).healthy, true);

    const db = conn.native();
    assert.equal(typeof db.transaction, 'function'); // native Kysely API preserved
    await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)}`.execute(db);
    await sql`CREATE TABLE ${sql.table(TABLE)} (id INT)`.execute(db);

    const inserted = await conn.transaction(async (tx) => {
      await sql`INSERT INTO ${sql.table(TABLE)} VALUES (7)`.execute(tx.client);
      const r = await sql`SELECT count(*)::int AS c FROM ${sql.table(TABLE)}`.execute(tx.client);
      return r.rows[0].c;
    });
    assert.equal(inserted, 1);

    await assert.rejects(() => conn.transaction(async (tx) => {
      await sql`INSERT INTO ${sql.table(TABLE)} VALUES (8)`.execute(tx.client);
      throw new Error('force rollback');
    }), /force rollback/);

    const after = await sql`SELECT count(*)::int AS c FROM ${sql.table(TABLE)}`.execute(db);
    assert.equal(after.rows[0].c, 1);

    await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)}`.execute(db);
    await conn.close();
    assert.equal(conn.state, 'closed');
  });
});

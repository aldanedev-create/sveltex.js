import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomPgAdapter } from '../../examples/custom-orm-adapter.mjs';
import { createConnection, runAdapterConformance } from '../../dist/index.js';

const URL = process.env.SVELTEX_TEST_POSTGRES_URL
  ?? 'postgresql://sveltex:sveltex_test_pw@127.0.0.1:5432/sveltex_test';
const SKIP = process.env.SVELTEX_SKIP_DB_INTEGRATION === '1';
const TABLE = 'sveltex_byo_it';

function dbTest(name, fn) {
  test(name, { skip: SKIP ? 'SVELTEX_SKIP_DB_INTEGRATION=1' : false }, fn);
}

test('custom BYO adapter is a first-class, validated adapter', () => {
  const adapter = createCustomPgAdapter();
  assert.equal(adapter.name, 'custom-pg');
  assert.equal(Object.isFrozen(adapter.capabilities), true);
  assert.deepEqual({ ...adapter.capabilities }, {
    transactions: true, savepoints: false, healthCheck: true, migrations: false,
  });
});

dbTest('custom BYO adapter passes the shared conformance suite against real PostgreSQL', async () => {
  const report = await runAdapterConformance({
    name: 'custom-pg',
    async create() {
      return { adapter: createCustomPgAdapter(), config: Object.freeze({ connectionString: URL }) };
    },
  });
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(report.passed, true, JSON.stringify(failed));
});

dbTest('custom BYO adapter keeps the native pg client and rolls back real transactions', async () => {
  const conn = createConnection(createCustomPgAdapter(), Object.freeze({ connectionString: URL }));
  await conn.connect();
  try {
    const pool = conn.native();
    assert.equal(typeof pool.query, 'function'); // native API preserved
    assert.equal((await conn.healthCheck()).healthy, true);

    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`CREATE TABLE ${TABLE} (id INT)`);

    const inserted = await conn.transaction(async (tx) => {
      await tx.client.query(`INSERT INTO ${TABLE} VALUES (7)`);
      const r = await tx.client.query(`SELECT count(*)::int AS c FROM ${TABLE}`);
      return r.rows[0].c;
    });
    assert.equal(inserted, 1);

    await assert.rejects(() => conn.transaction(async (tx) => {
      await tx.client.query(`INSERT INTO ${TABLE} VALUES (8)`);
      throw new Error('force rollback');
    }), /force rollback/);

    const after = await pool.query(`SELECT count(*)::int AS c FROM ${TABLE}`);
    assert.equal(after.rows[0].c, 1);
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  } finally {
    await conn.close();
  }
  assert.equal(conn.state, 'closed');
});

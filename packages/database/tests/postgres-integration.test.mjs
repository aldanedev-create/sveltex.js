import test from 'node:test';
import assert from 'node:assert/strict';
import { Database, DatabaseLifecycleError } from '../dist/index.js';
import { PostgresAdapter } from '../dist/postgres.js';
import { MigrationRunner, createMigrationDialect } from '../dist/migrations.js';

const URL = process.env.SVELTEX_TEST_POSTGRES_URL
  ?? 'postgresql://sveltex:sveltex_test_pw@127.0.0.1:5432/sveltex_test';
const SKIP = process.env.SVELTEX_SKIP_DB_INTEGRATION === '1';
const TABLE = 'sveltex_pg_it';

/** Integration tests require a real PostgreSQL server. Skipping is explicit opt-out only. */
function dbTest(name, fn) {
  test(name, { skip: SKIP ? 'SVELTEX_SKIP_DB_INTEGRATION=1' : false }, fn);
}

async function withDb(fn) {
  const db = new Database(new PostgresAdapter({ connectionString: URL, pool: { max: 4 } }));
  await db.connect();
  try {
    await db.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.query(`CREATE TABLE ${TABLE} (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, balance INTEGER NOT NULL DEFAULT 0)`);
    await db.query(`INSERT INTO ${TABLE} (email, balance) VALUES ($1, $2)`, ['alice@example.com', 100]);
    return await fn(db);
  } finally {
    await db.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
    await db.close();
  }
}

dbTest('postgres adapter: connect and rowCount semantics', async () => {
  await withDb(async (db) => {
    const ins = await db.query(`INSERT INTO ${TABLE} (email, balance) VALUES ($1, $2)`, ['bob@example.com', 50]);
    assert.equal(ins.rowCount, 1);
    const upd = await db.query(`UPDATE ${TABLE} SET balance = 55 WHERE email = $1`, ['bob@example.com']);
    assert.equal(upd.rowCount, 1);
    const del = await db.query(`DELETE FROM ${TABLE} WHERE email = $1`, ['bob@example.com']);
    assert.equal(del.rowCount, 1);
    const sel = await db.query(`SELECT * FROM ${TABLE}`);
    assert.equal(sel.rowCount, 1);
    assert.equal(sel.rows[0]?.email, 'alice@example.com');
  });
});

dbTest('postgres adapter: parameterized queries prevent SQL injection', async () => {
  await withDb(async (db) => {
    const malicious = await db.query(`SELECT * FROM ${TABLE} WHERE email = $1`, ["' OR '1'='1"]);
    assert.equal(malicious.rowCount, 0);
    const valid = await db.query(`SELECT * FROM ${TABLE} WHERE email = $1`, ['alice@example.com']);
    assert.equal(valid.rowCount, 1);
  });
});

dbTest('postgres adapter: transaction commits on success', async () => {
  await withDb(async (db) => {
    await db.transaction(async (tx) => {
      const r = await tx.query(`UPDATE ${TABLE} SET balance = balance - 40 WHERE email = $1`, ['alice@example.com']);
      assert.equal(r.rowCount, 1);
    });
    const rows = await db.query(`SELECT balance FROM ${TABLE}`);
    assert.equal(rows.rows[0]?.balance, 60);
  });
});

dbTest('postgres adapter: transaction rolls back on failure', async () => {
  await withDb(async (db) => {
    const expected = new Error('domain failure');
    await assert.rejects(() => db.transaction(async (tx) => {
      await tx.query(`UPDATE ${TABLE} SET balance = balance - 40 WHERE email = $1`, ['alice@example.com']);
      throw expected;
    }), (error) => error === expected);
    const rows = await db.query(`SELECT balance FROM ${TABLE}`);
    assert.equal(rows.rows[0]?.balance, 100);
  });
});

dbTest('postgres adapter: nested transactions use savepoints', async () => {
  await withDb(async (db) => {
    await db.transaction(async (outer) => {
      await outer.query(`UPDATE ${TABLE} SET balance = balance - 10 WHERE email = $1`, ['alice@example.com']);
      try {
        await db.transaction(async (inner) => {
          await inner.query(`UPDATE ${TABLE} SET balance = balance - 20 WHERE email = $1`, ['alice@example.com']);
          throw new Error('inner failure');
        });
      } catch {
        // The inner savepoint rolls back; the outer transaction continues.
      }
    });
    const rows = await db.query(`SELECT balance FROM ${TABLE}`);
    assert.equal(rows.rows[0]?.balance, 90, 'outer -10 committed, inner -20 reverted');
  });
});

dbTest('postgres adapter: concurrent transactions get isolated connections', async () => {
  await withDb(async (db) => {
    const [first, second] = await Promise.allSettled([
      db.transaction(async (tx) => {
        await tx.query(`UPDATE ${TABLE} SET balance = balance - 1 WHERE email = $1`, ['alice@example.com']);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'T1';
      }),
      db.transaction(async (tx) => {
        await tx.query(`UPDATE ${TABLE} SET balance = balance - 2 WHERE email = $1`, ['alice@example.com']);
        throw new Error('T2 failure');
      }),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    const rows = await db.query(`SELECT balance FROM ${TABLE}`);
    assert.equal(rows.rows[0]?.balance, 99, 'only the committed transaction changed the row');
  });
});

dbTest('postgres adapter: transaction executor cannot be leaked', async () => {
  await withDb(async (db) => {
    let leaked;
    await db.transaction(async (tx) => {
      leaked = tx;
      await tx.query('SELECT 1');
    });
    await assert.rejects(() => leaked.query('SELECT 1'), /no longer active/);
  });
});

dbTest('postgres adapter: aborted signal rejects before any query', async () => {
  await withDb(async (db) => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(() => db.query('SELECT 1', [], { signal: controller.signal }), /cancelled/);
  });
});

dbTest('postgres adapter: lifecycle guards and idempotent close', async () => {
  const adapter = new PostgresAdapter({ connectionString: URL });
  const db = new Database(adapter);
  await assert.rejects(() => db.query('SELECT 1'), DatabaseLifecycleError);
  await db.connect();
  await db.close();
  await db.close();
  await assert.rejects(() => db.query('SELECT 1'), DatabaseLifecycleError);
});

dbTest('postgres adapter: rejects invalid pool limits', () => {
  assert.throws(() => new PostgresAdapter({ connectionString: URL, pool: { max: 0 } }), TypeError);
  assert.throws(() => new PostgresAdapter({ connectionString: URL, port: 70000 }), TypeError);
  assert.throws(() => new PostgresAdapter({}), TypeError);
});

dbTest('postgres migrations: apply once, skip on rerun, detect tampering', async () => {
  const db = new Database(new PostgresAdapter({ connectionString: URL, pool: { max: 4 } }));
  await db.connect();
  const ledger = 'sveltex_pg_mig_it';
  const target = 'sveltex_pg_mig_users';
  try {
    await db.query(`DROP TABLE IF EXISTS ${ledger}`);
    await db.query(`DROP TABLE IF EXISTS ${target}`);
    const migrations = [{ id: '001_users', up: [`CREATE TABLE ${target} (id SERIAL PRIMARY KEY, email TEXT)`] }];
    const runner = new MigrationRunner(db, migrations, { dialect: createMigrationDialect('postgres'), table: ledger });
    const first = await runner.run();
    assert.deepEqual([...first.applied], ['001_users']);
    const second = await runner.run();
    assert.deepEqual([...second.applied], []);
    assert.deepEqual([...second.skipped], ['001_users']);
    await db.query(`UPDATE ${ledger} SET checksum = 'tampered' WHERE id = '001_users'`);
    await assert.rejects(() => runner.run(), /checksum/);
  } finally {
    await db.query(`DROP TABLE IF EXISTS ${ledger}`).catch(() => undefined);
    await db.query(`DROP TABLE IF EXISTS ${target}`).catch(() => undefined);
    await db.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Database, DatabaseLifecycleError, DatabaseDriverError } from '../dist/index.js';
import { SqliteAdapter } from '../dist/sqlite.js';

/** Helper: create a connected in-memory database with a test schema. */
async function createTestDb() {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const db = new Database(adapter);
  await db.connect();
  await db.query('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0)');
  return db;
}

test('sqlite adapter: connects and creates a table', async () => {
  const db = await createTestDb();
  await db.query("INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice')");
  const result = await db.query('SELECT id, email, name FROM users');
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]?.email, 'alice@example.com');
  assert.equal(result.rows[0]?.name, 'Alice');
  await db.close();
});

test('sqlite adapter: parameterized queries prevent SQL injection', async () => {
  const db = await createTestDb();
  await db.query("INSERT INTO users (email, name) VALUES ('bob@example.com', 'Bob')");
  // Malicious input should be treated as a literal value
  const result = await db.query('SELECT * FROM users WHERE email = ?', ["' OR '1'='1"]);
  assert.equal(result.rowCount, 0);
  // Normal input works
  const valid = await db.query('SELECT * FROM users WHERE email = ?', ['bob@example.com']);
  assert.equal(valid.rowCount, 1);
  await db.close();
});

test('sqlite adapter: transaction commits on success', async () => {
  const db = await createTestDb();
  await db.query("INSERT INTO users (email, name, balance) VALUES ('alice@example.com', 'Alice', 100)");
  await db.transaction(async tx => {
    await tx.query('UPDATE users SET balance = balance - 50 WHERE email = ?', ['alice@example.com']);
  });
  const result = await db.query('SELECT balance FROM users WHERE email = ?', ['alice@example.com']);
  assert.equal(result.rows[0]?.balance, 50);
  await db.close();
});

test('sqlite adapter: transaction rolls back on failure', async () => {
  const db = await createTestDb();
  await db.query("INSERT INTO users (email, name, balance) VALUES ('alice@example.com', 'Alice', 100)");
  const expected = new Error('domain failure');
  await assert.rejects(
    () => db.transaction(async tx => {
      await tx.query('UPDATE users SET balance = balance - 50 WHERE email = ?', ['alice@example.com']);
      throw expected;
    }),
    error => error === expected,
  );
  const result = await db.query('SELECT balance FROM users WHERE email = ?', ['alice@example.com']);
  assert.equal(result.rows[0]?.balance, 100, 'Balance should be unchanged after rollback');
  await db.close();
});

test('sqlite adapter: transaction executor cannot be used after completion', async () => {
  const db = await createTestDb();
  let leaked;
  await db.transaction(async tx => {
    leaked = tx;
    await tx.query('SELECT 1');
  });
  assert.ok(leaked);
  await assert.rejects(() => leaked.query('SELECT 1'), /no longer active/);
  await db.close();
});

test('sqlite adapter: handles multiple concurrent queries', async () => {
  const db = await createTestDb();
  const emails = ['a@ex.com', 'b@ex.com', 'c@ex.com', 'd@ex.com', 'e@ex.com'];
  for (const email of emails) {
    await db.query('INSERT INTO users (email, name) VALUES (?, ?)', [email, email.toUpperCase()]);
  }
  const results = await Promise.all(
    emails.map(email => db.query('SELECT name FROM users WHERE email = ?', [email])),
  );
  for (let i = 0; i < emails.length; i++) {
    assert.equal(results[i].rows[0]?.name, emails[i].toUpperCase());
  }
  await db.close();
});

test('sqlite adapter: supports bigint and Date parameters', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const db = new Database(adapter);
  await db.connect();
  await db.query('CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, count TEXT NOT NULL)');
  const now = new Date('2026-01-15T12:00:00.000Z');
  const bigCount = BigInt(9007199254740993);
  await db.query('INSERT INTO events (ts, count) VALUES (?, ?)', [now, bigCount]);
  const result = await db.query('SELECT ts, count FROM events');
  assert.equal(result.rows[0]?.ts, now.toISOString());
  assert.equal(result.rows[0]?.count, bigCount.toString());
  await db.close();
});

test('sqlite adapter: supports Uint8Array parameters', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const db = new Database(adapter);
  await db.connect();
  await db.query('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)');
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  await db.query('INSERT INTO blobs (data) VALUES (?)', [data]);
  const result = await db.query('SELECT data FROM blobs');
  const stored = result.rows[0]?.data;
  assert.ok(stored instanceof Uint8Array || Buffer.isBuffer(stored));
  const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
  await db.close();
});

test('sqlite adapter: rejects operations before connect', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const db = new Database(adapter);
  await assert.rejects(() => db.query('SELECT 1'), DatabaseLifecycleError);
  await db.close();
});

test('sqlite adapter: rejects operations after close', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const db = new Database(adapter);
  await db.connect();
  await db.close();
  await assert.rejects(() => db.query('SELECT 1'), DatabaseLifecycleError);
});

test('sqlite adapter: close is idempotent', async () => {
  const adapter = new SqliteAdapter({ path: ':memory:' });
  const db = new Database(adapter);
  await db.connect();
  await db.close();
  await db.close(); // should not throw
});

test('sqlite adapter: readonly mode', async () => {
  // Create a file database first
  const tmpDir = '/tmp/sveltex-test-' + Date.now();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(tmpDir, { recursive: true });
  const dbPath = `${tmpDir}/test.db`;

  // Write data
  const writeAdapter = new SqliteAdapter({ path: dbPath });
  const writeDb = new Database(writeAdapter);
  await writeDb.connect();
  await writeDb.query('CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT)');
  await writeDb.query("INSERT INTO data (value) VALUES ('hello')");
  await writeDb.close();

  // Read readonly
  const roAdapter = new SqliteAdapter({ path: dbPath, readonly: true });
  const roDb = new Database(roAdapter);
  await roDb.connect();
  const result = await roDb.query('SELECT value FROM data');
  assert.equal(result.rows[0]?.value, 'hello');
  await assert.rejects(() => roDb.query("INSERT INTO data (value) VALUES ('write-attempt')"));
  await roDb.close();

  // Cleanup
  const { rmSync } = await import('node:fs');
  rmSync(tmpDir, { recursive: true, force: true });
});

test('sqlite adapter: WAL mode can be enabled', async () => {
  const tmpDir = '/tmp/sveltex-wal-test-' + Date.now();
  const { mkdirSync, rmSync } = await import('node:fs');
  mkdirSync(tmpDir, { recursive: true });
  const dbPath = `${tmpDir}/test.db`;

  const adapter = new SqliteAdapter({ path: dbPath, wal: true });
  const db = new Database(adapter);
  await db.connect();
  await db.query('CREATE TABLE test (id INTEGER PRIMARY KEY)');
  await db.query('INSERT INTO test DEFAULT VALUES');
  const result = await db.query('PRAGMA journal_mode');
  assert.equal(result.rows[0]?.journal_mode.toLowerCase(), 'wal');
  await db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('sqlite adapter: requires non-empty path', () => {
  assert.throws(() => new SqliteAdapter({ path: '' }), TypeError);
  assert.throws(() => new SqliteAdapter({}), TypeError);
});

test('sqlite adapter: nested transactions via savepoints', async () => {
  const db = await createTestDb();
  await db.query("INSERT INTO users (email, name, balance) VALUES ('alice@example.com', 'Alice', 100)");

  await db.transaction(async outer => {
    await outer.query('UPDATE users SET balance = balance - 10 WHERE email = ?', ['alice@example.com']);
    // Inner savepoint
    try {
      await db.transaction(async inner => {
        await inner.query('UPDATE users SET balance = balance - 20 WHERE email = ?', ['alice@example.com']);
        throw new Error('inner failure');
      });
    } catch {
      // Expected
    }
  });

  const result = await db.query('SELECT balance FROM users WHERE email = ?', ['alice@example.com']);
  // Outer committed (-10), inner rolled back (-20 reverted) => 90
  assert.equal(result.rows[0]?.balance, 90);
  await db.close();
});

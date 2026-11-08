import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../dist/index.js';
import { MigrationRunner, createMigrationDialect, migrationChecksum } from '../../dist/migrations.js';
import { PostgresAdapter } from '../../dist/postgres.js';
import { MysqlAdapter } from '../../dist/mysql.js';
import { SqliteAdapter } from '../../dist/sqlite.js';
import { resolvePoolConfig } from '../../dist/pool.js';

function fakeDatabase() {
  return new Database({
    async connect() {},
    async disconnect() {},
    async query() { return { rows: [], rowCount: 0 }; },
    async transaction(fn) { return fn({ query: async () => ({ rows: [], rowCount: 0 }) }); },
  });
}

test('rejects unsafe query values before driver execution', async () => {
  let calls = 0;
  const db = new Database({
    async connect() {}, async disconnect() {},
    async query() { calls++; return { rows: [], rowCount: 0 }; },
    async transaction(fn) { return fn(this); },
  });
  await db.connect();
  await assert.rejects(() => db.query('select ?', [NaN]));
  assert.equal(calls, 0);
});

test('SEC: migration ledger rejects SQL-injection-shaped table names', () => {
  const db = fakeDatabase();
  for (const table of ['x; DROP TABLE users', 'x)--', '1bad', 'a b', '', 'x.y', 'x"']) {
    assert.throws(
      () => new MigrationRunner(db, [], { dialect: createMigrationDialect('sqlite'), table }),
      TypeError,
    );
  }
});

test('SEC: unknown dialects and malformed migration sets are rejected', () => {
  const db = fakeDatabase();
  assert.throws(() => createMigrationDialect('mongodb'), /Unknown migration dialect/);
  assert.throws(() => new MigrationRunner(db, [], {}), TypeError);
  assert.throws(() => new MigrationRunner(null, [], { dialect: createMigrationDialect('sqlite') }), TypeError);
  assert.throws(() => new MigrationRunner(db, [{ id: '../escape', up: ['SELECT 1'] }], { dialect: createMigrationDialect('sqlite') }), TypeError);
  assert.throws(() => new MigrationRunner(db, [{ id: '001', up: [''] }], { dialect: createMigrationDialect('sqlite') }), TypeError);
  assert.throws(() => new MigrationRunner(db, [
    { id: '001', up: ['SELECT 1'] },
    { id: '001', up: ['SELECT 2'] },
  ], { dialect: createMigrationDialect('sqlite') }), /Duplicate/);
});

test('SEC: migration checksum covers the full SQL body', () => {
  const base = { id: '001', up: ['CREATE TABLE t (id INT)'] };
  const tampered = { id: '001', up: ['CREATE TABLE t (id INT); DROP TABLE users'] };
  assert.notEqual(migrationChecksum(base), migrationChecksum(tampered));
  assert.notEqual(migrationChecksum(base), migrationChecksum({ id: '002', up: base.up }));
});

test('SEC: adapters require explicit connection targets and valid ports', () => {
  assert.throws(() => new PostgresAdapter({}), TypeError);
  assert.throws(() => new MysqlAdapter({}), TypeError);
  assert.throws(() => new PostgresAdapter({ host: '127.0.0.1', port: 99999 }), TypeError);
  assert.throws(() => new MysqlAdapter({ host: '127.0.0.1', port: -1 }), TypeError);
  assert.throws(() => new PostgresAdapter(null), TypeError);
});

test('SEC: pool limits reject non-numeric and oversized values', () => {
  for (const value of ['10; DROP', '4', {}, 0, -1, 1.5, 1001]) {
    assert.throws(() => resolvePoolConfig({ max: value }), TypeError);
  }
  assert.throws(() => resolvePoolConfig({ idleTimeoutMs: 'fast' }), TypeError);
});

test('SEC: sqlite adapter binds parameters instead of interpolating them', async () => {
  const db = new Database(new SqliteAdapter({ path: ':memory:' }));
  await db.connect();
  try {
    await db.query('CREATE TABLE users (email TEXT)');
    await db.query('INSERT INTO users (email) VALUES (?)', ['alice@example.com']);
    const attack = await db.query('SELECT email FROM users WHERE email = ?', ["' OR '1'='1"]);
    assert.equal(attack.rowCount, 0);
    const normal = await db.query('SELECT email FROM users WHERE email = ?', ['alice@example.com']);
    assert.equal(normal.rowCount, 1);
  } finally {
    await db.close();
  }
});

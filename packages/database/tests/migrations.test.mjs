import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../dist/index.js';
import { SqliteAdapter } from '../dist/sqlite.js';
import {
  MigrationRunner,
  MIGRATION_DIALECTS,
  createMigrationDialect,
  migrationChecksum,
} from '../dist/migrations.js';

async function makeDb() {
  const db = new Database(new SqliteAdapter({ path: ':memory:' }));
  await db.connect();
  return db;
}

function runner(db, migrations, table = 'sveltex_migrations') {
  return new MigrationRunner(db, migrations, { dialect: createMigrationDialect('sqlite'), table });
}

test('migrations: applies in order and is idempotent', async () => {
  const db = await makeDb();
  try {
    const migrations = [
      { id: '001_users', up: ['CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)'] },
      { id: '002_posts', up: ['CREATE TABLE posts (id INTEGER PRIMARY KEY)'] },
    ];
    const first = await runner(db, migrations).run();
    assert.deepEqual([...first.applied], ['001_users', '002_posts']);
    assert.deepEqual([...first.skipped], []);
    assert.equal(first.table, 'sveltex_migrations');

    const second = await runner(db, migrations).run();
    assert.deepEqual([...second.applied], []);
    assert.deepEqual([...second.skipped], ['001_users', '002_posts']);

    const ledger = await db.query('SELECT id, checksum FROM sveltex_migrations ORDER BY position ASC');
    assert.equal(ledger.rowCount, 2);
    assert.equal(ledger.rows[0]?.id, '001_users');
  } finally {
    await db.close();
  }
});

test('migrations: supports a custom, validated ledger table and multiple statements', async () => {
  const db = await makeDb();
  try {
    const result = await runner(db, [
      { id: '001_seed', up: ['CREATE TABLE seed (id INTEGER PRIMARY KEY, v TEXT)', "INSERT INTO seed (v) VALUES ('a')", "INSERT INTO seed (v) VALUES ('b')"] },
    ], 'app_migrations').run();
    assert.deepEqual([...result.applied], ['001_seed']);
    assert.equal(result.table, 'app_migrations');
    const rows = await db.query('SELECT v FROM seed');
    assert.equal(rows.rowCount, 2);
  } finally {
    await db.close();
  }
});

test('migrations: detects a modified checksum', async () => {
  const db = await makeDb();
  try {
    const original = [{ id: '001', up: ['CREATE TABLE x (id INTEGER)'] }];
    await runner(db, original).run();
    const edited = [{ id: '001', up: ['CREATE TABLE x (id INTEGER, extra TEXT)'] }];
    await assert.rejects(() => runner(db, edited).run(), /checksum/);
  } finally {
    await db.close();
  }
});

test('migrations: rejects an applied set that is no longer a prefix', async () => {
  const db = await makeDb();
  try {
    await runner(db, [
      { id: '001', up: ['CREATE TABLE a (id INTEGER)'] },
      { id: '002', up: ['CREATE TABLE b (id INTEGER)'] },
    ]).run();
    await assert.rejects(() => runner(db, [
      { id: '000', up: ['CREATE TABLE c (id INTEGER)'] },
      { id: '001', up: ['CREATE TABLE a (id INTEGER)'] },
      { id: '002', up: ['CREATE TABLE b (id INTEGER)'] },
    ]).run(), /prefix/);
  } finally {
    await db.close();
  }
});

test('migrations: rolls back a failed migration completely', async () => {
  const db = await makeDb();
  try {
    await assert.rejects(() => runner(db, [
      { id: '001_partial', up: ["CREATE TABLE partial (id INTEGER)", "INSERT INTO partial (id) VALUES (1)", 'THIS IS NOT SQL'] },
    ]).run());
    const ledger = await db.query('SELECT id FROM sveltex_migrations');
    assert.equal(ledger.rowCount, 0, 'no ledger row for a failed migration');
    const tables = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'");
    assert.equal(tables.rowCount, 0, 'DDL from the failed migration was rolled back');
  } finally {
    await db.close();
  }
});

test('migrations: rejects duplicate and invalid migration definitions', async () => {
  const db = await makeDb();
  try {
    assert.throws(() => runner(db, [
      { id: '001', up: ['SELECT 1'] },
      { id: '001', up: ['SELECT 2'] },
    ]), /Duplicate/);
    assert.throws(() => runner(db, [{ id: '../evil', up: ['SELECT 1'] }]), TypeError);
    assert.throws(() => runner(db, [{ id: '001', up: [] }]), TypeError);
    assert.throws(() => runner(db, [{ id: '001', up: ['   '] }]), TypeError);
    assert.throws(() => new MigrationRunner(db, 'not-an-array', { dialect: createMigrationDialect('sqlite') }), TypeError);
    assert.throws(() => new MigrationRunner({}, [], { dialect: createMigrationDialect('sqlite') }), TypeError);
  } finally {
    await db.close();
  }
});

test('migrations: rejects unsafe table names and unknown dialects', async () => {
  const db = await makeDb();
  try {
    assert.throws(() => new MigrationRunner(db, [], { dialect: createMigrationDialect('sqlite'), table: 'x; DROP TABLE users' }), TypeError);
    assert.throws(() => new MigrationRunner(db, [], { dialect: createMigrationDialect('sqlite'), table: '1bad' }), TypeError);
    assert.throws(() => createMigrationDialect('oracle'), /Unknown migration dialect/);
    assert.throws(() => new MigrationRunner(db, [], {}), TypeError);
  } finally {
    await db.close();
  }
});

test('migrations: built-in dialects and checksums are stable', () => {
  assert.deepEqual(Object.keys(MIGRATION_DIALECTS).sort(), ['mysql', 'postgres', 'sqlite']);
  for (const kind of ['sqlite', 'postgres', 'mysql']) {
    assert.equal(createMigrationDialect(kind).kind, kind);
  }
  const migration = { id: '001', up: ['CREATE TABLE a (id INT)'] };
  assert.equal(migrationChecksum(migration), migrationChecksum(migration));
  assert.notEqual(
    migrationChecksum(migration),
    migrationChecksum({ id: '001', up: ['CREATE TABLE a (id INT, extra TEXT)'] }),
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../dist/index.js';
import { SqliteAdapter } from '../dist/sqlite.js';
import { DEFAULT_POOL_CONFIG, resolvePoolConfig, withTimeout, assertNotAborted } from '../dist/pool.js';

test('pool config: defaults are frozen and complete', () => {
  const resolved = resolvePoolConfig(undefined);
  assert.deepEqual(
    { ...resolved },
    { ...DEFAULT_POOL_CONFIG },
  );
  assert.ok(Object.isFrozen(resolved));
});

test('pool config: accepts explicit limits', () => {
  const resolved = resolvePoolConfig({ max: 3, idleTimeoutMs: 100, connectionTimeoutMs: 200, acquireTimeoutMs: 300 });
  assert.equal(resolved.max, 3);
  assert.equal(resolved.idleTimeoutMs, 100);
  assert.equal(resolved.connectionTimeoutMs, 200);
  assert.equal(resolved.acquireTimeoutMs, 300);
});

test('pool config: rejects non-positive, non-integer, and oversized limits', () => {
  for (const value of [0, -1, 1.5, Number.NaN, 1001]) {
    assert.throws(() => resolvePoolConfig({ max: value }), TypeError);
  }
  for (const value of [0, -5, 2.25]) {
    assert.throws(() => resolvePoolConfig({ idleTimeoutMs: value }), TypeError);
  }
  assert.throws(() => resolvePoolConfig('fast'), TypeError);
});

test('withTimeout: resolves a fast operation', async () => {
  const value = await withTimeout(Promise.resolve('ok'), 1000, 'probe');
  assert.equal(value, 'ok');
});

test('withTimeout: rejects a slow operation and releases the late result', async () => {
  let late;
  const work = new Promise((resolve) => setTimeout(() => resolve('late'), 40));
  await assert.rejects(() => withTimeout(work, 5, 'probe', (value) => { late = value; }), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(late, 'late');
});

test('assertNotAborted: aborted signals surface their reason', () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled by caller'));
  assert.throws(() => assertNotAborted(controller.signal), /cancelled by caller/);
  assert.doesNotThrow(() => assertNotAborted(undefined));
  assert.doesNotThrow(() => assertNotAborted(new AbortController().signal));
});

test('sqlite adapter: rowCount reports affected rows for write statements', async () => {
  const db = new Database(new SqliteAdapter({ path: ':memory:' }));
  await db.connect();
  try {
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = await db.query('INSERT INTO t (v) VALUES (?)', ['a']);
    assert.equal(insert.rowCount, 1, 'plain INSERT no longer reports 0');
    const update = await db.query('UPDATE t SET v = ? WHERE id = ?', ['b', 1]);
    assert.equal(update.rowCount, 1, 'plain UPDATE no longer reports 0');
    const emptySelect = await db.query('SELECT * FROM t WHERE v = ?', ['missing']);
    assert.equal(emptySelect.rowCount, 0, 'a SELECT with no rows does not inherit prior changes()');
    const select = await db.query('SELECT * FROM t');
    assert.equal(select.rowCount, 1);
    const remove = await db.query('DELETE FROM t WHERE id = ?', [1]);
    assert.equal(remove.rowCount, 1);
    assert.equal((await db.query('SELECT * FROM t')).rowCount, 0);
  } finally {
    await db.close();
  }
});

test('sqlite adapter: rowCount is correct inside transactions', async () => {
  const db = new Database(new SqliteAdapter({ path: ':memory:' }));
  await db.connect();
  try {
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await db.transaction(async (tx) => {
      assert.equal((await tx.query('INSERT INTO t (v) VALUES (?)', ['a'])).rowCount, 1);
      assert.equal((await tx.query('SELECT * FROM t')).rowCount, 1);
    });
    assert.equal((await db.query('SELECT * FROM t')).rowCount, 1);
  } finally {
    await db.close();
  }
});

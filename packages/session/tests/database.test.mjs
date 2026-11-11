import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@sveltex/database';
import { SqliteAdapter } from '@sveltex/database/sqlite';
import { PostgresAdapter } from '@sveltex/database/postgres';
import { MysqlAdapter } from '@sveltex/database/mysql';
import { DatabaseSessionStore } from '../dist/database.js';
import { SessionManager, SessionConflictError } from '../dist/index.js';

const PG_URL = process.env.SVELTEX_TEST_POSTGRES_URL ?? 'postgresql://sveltex:sveltex_test_pw@127.0.0.1:5432/sveltex_test';
const MYSQL_URL = process.env.SVELTEX_TEST_MYSQL_URL ?? 'mysql://sveltex:sveltex_test_pw@127.0.0.1:3306/sveltex_test';
const RUN = `p3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Minimal recording executor — used only for SQL-rendering / constructor validation. */
function recordingExecutor() {
  const statements = [];
  const executor = {
    query: async (sql) => { statements.push(sql); return { rows: [], rowCount: 1 }; },
    transaction: async (callback) => callback(executor),
  };
  return { executor, statements };
}

function record(id, now = Date.now()) {
  return { id, data: { userId: 'u1' }, createdAt: now - 1000, expiresAt: now + 60_000, revision: 1 };
}

async function open(dialect) {
  if (dialect === 'sqlite') {
    const db = new Database(new SqliteAdapter({ path: ':memory:' }));
    await db.connect();
    return { db, dialect, table: `${RUN}_sqlite` };
  }
  if (dialect === 'postgres') {
    const db = new Database(new PostgresAdapter({ connectionString: PG_URL }));
    await db.connect();
    return { db, dialect, table: `${RUN}_pg` };
  }
  const db = new Database(new MysqlAdapter({ uri: MYSQL_URL }));
  await db.connect();
  return { db, dialect, table: `${RUN}_mysql` };
}

async function withStore(t, dialect, fn) {
  let ctx;
  try { ctx = await open(dialect); }
  catch (cause) { t.skip(`${dialect} is not available (${cause.message})`); return; }
  try { await fn(ctx); }
  finally {
    try { await ctx.db.query(`DROP TABLE IF EXISTS ${ctx.table}`); } catch { /* best effort */ }
    try { await ctx.db.close(); } catch { /* best effort */ }
  }
}

function makeSession(ctx, options = {}) {
  const now = options.now ?? (() => Date.now());
  const store = new DatabaseSessionStore(ctx.db, { dialect: ctx.dialect, tableName: ctx.table, now });
  const manager = new SessionManager(store, { now, ttlMs: 60_000, ...options.manager });
  return { store, manager, now };
}

// ---------------------------------------------------------------------------
// Real SQLite integration (always runs — no external service required)
// ---------------------------------------------------------------------------

test('sqlite: schemaStatements exposes portable DDL', () => {
  const { executor } = recordingExecutor();
  const statements = new DatabaseSessionStore(executor, { dialect: 'sqlite' }).schemaStatements();
  assert.equal(statements.length, 1);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS sveltex_sessions/);
  assert.match(statements[0], /user_id VARCHAR\(255\)/);
  assert.equal(Object.isFrozen(statements), true);
});

test('sqlite: full lifecycle — create, get, update, rotate, destroy', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { manager } = makeSession(ctx);
    const created = await manager.create({ userId: 'u1', role: 'admin' });
    assert.equal(created.revision, 1);
    assert.equal((await manager.get(created.id))?.data.role, 'admin');
    const updated = await manager.update(created.id, d => ({ ...d, role: 'root' }));
    assert.equal(updated.revision, 2);
    assert.equal(updated.data.role, 'root');
    const rotated = await manager.rotate(created.id);
    assert.notEqual(rotated.id, created.id);
    assert.equal(await manager.get(created.id), undefined);
    assert.equal((await manager.get(rotated.id))?.data.userId, 'u1');
    await manager.destroy(rotated.id);
    assert.equal(await manager.get(rotated.id), undefined);
  });
});

test('sqlite: session data is deeply cloned and frozen at the store boundary', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { manager } = makeSession(ctx);
    const input = { profile: { roles: ['user'] } };
    const created = await manager.create(input);
    input.profile.roles.push('admin');
    const read = await manager.get(created.id);
    assert.deepEqual(read.data.profile.roles, ['user']);
    assert.equal(Object.isFrozen(read.data.profile.roles), true);
  });
});

test('sqlite: createIfAbsent is atomic — only one concurrent insert of the same id wins', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { store } = makeSession(ctx);
    const rec = record('session_db_concurrent_0001');
    const results = await Promise.all(Array.from({ length: 8 }, () => store.createIfAbsent(rec)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await store.get(rec.id))?.revision, 1);
  });
});

test('sqlite: compareAndSet rejects a stale revision (no lost concurrent update)', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { store, manager } = makeSession(ctx);
    const created = await manager.create({ count: 0 });
    const [a, b] = await Promise.all([manager.get(created.id), manager.get(created.id)]);
    assert.equal(a.revision, b.revision);
    const next = { ...a, data: { count: 1 }, expiresAt: Date.now() + 60_000, revision: 2 };
    const [r1, r2] = await Promise.all([
      store.compareAndSet(created.id, a.revision, next),
      store.compareAndSet(created.id, b.revision, next),
    ]);
    assert.equal([r1, r2].filter(Boolean).length, 1);
    assert.equal((await manager.get(created.id)).data.count, 1);
  });
});

test('sqlite: a losing compare-and-set surfaces as SessionConflictError', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { store, manager } = makeSession(ctx);
    const created = await manager.create({ n: 0 });
    const losing = {
      get: id => store.get(id),
      createIfAbsent: r => store.createIfAbsent(r),
      compareAndSet: async () => false,
      delete: id => store.delete(id),
      rotate: (id, rev, r) => store.rotate(id, rev, r),
    };
    const conflicting = new SessionManager(losing, { now: () => Date.now(), ttlMs: 60_000 });
    await assert.rejects(() => conflicting.update(created.id, d => ({ ...d, n: 1 })), SessionConflictError);
  });
});

test('sqlite: expired records are purged on read', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    let now = 1000;
    const { store, manager } = makeSession(ctx, { now: () => now });
    const created = await manager.create({ userId: 'u1' });
    now = created.expiresAt + 1;
    assert.equal(await manager.get(created.id), undefined);
    assert.equal(await store.get(created.id), undefined);
    const result = await ctx.db.query(`SELECT COUNT(*) AS c FROM ${ctx.table}`);
    assert.equal(Number(result.rows[0].c), 0);
  });
});

test('sqlite: corrupt / tampered payloads are rejected and deleted', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { store } = makeSession(ctx);
    await store.ensureSchema();
    const now = Date.now();
    const id = 'session_db_corrupt_000001';
    await ctx.db.query(
      `INSERT INTO ${ctx.table} (id, payload, user_id, created_at, expires_at, revision) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, '{not json', 'u1', now - 1000, now + 60_000, 1],
    );
    assert.equal(await store.get(id), undefined);
    const result = await ctx.db.query(`SELECT COUNT(*) AS c FROM ${ctx.table} WHERE id = ?`, [id]);
    assert.equal(Number(result.rows[0].c), 0);
  });
});

test('sqlite: revokeAllForUser removes only that user\'s sessions', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { manager } = makeSession(ctx);
    const a = await manager.create({ userId: 'alice' });
    const b = await manager.create({ userId: 'bob' });
    const c = await manager.create({ userId: 'alice' });
    assert.equal(await manager.revokeAllForUser('alice'), 2);
    assert.equal(await manager.get(a.id), undefined);
    assert.equal((await manager.get(b.id))?.data.userId, 'bob');
    assert.equal(await manager.get(c.id), undefined);
  });
});

test('sqlite: purgeExpired removes logically expired rows', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    let now = 1000;
    const { store, manager } = makeSession(ctx, { now: () => now });
    await manager.create({ userId: 'u1' });
    now = 1_000_000;
    assert.equal(await store.purgeExpired(), 1);
    assert.equal(await store.purgeExpired(), 0);
  });
});

test('sqlite: store failure after database shutdown propagates (no fabricated session)', async (t) => {
  const ctx = await open('sqlite');
  const { manager } = makeSession(ctx);
  const created = await manager.create({ userId: 'u1' });
  await ctx.db.close();
  await assert.rejects(() => manager.get(created.id), Error);
  await assert.rejects(() => manager.create({ userId: 'u2' }), Error);
});

test('sqlite: rotate inside a transaction leaves no orphan new id on failure', async (t) => {
  await withStore(t, 'sqlite', async (ctx) => {
    const { manager, store } = makeSession(ctx);
    const created = await manager.create({ userId: 'u1' });
    // A stale expected revision must fail cleanly without inserting the new record.
    const now = Date.now();
    const next = { id: 'session_db_rotate_stale_01', data: { userId: 'u1' }, createdAt: now - 1000, expiresAt: now + 60_000, revision: 99 };
    assert.equal(await store.rotate(created.id, 999, next), false);
    assert.equal(await store.get(next.id), undefined);
    assert.equal((await manager.get(created.id))?.revision, 1);
  });
});

// ---------------------------------------------------------------------------
// Placeholder rendering and constructor validation (no service needed)
// ---------------------------------------------------------------------------

test('postgres rendering converts every ? into $1..$n', async () => {
  const { executor, statements } = recordingExecutor();
  const store = new DatabaseSessionStore(executor, { dialect: 'postgres' });
  await store.createIfAbsent(record('session_db_render_000001'));
  const insert = statements.find(s => s.includes('INSERT INTO'));
  assert.ok(insert);
  assert.match(insert, /\$1/);
  assert.match(insert, /\$7/);
  assert.equal(insert.includes('?'), false);
});

test('mysql rendering uses ? and FROM DUAL', async () => {
  const { executor, statements } = recordingExecutor();
  const store = new DatabaseSessionStore(executor, { dialect: 'mysql' });
  await store.createIfAbsent(record('session_db_render_000002'));
  const insert = statements.find(s => s.includes('INSERT INTO'));
  assert.ok(insert);
  assert.match(insert, /FROM DUAL/);
  assert.match(insert, /\?/);
});

test('constructor rejects SQL-injection-shaped table names and bad dialects', () => {
  const { executor } = recordingExecutor();
  assert.throws(() => new DatabaseSessionStore(executor, { tableName: 'sessions; DROP TABLE users' }), TypeError);
  assert.throws(() => new DatabaseSessionStore(executor, { tableName: '1bad' }), TypeError);
  assert.throws(() => new DatabaseSessionStore(executor, { dialect: 'oracle' }), TypeError);
  assert.throws(() => new DatabaseSessionStore({ query: async () => ({ rows: [], rowCount: 0 }) }), TypeError);
  assert.throws(() => new DatabaseSessionStore(executor, { now: 'no' }), TypeError);
});

test('revokeAllForUser validates its userId', async () => {
  const { executor } = recordingExecutor();
  const store = new DatabaseSessionStore(executor);
  await assert.rejects(() => store.revokeAllForUser(''), TypeError);
  await assert.rejects(() => store.revokeAllForUser('x'.repeat(256)), TypeError);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL / MySQL integration (skipped honestly when unavailable)
// ---------------------------------------------------------------------------

for (const dialect of ['postgres', 'mysql']) {
  test(`${dialect}: full lifecycle against a real server`, async (t) => {
    await withStore(t, dialect, async (ctx) => {
      const { manager } = makeSession(ctx);
      const created = await manager.create({ userId: `${dialect}-user`, role: 'admin' });
      assert.equal((await manager.get(created.id))?.data.role, 'admin');
      const updated = await manager.update(created.id, d => ({ ...d, role: 'root' }));
      assert.equal(updated.revision, 2);
      const rotated = await manager.rotate(created.id);
      assert.notEqual(rotated.id, created.id);
      assert.equal(await manager.get(created.id), undefined);
      assert.equal(await manager.revokeAllForUser(`${dialect}-user`), 1);
      assert.equal(await manager.get(rotated.id), undefined);
    });
  });
}

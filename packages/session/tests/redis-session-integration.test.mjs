import test from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { SessionManager } from '../dist/index.js';
import { RedisSessionStore } from '../dist/redis.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const RUN = `sveltex-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// A single memoized readiness probe — concurrent node:test files must not each
// open their own probe connection (that is what kept the event loop alive before).
let readyPromise = null;
function redisReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      let probe;
      try {
        probe = new RedisSessionStore({ url: REDIS_URL, keyPrefix: `${RUN}:probe:` });
        await probe.connect();
        const id = 'session_probe_identifier_0001';
        const now = Date.now();
        const ok = await probe.createIfAbsent({ id, data: { ok: true }, createdAt: now, expiresAt: now + 60_000, revision: 1 });
        assert.equal(ok, true);
        assert.equal((await probe.get(id))?.data.ok, true);
        await probe.clear();
        return true;
      } catch {
        return false;
      } finally {
        if (probe) await probe.disconnect();
      }
    })();
  }
  return readyPromise;
}

async function guard(t) {
  if (!(await redisReady())) {
    t.skip('Redis is not available at ' + REDIS_URL);
    return false;
  }
  return true;
}

/** Open a store whose connection is always closed, even if an assertion throws. */
async function open(t, name, extra = {}) {
  const store = new RedisSessionStore({ url: REDIS_URL, keyPrefix: `${RUN}:${name}:`, ...extra });
  await store.connect();
  t.after(async () => {
    try { await store.disconnect(); } catch { /* idempotent */ }
  });
  return store;
}

function record(id, data = {}, revision = 1, ttlMs = 60_000) {
  const now = Date.now();
  return { id, data, createdAt: now, expiresAt: now + ttlMs, revision };
}

// ---------------------------------------------------------------------------
// Atomic primitives (the whole point of a real distributed store)
// ---------------------------------------------------------------------------

test('createIfAbsent inserts once and get returns a frozen deep clone', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'insert');
  const id = 'session_insert_identifier_001';
  assert.equal(await store.createIfAbsent(record(id, { userId: 'u1', profile: { roles: ['user'] } })), true);
  // A second insert of the same id must be rejected (SET-NX semantics).
  assert.equal(await store.createIfAbsent(record(id, { userId: 'other' })), false);
  const got = await store.get(id);
  assert.ok(got);
  assert.equal(got.data.userId, 'u1');
  assert.equal(Object.isFrozen(got), true);
  assert.equal(Object.isFrozen(got.data), true);
  assert.equal(Object.isFrozen(got.data.profile), true);
  assert.equal(Object.isFrozen(got.data.profile.roles), true);
  await store.clear();
});

test('createIfAbsent is atomic across two independent instances (only one wins)', async (t) => {
  if (!(await guard(t))) return;
  const a = await open(t, 'atomic-create');
  const b = await open(t, 'atomic-create'); // same namespace, different connection
  const id = 'session_atomic_create_id_0001';
  const results = await Promise.all([
    a.createIfAbsent(record(id, { owner: 'a' })),
    b.createIfAbsent(record(id, { owner: 'b' })),
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'exactly one insertion must succeed');
  const stored = (await a.get(id)) ?? (await b.get(id));
  assert.ok(stored);
  assert.equal(['a', 'b'].includes(stored.data.owner), true);
  await a.clear();
});

test('get returns undefined for a missing identifier', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'missing');
  assert.equal(await store.get('session_missing_identifier_01'), undefined);
  await store.clear();
});

test('compareAndSet swaps only when the stored revision matches', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'cas');
  const id = 'session_cas_identifier_000001';
  await store.createIfAbsent(record(id, { n: 1 }, 1));
  // Wrong revision is rejected and data is unchanged.
  assert.equal(await store.compareAndSet(id, 7, record(id, { n: 99 }, 8)), false);
  assert.equal((await store.get(id)).data.n, 1);
  // Correct revision succeeds.
  assert.equal(await store.compareAndSet(id, 1, record(id, { n: 2 }, 2)), true);
  assert.equal((await store.get(id)).data.n, 2);
  assert.equal((await store.get(id)).revision, 2);
  await store.clear();
});

test('compareAndSet is atomic under contention (one winner, no lost update)', async (t) => {
  if (!(await guard(t))) return;
  const a = await open(t, 'atomic-cas');
  const b = await open(t, 'atomic-cas');
  const id = 'session_atomic_cas_id_000001';
  await a.createIfAbsent(record(id, { n: 0 }, 1));
  const results = await Promise.all([
    a.compareAndSet(id, 1, record(id, { n: 10 }, 2)),
    b.compareAndSet(id, 1, record(id, { n: 20 }, 2)),
  ]);
  assert.equal(results.filter(Boolean).length, 1, 'only the first CAS at revision 1 may win');
  const final = await a.get(id);
  assert.equal(final.revision, 2);
  assert.equal([10, 20].includes(final.data.n), true);
  await a.clear();
});

test('compareAndSet rejects a record whose id differs from the key', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'cas-id');
  const id = 'session_cas_id_identifier_0001';
  await store.createIfAbsent(record(id, { n: 1 }, 1));
  assert.equal(await store.compareAndSet(id, 1, record('session_other_identifier_0001', { n: 2 }, 2)), false);
  assert.equal((await store.get(id)).data.n, 1);
  await store.clear();
});

test('rotate atomically moves oldId to a new id', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'rotate');
  const oldId = 'session_rotate_old_id_0000001';
  const newId = 'session_rotate_new_id_0000001';
  await store.createIfAbsent(record(oldId, { userId: 'u1' }, 1));
  assert.equal(await store.rotate(oldId, 1, record(newId, { userId: 'u1' }, 2)), true);
  assert.equal(await store.get(oldId), undefined);
  assert.equal((await store.get(newId)).data.userId, 'u1');
  assert.equal((await store.get(newId)).revision, 2);
  await store.clear();
});

test('rotate fails when the new id is already taken (old stays intact)', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'rotate-collision');
  const oldId = 'session_rotate_a_id_000000001';
  const newId = 'session_rotate_b_id_000000001';
  await store.createIfAbsent(record(oldId, { n: 1 }, 1));
  await store.createIfAbsent(record(newId, { n: 2 }, 1));
  assert.equal(await store.rotate(oldId, 1, record(newId, { n: 3 }, 2)), false);
  assert.equal((await store.get(oldId)).data.n, 1);
  assert.equal((await store.get(newId)).data.n, 2);
  await store.clear();
});

test('rotate fails on a revision mismatch', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'rotate-revision');
  const oldId = 'session_rotate_rev_old_id_0001';
  const newId = 'session_rotate_rev_new_id_0001';
  await store.createIfAbsent(record(oldId, { n: 1 }, 1));
  assert.equal(await store.rotate(oldId, 5, record(newId, { n: 1 }, 6)), false);
  assert.equal(await store.get(oldId) !== undefined, true);
  assert.equal(await store.get(newId), undefined);
  await store.clear();
});

test('delete removes the record', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'delete');
  const id = 'session_delete_identifier_00001';
  await store.createIfAbsent(record(id));
  assert.ok(await store.get(id));
  await store.delete(id);
  assert.equal(await store.get(id), undefined);
  await store.clear();
});

// ---------------------------------------------------------------------------
// Namespace safety
// ---------------------------------------------------------------------------

test('keyPrefix isolates namespaces between stores', async (t) => {
  if (!(await guard(t))) return;
  const a = await open(t, 'ns-a');
  const b = await open(t, 'ns-b');
  const id = 'session_namespace_shared_id_01';
  await a.createIfAbsent(record(id, { side: 'a' }));
  assert.equal(await b.get(id), undefined);
  await b.createIfAbsent(record(id, { side: 'b' }));
  assert.equal((await a.get(id)).data.side, 'a');
  assert.equal((await b.get(id)).data.side, 'b');
  await a.clear();
  await b.clear();
});

test('clear() removes only its own namespace (never FLUSHDB)', async (t) => {
  if (!(await guard(t))) return;
  const a = await open(t, 'clear-a');
  const b = await open(t, 'clear-b');
  const idA = 'session_clear_a_identifier_001';
  const idB = 'session_clear_b_identifier_001';
  await a.createIfAbsent(record(idA));
  await b.createIfAbsent(record(idB));
  await a.clear();
  assert.equal(await a.get(idA), undefined);
  assert.ok(await b.get(idB), 'the other namespace must survive clear()');
  await b.clear();
});

test('clear() without a keyPrefix is refused to protect shared instances', async (t) => {
  if (!(await guard(t))) return;
  const bare = new RedisSessionStore({ url: REDIS_URL });
  await bare.connect();
  t.after(async () => { try { await bare.disconnect(); } catch { /* idempotent */ } });
  await assert.rejects(() => bare.clear(), TypeError);
});

test('corrupt serialized data is purged on read', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'corrupt');
  const id = 'session_corrupt_identifier_0001';
  const client = new Redis(REDIS_URL);
  try {
    await client.set(`${RUN}:corrupt:${id}`, '{not valid json');
  } finally {
    await client.quit();
  }
  assert.equal(await store.get(id), undefined);
  // The bad key must have been deleted, not merely ignored.
  const check = new Redis(REDIS_URL);
  try {
    assert.equal(await check.get(`${RUN}:corrupt:${id}`), null);
  } finally {
    await check.quit();
  }
  await store.clear();
});

// ---------------------------------------------------------------------------
// SessionManager over real Redis
// ---------------------------------------------------------------------------

test('SessionManager lifecycle works end-to-end over Redis', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'manager');
  const manager = new SessionManager(store, { ttlMs: 60_000 });
  const created = await manager.create({ userId: 'u1' });
  assert.equal((await manager.get(created.id))?.data.userId, 'u1');
  const updated = await manager.update(created.id, (d) => ({ ...d, role: 'admin' }));
  assert.equal(updated?.data.role, 'admin');
  assert.equal(updated?.revision, 2);
  const touched = await manager.touch(created.id);
  assert.equal(touched?.revision, 3);
  const rotated = await manager.rotate(created.id);
  assert.notEqual(rotated?.id, created.id);
  assert.equal(await manager.get(created.id), undefined);
  assert.equal((await manager.get(rotated.id))?.data.role, 'admin');
  await manager.destroy(rotated.id);
  assert.equal(await manager.get(rotated.id), undefined);
  await store.clear();
});

test('sessions are shared across processes (two managers, two connections, one Redis)', async (t) => {
  if (!(await guard(t))) return;
  const a = await open(t, 'shared');
  const b = await open(t, 'shared');
  const managerA = new SessionManager(a, { ttlMs: 60_000 });
  const managerB = new SessionManager(b, { ttlMs: 60_000 });
  const created = await managerA.create({ userId: 'u1' });
  // Manager B (a completely separate connection) sees A's session.
  assert.equal((await managerB.get(created.id))?.data.userId, 'u1');
  assert.equal((await managerB.update(created.id, (d) => ({ ...d, role: 'admin' })))?.data.role, 'admin');
  assert.equal((await managerA.get(created.id))?.data.role, 'admin');
  await a.clear();
});

test('a failed compare-and-set surfaces as SessionConflictError', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'conflict');
  // Force CAS failure while all other operations still hit real Redis.
  const spy = {
    get: (id) => store.get(id),
    createIfAbsent: (r) => store.createIfAbsent(r),
    compareAndSet: async () => false,
    delete: (id) => store.delete(id),
    rotate: (oldId, rev, r) => store.rotate(oldId, rev, r),
  };
  const manager = new SessionManager(spy, { ttlMs: 60_000 });
  const created = await manager.create({ userId: 'u1' });
  await assert.rejects(
    () => manager.update(created.id, (d) => ({ ...d, role: 'admin' })),
    { name: 'SessionConflictError' },
  );
  await store.clear();
});

test('logical expiry is enforced with a shared injected clock', async (t) => {
  if (!(await guard(t))) return;
  let clock = Date.now();
  const now = () => clock;
  const store = await open(t, 'logical-expiry', { now });
  const manager = new SessionManager(store, { now, ttlMs: 60_000 });
  const created = await manager.create({ userId: 'u1' });
  assert.ok(await manager.get(created.id));
  clock += 120_000; // advance the shared logical clock past expiry
  assert.equal(await manager.get(created.id), undefined);
  await store.clear();
});

test('physical TTL expires keys in Redis', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'physical-ttl');
  const id = 'session_physical_ttl_id_00001';
  await store.createIfAbsent(record(id, { v: 1 }, 1, 1000));
  assert.ok(await store.get(id));
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(await store.get(id), undefined);
  await store.clear();
});

test('disconnect is idempotent', async (t) => {
  if (!(await guard(t))) return;
  const store = await open(t, 'disconnect');
  await store.disconnect();
  await store.disconnect(); // must not throw
});

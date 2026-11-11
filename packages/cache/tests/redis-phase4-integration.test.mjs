import test from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import {
  CacheNamespace,
  CacheSerializationError,
  CacheStoreError,
  FallbackCache,
  MemoryCache,
  TaggedCache,
  createNamespace,
} from '../dist/index.js';
import { RedisCache, RedisTagVersionSource } from '../dist/redis.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const RUN = `sveltex-p4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let readyPromise = null;
function redisReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      try {
        const probe = new RedisCache({ url: REDIS_URL, keyPrefix: `${RUN}:probe:` });
        await probe.connect();
        await probe.set('x', 1);
        assert.equal(await probe.get('x'), 1);
        await probe.clear();
        await probe.disconnect();
        return true;
      } catch {
        return false;
      }
    })();
  }
  return readyPromise;
}

async function makeCache(name, extra = {}) {
  const cache = new RedisCache({ url: REDIS_URL, keyPrefix: `${RUN}:${name}:`, ...extra });
  await cache.connect();
  return cache;
}

async function guard(t) {
  if (!(await redisReady())) {
    t.skip('Redis is not available at ' + REDIS_URL);
    return false;
  }
  return true;
}

test('redis phase4: keys() enumerates logical keys only', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('keys');
  await cache.set('a', 1);
  await cache.set('b:c', 2);
  assert.deepEqual([...(await cache.keys())].sort(), ['a', 'b:c']);
  await cache.clear();
  await cache.disconnect();
});

test('redis phase4: keys() respects prefix isolation', async (t) => {
  if (!(await guard(t))) return;
  const a = await makeCache('keys-a');
  const b = await makeCache('keys-b');
  await a.set('shared', 1);
  assert.deepEqual(await b.keys(), []);
  assert.deepEqual(await a.keys(), ['shared']);
  await a.clear();
  await a.disconnect();
  await b.disconnect();
});

test('redis phase4: namespace clear is scoped across real Redis keys', async (t) => {
  if (!(await guard(t))) return;
  const store = await makeCache('ns');
  const a = createNamespace(store, 'alpha');
  const b = createNamespace(store, 'beta');
  await a.set('k', 'from-alpha');
  await b.set('k', 'from-beta');
  await store.set('outside', 'keep');
  assert.equal(await a.get('k'), 'from-alpha');
  await a.clear();
  assert.equal(await a.has('k'), false);
  assert.equal(await b.get('k'), 'from-beta');
  assert.equal(await store.get('outside'), 'keep');
  assert.deepEqual(await b.keys(), ['k']);
  assert.ok(new CacheNamespace(store, 'gamma') instanceof CacheNamespace);
  await store.clear();
  await store.disconnect();
});

test('redis phase4: tag invalidation is shared across processes (real INCR/MGET)', async (t) => {
  if (!(await guard(t))) return;
  const prefix = `${RUN}:tags:`;
  const cacheA = new RedisCache({ url: REDIS_URL, keyPrefix: prefix });
  const cacheB = new RedisCache({ url: REDIS_URL, keyPrefix: prefix });
  await cacheA.connect();
  await cacheB.connect();
  const taggedA = new TaggedCache(cacheA, { versions: cacheA.createTagVersionSource() });
  const taggedB = new TaggedCache(cacheB, { versions: cacheB.createTagVersionSource() });

  await taggedA.set('post:1', { title: 'hello' }, { tags: ['posts', 'author:7'] });
  assert.deepEqual(await taggedB.get('post:1'), { title: 'hello' });
  assert.equal(await taggedA.invalidateTag('author:7'), 1);
  assert.equal(await taggedB.get('post:1'), undefined);
  assert.equal(await taggedA.has('post:1'), false);

  await taggedA.set('post:2', 'again', { tags: ['posts'] });
  assert.equal(await taggedB.get('post:2'), 'again');
  assert.equal(await taggedB.invalidateTag('posts'), 1);
  assert.equal(await taggedA.get('post:2'), undefined);

  await cacheA.clear();
  await cacheA.disconnect();
  await cacheB.disconnect();
});

test('redis phase4: standalone RedisTagVersionSource bumps and resets', async (t) => {
  if (!(await guard(t))) return;
  const versions = new RedisTagVersionSource({ url: REDIS_URL, keyPrefix: `${RUN}:vs:` });
  await versions.connect();
  assert.equal(await versions.bump('t'), 1);
  assert.equal(await versions.bump('t'), 2);
  const snapshot = await versions.versions(['t', 'missing']);
  assert.equal(snapshot.t, 2);
  assert.equal(snapshot.missing, 0);
  await versions.reset();
  assert.equal((await versions.versions(['t'])).t, 0);
  await versions.disconnect();
});

test('redis phase4: corrupt/legacy payloads raise instead of becoming a miss', async (t) => {
  if (!(await guard(t))) return;
  const raw = new Redis(REDIS_URL);
  const physical = `${RUN}:corrupt:key`;
  await raw.set(physical, 'legacy-plain-string');
  const cache = await makeCache('corrupt');
  await assert.rejects(() => cache.get('key'), CacheSerializationError);
  await raw.del(physical);
  await raw.quit();
  await cache.clear();
  await cache.disconnect();
});

test('redis phase4: unsafe values are rejected before any write', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('unsafe');
  await assert.rejects(() => cache.set('bad', new Date()), CacheSerializationError);
  await assert.rejects(() => cache.set('bad2', { n: NaN }), CacheSerializationError);
  assert.equal(await cache.has('bad'), false);
  assert.equal(await cache.has('bad2'), false);
  await cache.disconnect();
});

test('redis phase4: undefined round-trips and is distinguishable via has()', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('undef');
  await cache.set('u', undefined);
  assert.equal(await cache.has('u'), true);
  assert.equal(await cache.get('u'), undefined);
  await cache.clear();
  await cache.disconnect();
});

test('redis phase4: increment envelope is consistent with get / getMany / setMany', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('counters');
  assert.equal(await cache.increment('n', 5), 5);
  assert.equal(await cache.increment('n', 3), 8);
  assert.equal(await cache.get('n'), 8);
  await cache.setMany([{ key: 'm', value: 2 }]);
  assert.deepEqual(await cache.getMany(['n', 'm', 'missing']), [8, 2, undefined]);
  await cache.clear();
  await cache.disconnect();
});

test('redis phase4: setMany with ttlMs 0 deletes rather than persisting', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('zero');
  await cache.set('gone', 1);
  await cache.setMany([{ key: 'gone', value: 2, ttlMs: 0 }]);
  assert.equal(await cache.has('gone'), false);
  await cache.disconnect();
});

test('redis phase4: FallbackCache degrades on a genuinely unreachable Redis primary', async (t) => {
  t.setTimeout?.(8000);
  const primary = new RedisCache({
    url: 'redis://127.0.0.1:6399',
    connectTimeoutMs: 200,
    maxRetriesPerRequest: 1,
    keyPrefix: `${RUN}:down:`,
  });
  const local = new MemoryCache();
  await local.set('k', 'local-value');
  const fb = new FallbackCache({
    primary,
    fallback: local,
    failureThreshold: 1,
    recoveryProbeMs: 60_000,
    now: () => 0,
  });
  assert.equal(await fb.get('k'), 'local-value');
  assert.equal(fb.state, 'degraded');
  assert.ok(fb.lastError instanceof CacheStoreError);
  assert.equal(fb.lastError.operation, 'get');
  await primary.disconnect();
});

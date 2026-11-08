import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisCache } from '../dist/redis.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const RUN = `sveltex-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

test('redis cache: stores, retrieves and deletes values', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('basic');
  await cache.set('user:1', { name: 'Alice' });
  assert.deepEqual(await cache.get('user:1'), { name: 'Alice' });
  assert.equal(await cache.has('user:1'), true);
  assert.equal(await cache.delete('user:1'), true);
  assert.equal(await cache.has('user:1'), false);
  assert.equal(await cache.get('user:1'), undefined);
  await cache.clear();
  await cache.disconnect();
});

test('redis cache: preserves primitive types through JSON round-trip', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('primitives');
  await cache.set('n', 42);
  await cache.set('s', 'hello');
  await cache.set('b', true);
  await cache.set('arr', [1, 2, 3]);
  assert.equal(await cache.get('n'), 42);
  assert.equal(await cache.get('s'), 'hello');
  assert.equal(await cache.get('b'), true);
  assert.deepEqual(await cache.get('arr'), [1, 2, 3]);
  await cache.clear();
  await cache.disconnect();
});

test('redis cache: delete returns false for missing key', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('missing');
  assert.equal(await cache.delete('does-not-exist'), false);
  assert.equal(await cache.has('does-not-exist'), false);
  await cache.disconnect();
});

test('redis cache: overwrites existing key', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('overwrite');
  await cache.set('k', 'first');
  await cache.set('k', 'second');
  assert.equal(await cache.get('k'), 'second');
  await cache.clear();
  await cache.disconnect();
});

test('redis cache: zero TTL deletes immediately (never persists)', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('ttl0');
  await cache.set('k', 'value', { ttlMs: 0 });
  assert.equal(await cache.has('k'), false);
  assert.equal(await cache.get('k'), undefined);
  await cache.disconnect();
});

test('redis cache: positive TTL expires the key', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('ttlexpire');
  t.setTimeout?.(8000);
  // 1000ms -> Redis EXPIRE of 1 second (ceil of ms/1000)
  await cache.set('k', 'value', { ttlMs: 1000 });
  assert.equal(await cache.has('k'), true);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(await cache.get('k'), undefined);
  await cache.disconnect();
});

test('redis cache: default TTL is applied when no per-set TTL is given', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('defaultttl', { defaultTtlMs: 1000 });
  t.setTimeout?.(8000);
  await cache.set('k', 'value');
  assert.equal(await cache.has('k'), true);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(await cache.get('k'), undefined);
  await cache.disconnect();
});

test('redis cache: increment works on missing and existing keys', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('increment');
  assert.equal(await cache.increment('counter', 5), 5);
  assert.equal(await cache.increment('counter', 3), 8);
  assert.equal(await cache.get('counter'), 8);
  await cache.clear();
  await cache.disconnect();
});

test('redis cache: setMany and getMany round-trip multiple keys', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('many');
  await cache.setMany([
    { key: 'a', value: 1 },
    { key: 'b', value: { x: 2 } },
    { key: 'c', value: 'three' },
  ]);
  const values = await cache.getMany(['a', 'b', 'c', 'missing']);
  assert.deepEqual(values, [1, { x: 2 }, 'three', undefined]);
  await cache.clear();
  await cache.disconnect();
});

test('redis cache: setMany honors per-entry TTL', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('manyttl');
  await cache.setMany([
    { key: 'persist', value: 'forever' },
    { key: 'soon', value: 'temp', ttlMs: 1000 },
  ]);
  t.setTimeout?.(8000);
  assert.equal(await cache.has('persist'), true);
  assert.equal(await cache.has('soon'), true);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(await cache.get('soon'), undefined);
  assert.equal(await cache.get('persist'), 'forever');
  await cache.clear();
  await cache.disconnect();
});

test('redis cache: key prefix isolates namespaces', async (t) => {
  if (!(await guard(t))) return;
  const a = await makeCache('ns-a');
  const b = await makeCache('ns-b');
  await a.set('shared', 'from-a');
  assert.equal(await a.has('shared'), true);
  assert.equal(await b.has('shared'), false);
  assert.equal(await b.get('shared'), undefined);
  await a.clear();
  assert.equal(await b.has('shared'), false);
  await b.disconnect();
  await a.disconnect();
});

test('redis cache: clear removes only prefixed keys', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('cleartest');
  await cache.set('one', 1);
  await cache.set('two', 2);
  await cache.clear();
  assert.equal(await cache.has('one'), false);
  assert.equal(await cache.has('two'), false);
  await cache.disconnect();
});

test('redis cache: rejects empty keys', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('badkey');
  await assert.rejects(() => cache.set('', 1), TypeError);
  await assert.rejects(() => cache.get(''), TypeError);
  await assert.rejects(() => cache.has(''), TypeError);
  await cache.disconnect();
});

test('redis cache: rejects over-long keys', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('longkey');
  const longKey = 'k'.repeat(1025);
  await assert.rejects(() => cache.set(longKey, 1), TypeError);
  await cache.disconnect();
});

test('redis cache: rejects negative TTL', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('badttl');
  await assert.rejects(() => cache.set('k', 1, { ttlMs: -5 }), RangeError);
  await cache.disconnect();
});

test('redis cache: disconnect is idempotent and data persists', async (t) => {
  if (!(await guard(t))) return;
  const cache = await makeCache('disconnect');
  await cache.set('k', 1);
  assert.equal(await cache.get('k'), 1);
  await cache.disconnect();
  await cache.disconnect(); // second disconnect must not throw
  // A fresh connection to the same Redis instance sees the persisted key
  const cache2 = await makeCache('disconnect');
  assert.equal(await cache2.get('k'), 1);
  await cache2.clear();
  await cache2.disconnect();
});

test('redis cache: can connect with host/port options', async (t) => {
  if (!(await guard(t))) return;
  const cache = new RedisCache({ host: 'localhost', port: 6379, keyPrefix: `${RUN}:hostport:` });
  await cache.connect();
  await cache.set('k', 'via-host-port');
  assert.equal(await cache.get('k'), 'via-host-port');
  await cache.clear();
  await cache.disconnect();
});

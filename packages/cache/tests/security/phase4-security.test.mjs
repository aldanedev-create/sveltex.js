import test from 'node:test'; import assert from 'node:assert/strict';
import {
  CACHE_ENVELOPE_PREFIX, CacheSerializationError, CacheStoreError, FallbackCache,
  MemoryCache, StampedeGuard, TaggedCache, createNamespace, decodeNamespaceKey,
  deserializeCacheValue, encodeNamespaceKey, serializeCacheValue,
  validateCacheKey, validateCacheTag,
} from '../../dist/index.js';

test('SEC: __proto__ in a cached object is dropped on parse', () => {
  const payload = `${CACHE_ENVELOPE_PREFIX}j${JSON.stringify({ ok: 1, __proto__: { polluted: true } })}`;
  const decoded = deserializeCacheValue(payload);
  assert.equal(decoded.ok, 1);
  assert.equal(Object.hasOwn(decoded, '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('SEC: legacy/corrupt payloads are never silently treated as a cache miss', () => {
  assert.throws(() => deserializeCacheValue('{"legacy":true}'), CacheSerializationError);
  assert.throws(() => deserializeCacheValue(`${CACHE_ENVELOPE_PREFIX}j{broken`), CacheSerializationError);
  assert.throws(() => deserializeCacheValue(123), CacheSerializationError);
});

test('SEC: forged envelope tags are rejected', () => {
  assert.throws(() => deserializeCacheValue(`${CACHE_ENVELOPE_PREFIX}zanything`), CacheSerializationError);
  assert.throws(() => deserializeCacheValue(`${CACHE_ENVELOPE_PREFIX}j{}extra`), CacheSerializationError);
});

test('SEC: prototype-polluting tag names are refused', async () => {
  for (const tag of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => validateCacheTag(tag), TypeError);
  }
  const tagged = new TaggedCache(new MemoryCache());
  await assert.rejects(() => tagged.set('k', 1, { tags: ['__proto__'] }), TypeError);
});

test('SEC: namespace key encoding cannot cross a tenant boundary', () => {
  const physical = encodeNamespaceKey('tenant-a', '../tenant-b/secret');
  assert.equal(decodeNamespaceKey('tenant-a', physical), '../tenant-b/secret');
  assert.equal(decodeNamespaceKey('tenant-b', physical), undefined);
  assert.equal(decodeNamespaceKey('tenant-a', encodeNamespaceKey('tenant-b', 'secret')), undefined);
  const segment = physical.slice(encodeNamespaceKey('tenant-a', '').length);
  assert.ok(!segment.includes(':'));
  assert.ok(!segment.includes('/'));
});

test('SEC: namespace names containing separators do not collide', async () => {
  const store = new MemoryCache();
  const a = createNamespace(store, 'a');
  const ab = createNamespace(store, 'a:b');
  await a.set('k', 'belongs-to-a');
  assert.equal(await ab.get('k'), undefined);
  assert.equal(await a.get('k'), 'belongs-to-a');
});

test('SEC: circular references are rejected (no stack-overflow / unbounded work)', () => {
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => serializeCacheValue(cycle), CacheSerializationError);
  assert.throws(() => serializeCacheValue({ nested: cycle }), CacheSerializationError);
});

test('SEC: NaN/Infinity are rejected instead of silently becoming null', () => {
  assert.throws(() => serializeCacheValue({ n: NaN }), CacheSerializationError);
  assert.throws(() => serializeCacheValue([Infinity]), CacheSerializationError);
  assert.throws(() => serializeCacheValue(-Infinity), CacheSerializationError);
});

test('SEC: keys and tags are length-bounded', () => {
  assert.throws(() => validateCacheKey('k'.repeat(1025)), TypeError);
  assert.throws(() => validateCacheTag('t'.repeat(257)), TypeError);
  assert.doesNotThrow(() => validateCacheKey('k'.repeat(1024)));
});

test('SEC: backend errors are wrapped, never swallowed', async () => {
  const primary = {
    async get() { throw new Error('socket closed'); },
    async set() { throw new Error('socket closed'); },
    async delete() { return false; },
    async has() { return false; },
    async clear() { /* no-op */ },
  };
  const local = new MemoryCache(); await local.set('k', 'stale-but-explicit');
  const fb = new FallbackCache({ primary, fallback: local, failureThreshold: 1, recoveryProbeMs: 1000, now: () => 0 });
  assert.equal(await fb.get('k'), 'stale-but-explicit');
  assert.equal(fb.state, 'degraded');
  assert.ok(fb.lastError instanceof CacheStoreError);
  assert.equal(fb.lastError.cause.message, 'socket closed');
});

test('SEC: serving fallback data is observable, not hidden', async () => {
  const primary = {
    async get() { throw new Error('down'); },
    async set() { /* no-op */ },
    async delete() { return false; },
    async has() { throw new Error('down'); },
    async clear() { /* no-op */ },
  };
  const fb = new FallbackCache({ primary, fallback: new MemoryCache(), onStateChange: () => {} });
  await fb.get('k');
  assert.equal(fb.failureCount, 1);
  assert.ok(fb.lastError instanceof CacheStoreError);
});

test('SEC: loader errors are never cached (no poisoned values)', async () => {
  const store = new MemoryCache();
  const guard = new StampedeGuard(store);
  await assert.rejects(() => guard.getOrLoad('k', () => { throw new Error('loader failed'); }), /loader failed/);
  assert.equal(await store.has('k'), false);
});

test('SEC: values that cannot round-trip never reach the backing store', async () => {
  const store = new MemoryCache();
  const tagged = new TaggedCache(store);
  await assert.rejects(() => tagged.set('k', { d: new Date() }), CacheSerializationError);
  assert.equal(await store.has('k'), false);
});

test('SEC: a forged tagged envelope is rejected with a typed error', async () => {
  const store = new MemoryCache();
  const tagged = new TaggedCache(store);
  await store.set('k', serializeCacheValue({ hasData: true, data: 1 })); // missing gens
  await assert.rejects(() => tagged.get('k'), CacheSerializationError);
});

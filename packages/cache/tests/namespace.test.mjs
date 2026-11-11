import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheConfigurationError,
  CacheNamespace,
  MemoryCache,
  createNamespace,
  decodeNamespaceKey,
  encodeNamespaceKey,
  invalidateKeys,
  invalidateMatching,
  invalidatePrefix,
  namespaceKeyPrefix,
} from '../dist/index.js';

test('namespace: key segments are escaped so no input can cross a boundary', () => {
  const physical = encodeNamespaceKey('app', 'a:b/c%d');
  assert.equal(decodeNamespaceKey('app', physical), 'a:b/c%d');
  assert.equal(decodeNamespaceKey('other', physical), undefined);
  assert.ok(physical.startsWith(namespaceKeyPrefix('app')));
  assert.ok(!physical.startsWith(namespaceKeyPrefix('app:extra')));
  assert.equal(decodeNamespaceKey('app', `${namespaceKeyPrefix('app')}%ZZ`), undefined);
});

test('namespace: different names never collide even with separators in the name', () => {
  assert.notEqual(namespaceKeyPrefix('a'), namespaceKeyPrefix('a:b'));
  assert.equal(decodeNamespaceKey('a', encodeNamespaceKey('a:b', 'k')), undefined);
});

test('namespace: isolates reads and writes within one shared store', async () => {
  const store = new MemoryCache();
  const a = createNamespace(store, 'a');
  const b = createNamespace(store, 'b');
  await a.set('shared', 'from-a');
  await b.set('shared', 'from-b');
  assert.equal(await a.get('shared'), 'from-a');
  assert.equal(await b.get('shared'), 'from-b');
  assert.equal(await store.has(encodeNamespaceKey('a', 'shared')), true);
  assert.equal(a.name, 'a');
});

test('namespace: clear() removes only this namespace, never global keys', async () => {
  const store = new MemoryCache();
  const a = createNamespace(store, 'a');
  const b = createNamespace(store, 'b');
  await store.set('outside', 'keep');
  await a.set('one', 1);
  await a.set('two', 2);
  await b.set('one', 'b-one');
  await a.clear();
  assert.equal(await a.has('one'), false);
  assert.equal(await a.has('two'), false);
  assert.equal(await b.get('one'), 'b-one');
  assert.equal(await store.get('outside'), 'keep');
});

test('namespace: keys() returns logical keys only', async () => {
  const store = new MemoryCache();
  const a = createNamespace(store, 'a');
  await store.set('outside', 1);
  await a.set('x:y', 1);
  await a.set('z', 2);
  assert.deepEqual([...(await a.keys())].sort(), ['x:y', 'z']);
});

test('namespace: TTL is passed through to the backing store', async () => {
  let now = 0;
  const store = new MemoryCache({ now: () => now });
  const ns = createNamespace(store, 'ttl');
  await ns.set('k', 1, { ttlMs: 5 });
  assert.equal(await ns.has('k'), true);
  now = 6;
  assert.equal(await ns.has('k'), false);
});

test('namespace: rejects invalid names and non-keyed stores', () => {
  assert.throws(() => createNamespace(new MemoryCache(), ''), TypeError);
  assert.throws(() => new CacheNamespace(new MemoryCache(), 'x'.repeat(257)), TypeError);
  assert.throws(() => new CacheNamespace({}, 'x'), CacheConfigurationError);
});

test('namespace: can be nested (it is itself a KeyedCacheStore)', async () => {
  const store = new MemoryCache();
  const outer = createNamespace(store, 'outer');
  const inner = new CacheNamespace(outer, 'inner');
  await inner.set('k', 'v');
  assert.equal(await inner.get('k'), 'v');
  assert.equal(await outer.get('k'), undefined);
  assert.deepEqual(await inner.keys(), ['k']);
});

test('invalidation: invalidateKeys reports how many keys existed', async () => {
  const store = new MemoryCache();
  await store.set('a', 1);
  await store.set('b', 2);
  assert.equal(await invalidateKeys(store, ['a', 'b', 'missing']), 2);
  assert.equal(await store.has('a'), false);
});

test('invalidation: invalidatePrefix and invalidateMatching are scoped', async () => {
  const store = new MemoryCache();
  for (const key of ['user:1', 'user:2', 'posts:list', 'posts:item']) await store.set(key, key);
  assert.equal(await invalidatePrefix(store, 'user:'), 2);
  assert.equal(await invalidateMatching(store, (key) => key.endsWith('list')), 1);
  assert.deepEqual([...(await store.keys())].sort(), ['posts:item']);
});

test('invalidation: validation errors propagate rather than being swallowed', async () => {
  const store = new MemoryCache();
  await assert.rejects(() => invalidateKeys(store, ['']), TypeError);
  await assert.rejects(() => invalidateMatching(store, null), TypeError);
  await assert.rejects(() => invalidatePrefix(store, 42), TypeError);
});

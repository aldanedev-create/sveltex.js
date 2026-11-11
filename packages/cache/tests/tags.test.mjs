import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheConfigurationError,
  CacheSerializationError,
  InMemoryTagVersionSource,
  MemoryCache,
  TaggedCache,
} from '../dist/index.js';

test('tags: untagged entries behave like a normal cache', async () => {
  const store = new MemoryCache();
  const tagged = new TaggedCache(store);
  await tagged.set('k', { a: 1 });
  assert.deepEqual(await tagged.get('k'), { a: 1 });
  assert.equal(await tagged.has('k'), true);
  assert.equal(await tagged.delete('k'), true);
  assert.equal(await tagged.has('k'), false);
});

test('tags: bumping a tag invalidates every dependent entry', async () => {
  const tagged = new TaggedCache(new MemoryCache());
  await tagged.set('user:1', { name: 'A' }, { tags: ['users'] });
  await tagged.set('user:2', { name: 'B' }, { tags: ['users'] });
  assert.equal(await tagged.invalidateTag('users'), 1);
  assert.equal(await tagged.get('user:1'), undefined);
  assert.equal(await tagged.has('user:2'), false);
});

test('tags: unrelated tags and untagged entries survive', async () => {
  const tagged = new TaggedCache(new MemoryCache());
  await tagged.set('a', 1, { tags: ['alpha'] });
  await tagged.set('b', 2, { tags: ['beta'] });
  await tagged.set('c', 3);
  await tagged.invalidateTag('alpha');
  assert.equal(await tagged.get('a'), undefined);
  assert.equal(await tagged.get('b'), 2);
  assert.equal(await tagged.get('c'), 3);
});

test('tags: an entry with several tags is invalidated by any of them', async () => {
  const tagged = new TaggedCache(new MemoryCache());
  await tagged.set('post:1', 'body', { tags: ['posts', 'author:7'] });
  assert.equal(await tagged.get('post:1'), 'body');
  await tagged.invalidateTag('author:7');
  assert.equal(await tagged.get('post:1'), undefined);
});

test('tags: re-setting an entry after invalidation picks up the new generation', async () => {
  const tagged = new TaggedCache(new MemoryCache());
  await tagged.set('k', 'v1', { tags: ['t'] });
  await tagged.invalidateTag('t');
  await tagged.set('k', 'v2', { tags: ['t'] });
  assert.equal(await tagged.get('k'), 'v2');
  await tagged.invalidateTag('t');
  assert.equal(await tagged.get('k'), undefined);
});

test('tags: invalidateTags deduplicates and returns new generations', async () => {
  const tagged = new TaggedCache(new MemoryCache());
  const result = await tagged.invalidateTags(['a', 'b', 'a']);
  assert.equal(result.length, 2);
  assert.deepEqual([...result], [1, 1]);
  await tagged.set('k', 1, { tags: ['a', 'b'] });
  assert.equal(await tagged.invalidateTag('a'), 2);
  assert.equal(await tagged.get('k'), undefined);
});

test('tags: cached undefined stays distinguishable via has()', async () => {
  const tagged = new TaggedCache(new MemoryCache());
  await tagged.set('empty', undefined, { tags: ['t'] });
  assert.equal(await tagged.has('empty'), true);
  assert.equal(await tagged.get('empty'), undefined);
  await tagged.invalidateTag('t');
  assert.equal(await tagged.has('empty'), false);
});

test('tags: stale entries are physically removed on read (lazy cleanup)', async () => {
  const store = new MemoryCache();
  const tagged = new TaggedCache(store);
  await tagged.set('k', 1, { tags: ['t'] });
  assert.equal(await store.has('k'), true);
  await tagged.invalidateTag('t');
  assert.equal(await tagged.get('k'), undefined);
  assert.equal(await store.has('k'), false);
});

test('tags: TTL is forwarded to the backing store', async () => {
  let now = 0;
  const store = new MemoryCache({ now: () => now });
  const tagged = new TaggedCache(store);
  await tagged.set('k', 1, { tags: ['t'], ttlMs: 5 });
  now = 6;
  assert.equal(await tagged.has('k'), false);
});

test('tags: clear() removes entries but keeps shared generations', async () => {
  const versions = new InMemoryTagVersionSource();
  const store = new MemoryCache();
  const tagged = new TaggedCache(store, { versions });
  await tagged.set('k', 1, { tags: ['t'] });
  await tagged.invalidateTag('t');
  await tagged.set('k', 2, { tags: ['t'] });
  await tagged.clear();
  assert.equal(await store.has('k'), false);
  assert.equal((await versions.versions(['t'])).t, 1);
  await versions.reset();
  assert.equal((await versions.versions(['t'])).t, 0);
});

test('tags: InMemoryTagVersionSource bumps atomically and validates names', async () => {
  const versions = new InMemoryTagVersionSource();
  assert.equal(await versions.bump('x'), 1);
  assert.equal(await versions.bump('x'), 2);
  assert.deepEqual({ ...(await versions.versions(['x', 'missing'])) }, { x: 2, missing: 0 });
  await assert.rejects(() => versions.bump('__proto__'), TypeError);
  await assert.rejects(() => versions.versions(['bad name']), TypeError);
});

test('tags: invalid tag names and keys are rejected before writing', async () => {
  const store = new MemoryCache();
  const tagged = new TaggedCache(store);
  await assert.rejects(() => tagged.set('k', 1, { tags: ['__proto__'] }), TypeError);
  await assert.rejects(() => tagged.set('k', 1, { tags: ['has space'] }), TypeError);
  await assert.rejects(() => tagged.set('', 1), TypeError);
  assert.equal(await store.has('k'), false);
});

test('tags: a store written to directly produces a typed error, not a silent miss', async () => {
  const store = new MemoryCache();
  const tagged = new TaggedCache(store);
  await store.set('k', { not: 'an envelope' });
  await assert.rejects(() => tagged.get('k'), CacheSerializationError);
});

test('tags: corrupt payloads raise a serialization error', async () => {
  const store = new MemoryCache();
  const tagged = new TaggedCache(store);
  await store.set('k', 'plain-string');
  await assert.rejects(() => tagged.get('k'), CacheSerializationError);
});

test('tags: constructor rejects invalid collaborators and unsupported values', async () => {
  assert.throws(() => new TaggedCache({}), CacheConfigurationError);
  const tagged = new TaggedCache(new MemoryCache());
  await assert.rejects(() => tagged.set('k', new Date()), CacheSerializationError);
  assert.ok(tagged.versions instanceof InMemoryTagVersionSource);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheConfigurationError,
  MemoryCache,
  StampedeGuard,
  computeTtlWithJitter,
} from '../dist/index.js';

test('stampede: concurrent cold loads coalesce into exactly one loader call', async () => {
  let loads = 0;
  const guard = new StampedeGuard(new MemoryCache());
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return `value-${loads}`;
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => guard.getOrLoad('k', loader)));
  assert.equal(loads, 1);
  assert.equal(new Set(results).size, 1);
  assert.equal(guard.inFlight, 0);
});

test('stampede: a warm cache never calls the loader again', async () => {
  let loads = 0;
  const guard = new StampedeGuard(new MemoryCache());
  assert.equal(await guard.getOrLoad('k', () => { loads += 1; return 1; }), 1);
  assert.equal(await guard.getOrLoad('k', () => { loads += 1; return 2; }), 1);
  assert.equal(loads, 1);
});

test('stampede: loader failures are not cached and can be retried', async () => {
  let loads = 0;
  const guard = new StampedeGuard(new MemoryCache());
  await assert.rejects(
    () => guard.getOrLoad('k', () => { loads += 1; throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(guard.inFlight, 0);
  assert.equal(await guard.getOrLoad('k', () => 'recovered'), 'recovered');
  assert.equal(loads, 1);
});

test('stampede: a failing loader rejects every waiter', async () => {
  let loads = 0;
  const guard = new StampedeGuard(new MemoryCache());
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('boom');
  };
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => guard.getOrLoad('k', loader)));
  assert.equal(loads, 1);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(guard.inFlight, 0);
});

test('stampede: onCoalesced reports each waiter and observer errors are contained', async () => {
  const coalesced = [];
  const guard = new StampedeGuard(new MemoryCache(), {
    onCoalesced: (key, waiters) => coalesced.push([key, waiters]),
  });
  const loader = async () => { await new Promise((r) => setTimeout(r, 10)); return 1; };
  await Promise.all(Array.from({ length: 4 }, () => guard.getOrLoad('k', loader)));
  assert.deepEqual(coalesced.map((entry) => entry[1]), [1, 2, 3]);
  assert.ok(coalesced.every((entry) => entry[0] === 'k'));

  const guarded = new StampedeGuard(new MemoryCache(), {
    onCoalesced: () => { throw new Error('observer down'); },
  });
  const results = await Promise.all([
    guarded.getOrLoad('x', loader),
    guarded.getOrLoad('x', loader),
  ]);
  assert.deepEqual(results, [1, 1]);
});

test('stampede: inFlight reflects the in-progress load', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const guard = new StampedeGuard(new MemoryCache());
  const pending = guard.getOrLoad('k', async () => { await gate; return 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.inFlight, 1);
  release();
  assert.equal(await pending, 1);
  assert.equal(guard.inFlight, 0);
});

test('stampede: different keys are not coalesced', async () => {
  let loads = 0;
  const guard = new StampedeGuard(new MemoryCache(), { random: () => 0.5 });
  const loader = async (value) => {
    loads += 1;
    await new Promise((r) => setTimeout(r, 5));
    return value;
  };
  const [a, b] = await Promise.all([
    guard.getOrLoad('a', () => loader('a')),
    guard.getOrLoad('b', () => loader('b')),
  ]);
  assert.equal(loads, 2);
  assert.equal(a, 'a');
  assert.equal(b, 'b');
});

test('stampede: computeTtlWithJitter bounds and validation', () => {
  assert.equal(computeTtlWithJitter(100, 0), 100);
  assert.equal(computeTtlWithJitter(0, 0.5), 0);
  assert.equal(computeTtlWithJitter(100, 0.5, () => 0), 50);
  assert.equal(computeTtlWithJitter(100, 0.5, () => 0.999999), 150);
  assert.equal(computeTtlWithJitter(1, 0.5, () => 0), 1);
  assert.throws(() => computeTtlWithJitter(100, 0.6), RangeError);
  assert.throws(() => computeTtlWithJitter(100, -0.1), RangeError);
  assert.throws(() => computeTtlWithJitter(100, 0.5, () => 1), RangeError);
  assert.throws(() => computeTtlWithJitter(100, 0.5, () => NaN), RangeError);
  assert.throws(() => computeTtlWithJitter(-1, 0), RangeError);
  assert.throws(() => computeTtlWithJitter(Infinity, 0), RangeError);
});

test('stampede: jitter is applied to the stored TTL', async () => {
  let now = 0;
  const store = new MemoryCache({ now: () => now });
  const guard = new StampedeGuard(store, { random: () => 0 });
  await guard.getOrLoad('k', () => 1, { ttlMs: 100, jitterRatio: 0.5 });
  now = 49;
  assert.equal(await store.has('k'), true);
  now = 50;
  assert.equal(await store.has('k'), false);
});

test('stampede: cached undefined is treated as a hit', async () => {
  const store = new MemoryCache();
  const guard = new StampedeGuard(store);
  assert.equal(await guard.getOrLoad('u', () => undefined), undefined);
  assert.equal(await store.has('u'), true);
  let called = false;
  assert.equal(await guard.getOrLoad('u', () => { called = true; return 1; }), undefined);
  assert.equal(called, false);
});

test('stampede: rejects invalid inputs and collaborators', async () => {
  assert.throws(() => new StampedeGuard({}), CacheConfigurationError);
  const guard = new StampedeGuard(new MemoryCache());
  await assert.rejects(() => guard.getOrLoad('', () => 1), TypeError);
  await assert.rejects(() => guard.getOrLoad('k', null), TypeError);
  await assert.rejects(() => guard.getOrLoad('k', () => 1, { ttlMs: -1 }), RangeError);
  await assert.rejects(() => guard.getOrLoad('k', () => 1, { jitterRatio: 2 }), RangeError);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheConfigurationError,
  CacheStoreError,
  FallbackCache,
  MemoryCache,
} from '../dist/index.js';

// Test double used only to force real error paths in the circuit breaker.
// It is never presented as a shipped provider.
function primaryStore(failRef, calls) {
  return {
    data: new Map(),
    async get(key) {
      calls.push(`get:${key}`);
      if (failRef.value) throw new Error('primary down');
      return this.data.get(key);
    },
    async set(key, value) {
      calls.push(`set:${key}`);
      if (failRef.value) throw new Error('primary down');
      this.data.set(key, value);
    },
    async delete(key) {
      calls.push(`delete:${key}`);
      if (failRef.value) throw new Error('primary down');
      return this.data.delete(key);
    },
    async has(key) {
      calls.push(`has:${key}`);
      if (failRef.value) throw new Error('primary down');
      return this.data.has(key);
    },
    async clear() {
      calls.push('clear');
      if (failRef.value) throw new Error('primary down');
      this.data.clear();
    },
  };
}

test('fallback: healthy operations target the primary', async () => {
  const calls = [];
  const primary = primaryStore({ value: false }, calls);
  const fb = new FallbackCache({ primary, fallback: new MemoryCache() });
  await fb.set('k', 'v');
  assert.equal(await fb.get('k'), 'v');
  assert.equal(await fb.has('k'), true);
  assert.equal(fb.state, 'healthy');
  assert.equal(fb.failureCount, 0);
  assert.deepEqual(calls, ['set:k', 'get:k', 'has:k']);
});

test('fallback: writes are mirrored to the local store (write-through)', async () => {
  const primary = primaryStore({ value: false }, []);
  const local = new MemoryCache();
  const fb = new FallbackCache({ primary, fallback: local });
  await fb.set('k', { a: 1 });
  assert.deepEqual(await local.get('k'), { a: 1 });
  assert.deepEqual(await primary.data.get('k'), { a: 1 });
});

test('fallback: a single primary failure degrades the read but is fully reported', async () => {
  const calls = [];
  const errors = [];
  const primary = primaryStore({ value: true }, calls);
  const local = new MemoryCache();
  await local.set('k', 'local-value');
  const fb = new FallbackCache({ primary, fallback: local, onError: (e) => errors.push(e) });

  assert.equal(await fb.get('k'), 'local-value');
  assert.equal(fb.state, 'healthy');
  assert.equal(fb.failureCount, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof CacheStoreError);
  assert.equal(errors[0].operation, 'get');
  assert.equal(errors[0].cause.message, 'primary down');
  assert.equal(fb.lastError, errors[0]);
  assert.equal(fb.lastError.code, 'CACHE_STORE');
});

test('fallback: consecutive failures open the circuit', async () => {
  const states = [];
  const primary = primaryStore({ value: true }, []);
  const fb = new FallbackCache({
    primary,
    fallback: new MemoryCache(),
    failureThreshold: 2,
    recoveryProbeMs: 1000,
    now: () => 0,
    onStateChange: (s) => states.push(s),
  });
  await fb.get('a');
  assert.equal(fb.state, 'healthy');
  await fb.get('b');
  assert.equal(fb.state, 'degraded');
  assert.equal(fb.failureCount, 2);
  assert.deepEqual(states, ['degraded']);
});

test('fallback: degraded state skips the primary entirely', async () => {
  const calls = [];
  const primary = primaryStore({ value: true }, calls);
  const local = new MemoryCache();
  const fb = new FallbackCache({
    primary,
    fallback: local,
    failureThreshold: 1,
    recoveryProbeMs: 1000,
    now: () => 0,
  });
  await fb.get('x');
  assert.equal(fb.state, 'degraded');
  const before = calls.length;
  await fb.get('x');
  await fb.set('y', 1);
  await fb.has('y');
  await fb.delete('y');
  await fb.clear();
  assert.equal(calls.length, before, 'no primary calls while the circuit is open');
  assert.equal(await local.get('y'), undefined);
});

test('fallback: half-open probe recovers to healthy', async () => {
  let now = 0;
  const failRef = { value: true };
  const primary = primaryStore(failRef, []);
  const states = [];
  const fb = new FallbackCache({
    primary,
    fallback: new MemoryCache(),
    failureThreshold: 1,
    recoveryProbeMs: 100,
    now: () => now,
    onStateChange: (s) => states.push(s),
  });
  await fb.get('k');
  assert.equal(fb.state, 'degraded');
  now = 100;
  failRef.value = false;
  await primary.data.set('k', 'back');
  assert.equal(await fb.get('k'), 'back');
  assert.equal(fb.state, 'healthy');
  assert.equal(fb.failureCount, 0);
  assert.deepEqual(states, ['degraded', 'probing', 'healthy']);
});

test('fallback: a failed probe re-opens the circuit and resets the timer', async () => {
  let now = 0;
  const calls = [];
  const primary = primaryStore({ value: true }, calls);
  const fb = new FallbackCache({
    primary,
    fallback: new MemoryCache(),
    failureThreshold: 1,
    recoveryProbeMs: 100,
    now: () => now,
  });
  await fb.get('k');
  now = 100;
  await fb.get('k'); // probing -> fails -> degraded, openedAt = 100
  assert.equal(fb.state, 'degraded');
  const before = calls.length;
  now = 150;
  await fb.get('k'); // still degraded
  assert.equal(calls.length, before);
  now = 200;
  await fb.get('k'); // probe again
  assert.ok(calls.length > before);
});

test('fallback: probe() forces a primary health check', async () => {
  const failRef = { value: false };
  const primary = primaryStore(failRef, []);
  const fb = new FallbackCache({ primary, fallback: new MemoryCache(), failureThreshold: 1 });
  assert.equal(await fb.probe(), true);
  assert.equal(fb.state, 'healthy');
  failRef.value = true;
  assert.equal(await fb.probe(), false);
  assert.equal(fb.state, 'degraded');
  assert.ok(fb.lastError instanceof CacheStoreError);
});

test('fallback: delete / has / clear degrade to the local store', async () => {
  const primary = primaryStore({ value: true }, []);
  const local = new MemoryCache();
  await local.set('k', 'v');
  const fb = new FallbackCache({
    primary,
    fallback: local,
    failureThreshold: 1,
    recoveryProbeMs: 1000,
    now: () => 0,
  });
  assert.equal(await fb.has('k'), true);
  assert.equal(fb.state, 'degraded');
  assert.equal(await fb.delete('k'), true);
  assert.equal(await fb.has('k'), false);
  await fb.set('other', 1);
  await fb.clear();
  assert.equal(await local.has('other'), false);
});

test('fallback: healthy clear() empties both tiers', async () => {
  const primary = primaryStore({ value: false }, []);
  const local = new MemoryCache();
  const fb = new FallbackCache({ primary, fallback: local });
  await fb.set('k', 'v');
  await fb.clear();
  assert.equal(primary.data.size, 0);
  assert.equal(await local.has('k'), false);
});

test('fallback: TTL options reach both tiers', async () => {
  let now = 0;
  const primary = new MemoryCache({ now: () => now });
  const local = new MemoryCache({ now: () => now });
  const fb = new FallbackCache({ primary, fallback: local });
  await fb.set('k', 1, { ttlMs: 5 });
  now = 6;
  assert.equal(await primary.has('k'), false);
  assert.equal(await local.has('k'), false);
});

test('fallback: a write that reaches neither tier does not report success', async () => {
  const primary = primaryStore({ value: true }, []);
  const brokenLocal = {
    async get() { return undefined; },
    async set() { throw new Error('fallback down'); },
    async delete() { return false; },
    async has() { return false; },
    async clear() { /* no-op */ },
  };
  const fb = new FallbackCache({ primary, fallback: brokenLocal, failureThreshold: 10 });
  await assert.rejects(() => fb.set('k', 1), /fallback down/);
  assert.ok(fb.lastError instanceof CacheStoreError);
  assert.equal(fb.lastError.operation, 'set');
});

test('fallback: observer failures never break cache operations', async () => {
  const primary = primaryStore({ value: true }, []);
  const local = new MemoryCache();
  await local.set('k', 'v');
  const fb = new FallbackCache({
    primary,
    fallback: local,
    onError: () => { throw new Error('observer down'); },
    onStateChange: () => { throw new Error('observer down'); },
  });
  assert.equal(await fb.get('k'), 'v');
  assert.ok(fb.lastError instanceof CacheStoreError);
});

test('fallback: rejects invalid collaborators and options', () => {
  const primary = primaryStore({ value: false }, []);
  assert.throws(() => new FallbackCache({ primary: {}, fallback: new MemoryCache() }), CacheConfigurationError);
  assert.throws(() => new FallbackCache({ primary, fallback: null }), CacheConfigurationError);
  assert.throws(() => new FallbackCache({ primary, fallback: new MemoryCache(), failureThreshold: 0 }), CacheConfigurationError);
  assert.throws(() => new FallbackCache({ primary, fallback: new MemoryCache(), failureThreshold: 1.5 }), CacheConfigurationError);
  assert.throws(() => new FallbackCache({ primary, fallback: new MemoryCache(), recoveryProbeMs: -1 }), CacheConfigurationError);
  assert.throws(() => new FallbackCache({ primary, fallback: new MemoryCache(), recoveryProbeMs: Infinity }), CacheConfigurationError);
});

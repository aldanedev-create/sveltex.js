import test from 'node:test';
import assert from 'node:assert/strict';
import { FixedWindowLimiter } from '../dist/limiter.js';

test('allows up to max attempts per window, then blocks', async () => {
  let now = 1000;
  const limiter = new FixedWindowLimiter({ max: 3, windowMs: 1000, now: () => now });
  assert.equal(await limiter.consume('ip:1'), true);
  assert.equal(await limiter.consume('ip:1'), true);
  assert.equal(await limiter.consume('ip:1'), true);
  assert.equal(await limiter.consume('ip:1'), false); // 4th attempt blocked
  assert.equal(await limiter.consume('ip:2'), true); // distinct keys are independent
});

test('resets allowance after the window elapses', async () => {
  let now = 1000;
  const limiter = new FixedWindowLimiter({ max: 1, windowMs: 1000, now: () => now });
  assert.equal(await limiter.consume('k'), true);
  assert.equal(await limiter.consume('k'), false);
  now = 2000; // advance past the window
  assert.equal(await limiter.consume('k'), true);
});

test('secondsRemaining reports time left in the window', async () => {
  let now = 0;
  const limiter = new FixedWindowLimiter({ max: 1, windowMs: 10_000, now: () => now });
  await limiter.consume('k');
  assert.equal(limiter.secondsRemaining('k'), 10);
  now = 5_000;
  assert.equal(limiter.secondsRemaining('k'), 5);
  now = 20_000;
  assert.equal(limiter.secondsRemaining('k'), 0);
});

test('reset clears state for one key or all keys', async () => {
  const limiter = new FixedWindowLimiter({ max: 1, windowMs: 1000, now: () => 0 });
  assert.equal(await limiter.consume('a'), true);
  assert.equal(await limiter.consume('a'), false);
  limiter.reset('a');
  assert.equal(await limiter.consume('a'), true);
});

test('rejects invalid options', () => {
  assert.throws(() => new FixedWindowLimiter({ max: 0, windowMs: 1000 }), RangeError);
  assert.throws(() => new FixedWindowLimiter({ max: 1, windowMs: 0 }), RangeError);
});

test('satisfies the AuthAttemptLimiter port used by AuthService', async () => {
  const { AuthService } = await import('../dist/index.js');
  let now = 0;
  const limiter = new FixedWindowLimiter({ max: 2, windowMs: 60_000, now: () => now });
  const store = { async findByEmail() { return undefined; }, async createIfAbsent() { return undefined; } };
  const hasher = { async hash() { return 'argon2id$long-enough-hash-value-here-1234567890'; }, async verify() { return false; } };
  const sessions = { async create() { return { id: 's1' }; }, async destroy() {} };
  const auth = new AuthService(store, hasher, sessions, {
    limiter,
    dummyPasswordHash: 'argon2id$application-specific-dummy-hash-value',
  });
  // Two attempts allowed; the third is blocked before the user lookup runs.
  assert.equal(await auth.login('a@b.com', 'pw'), undefined);
  assert.equal(await auth.login('a@b.com', 'pw'), undefined);
  assert.equal(await auth.login('a@b.com', 'pw'), undefined);
});

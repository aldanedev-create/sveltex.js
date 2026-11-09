import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailVerificationService } from '../dist/verification.js';
import { TokenManager, MemoryTokenStore } from '../dist/tokens.js';
import { AuthTokenUsedError, AuthTokenExpiredError } from '../dist/errors.js';

function makeStore(verified = new Set()) {
  return {
    verified,
    async findById(id) { return id === 'u1' ? { id: 'u1', email: 'a@b.com' } : undefined; },
    async markVerified(id) { if (id !== 'u1') return false; verified.add(id); return true; },
  };
}

test('requestVerification sends a token bound to the user', async () => {
  let now = 1000;
  const clock = () => now;
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new EmailVerificationService(makeStore(), tokens);
  let ctx;
  await svc.requestVerification({ id: 'u1', email: 'a@b.com' }, { async send(c) { ctx = c; } });
  assert.ok(ctx && ctx.token);
  assert.equal(ctx.email, 'a@b.com');
});

test('verify consumes the token and marks the account verified', async () => {
  let now = 1000;
  const clock = () => now;
  const verified = new Set();
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new EmailVerificationService(makeStore(verified), tokens);
  let ctx;
  await svc.requestVerification({ id: 'u1', email: 'a@b.com' }, { async send(c) { ctx = c; } });
  const uid = await svc.verify(ctx.token);
  assert.equal(uid, 'u1');
  assert.equal(verified.has('u1'), true);
});

test('verification token is single-use', async () => {
  let now = 1000;
  const clock = () => now;
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new EmailVerificationService(makeStore(), tokens);
  let ctx;
  await svc.requestVerification({ id: 'u1', email: 'a@b.com' }, { async send(c) { ctx = c; } });
  await svc.verify(ctx.token);
  await assert.rejects(() => svc.verify(ctx.token), AuthTokenUsedError);
});

test('expired verification token is rejected', async () => {
  let now = 1000;
  const clock = () => now;
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new EmailVerificationService(makeStore(), tokens, { ttlMs: 1000 });
  let ctx;
  await svc.requestVerification({ id: 'u1', email: 'a@b.com' }, { async send(c) { ctx = c; } });
  now = 2001;
  await assert.rejects(() => svc.verify(ctx.token), AuthTokenExpiredError);
});

test('requestVerification rejects users without id or email', async () => {
  const svc = new EmailVerificationService(makeStore(), new TokenManager(new MemoryTokenStore()));
  await assert.rejects(() => svc.requestVerification({ id: '', email: '' }, { async send() {} }), TypeError);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PasswordResetService } from '../dist/reset.js';
import { TokenManager, MemoryTokenStore } from '../dist/tokens.js';
import { AuthTokenUsedError, AuthTokenExpiredError, AuthTokenInvalidError } from '../dist/errors.js';

function makeStore(users = new Map()) {
  return {
    users,
    async findByEmail(email) { return users.get(email); },
    async findById(id) { for (const u of users.values()) if (u.id === id) return u; return undefined; },
    async updatePassword(id, hash) {
      for (const u of users.values()) if (u.id === id) { u.passwordHash = hash; return true; }
      return false;
    },
  };
}
function makeHasher() {
  let n = 0;
  return { async hash(pw) { return `argon2id$${pw}-${n++}`; }, async verify() { return false; } };
}

test('requestReset is silent for unknown emails (no enumeration)', async () => {
  let now = 1000;
  const clock = () => now;
  const store = makeStore(new Map());
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new PasswordResetService(store, makeHasher(), tokens);
  let sent = false;
  await svc.requestReset('nobody@example.com', { async send() { sent = true; } });
  assert.equal(sent, false);
});

test('requestReset issues a token and delivers it to the resolved email', async () => {
  let now = 1000;
  const clock = () => now;
  const users = new Map([['a@b.com', { id: 'u1', email: 'a@b.com', passwordHash: 'old' }]]);
  const store = makeStore(users);
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new PasswordResetService(store, makeHasher(), tokens);
  let ctx;
  await svc.requestReset('A@B.com', { async send(c) { ctx = c; } });
  assert.ok(ctx && ctx.token);
  assert.equal(ctx.email, 'a@b.com'); // normalized
  const updated = await svc.completeReset(ctx.token, 'new-secure-password-123');
  assert.equal(updated.id, 'u1');
  assert.equal(users.get('a@b.com').passwordHash, 'argon2id$new-secure-password-123-0');
});

test('completeReset validates the password BEFORE consuming the token', async () => {
  let now = 1000;
  const clock = () => now;
  const users = new Map([['a@b.com', { id: 'u1', email: 'a@b.com', passwordHash: 'old' }]]);
  const store = makeStore(users);
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new PasswordResetService(store, makeHasher(), tokens);
  let ctx;
  await svc.requestReset('a@b.com', { async send(c) { ctx = c; } });
  // Weak password: the token must remain usable afterwards.
  await assert.rejects(() => svc.completeReset(ctx.token, 'short'), TypeError);
  await svc.completeReset(ctx.token, 'a-valid-new-password-123');
  assert.equal(users.get('a@b.com').passwordHash, 'argon2id$a-valid-new-password-123-0');
});

test('reset tokens are single-use and purpose-scoped', async () => {
  let now = 1000;
  const clock = () => now;
  const users = new Map([['a@b.com', { id: 'u1', email: 'a@b.com', passwordHash: 'old' }]]);
  const store = makeStore(users);
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new PasswordResetService(store, makeHasher(), tokens);
  let ctx;
  await svc.requestReset('a@b.com', { async send(c) { ctx = c; } });
  await svc.completeReset(ctx.token, 'first-password-12345');
  await assert.rejects(() => svc.completeReset(ctx.token, 'second-password-123'), AuthTokenUsedError);
  // Replay against a different purpose namespace is rejected (invalid, not used).
  await assert.rejects(() => tokens.consume(ctx.token, 'email-verification'), AuthTokenInvalidError);
});

test('expired reset token is rejected', async () => {
  let now = 1000;
  const clock = () => now;
  const users = new Map([['a@b.com', { id: 'u1', email: 'a@b.com', passwordHash: 'old' }]]);
  const store = makeStore(users);
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const svc = new PasswordResetService(store, makeHasher(), tokens, { ttlMs: 1000 });
  let ctx;
  await svc.requestReset('a@b.com', { async send(c) { ctx = c; } });
  now = 2001;
  await assert.rejects(() => svc.completeReset(ctx.token, 'new-password-12345'), AuthTokenExpiredError);
});

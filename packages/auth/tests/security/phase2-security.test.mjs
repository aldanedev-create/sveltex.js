import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, AuthForbiddenError, AuthUnauthorizedError } from '../../dist/index.js';
import { FixedWindowLimiter } from '../../dist/limiter.js';
import { RbacBuilder } from '../../dist/rbac.js';
import { TokenManager, MemoryTokenStore } from '../../dist/tokens.js';
import { PasswordResetService } from '../../dist/reset.js';
import { AuthTokenUsedError } from '../../dist/errors.js';

// --- Timing / user-enumeration protections ---------------------------------

test('login verifies the dummy hash for unknown accounts (equalizes timing)', async () => {
  let verified = null;
  const auth = new AuthService(
    { async findByEmail() { return undefined; }, async createIfAbsent() { return undefined; } },
    { async hash() { return 'argon2id$long-enough-hash-value-here-1234567890'; }, async verify(_p, h) { verified = h; return false; } },
    { async create() { return { id: 's' }; }, async destroy() {} },
    { dummyPasswordHash: 'argon2id$application-specific-dummy-hash-value' },
  );
  assert.equal(await auth.login('missing@example.com', 'any password'), undefined);
  assert.equal(verified, 'argon2id$application-specific-dummy-hash-value');
});

test('login never reveals whether the user exists via the returned shape', async () => {
  const auth = new AuthService(
    { async findByEmail() { return undefined; }, async createIfAbsent() { return undefined; } },
    { async hash() { return 'argon2id$long-enough-hash-value-here-1234567890'; }, async verify() { return false; } },
    { async create() { return { id: 's' }; }, async destroy() {} },
    { dummyPasswordHash: 'argon2id$application-specific-dummy-hash-value' },
  );
  // Unknown user and wrong password both resolve to `undefined` with no throw.
  assert.equal(await auth.login('nope@example.com', 'x'), undefined);
  assert.equal(await auth.login('exists@example.com', 'wrong'), undefined);
});

// --- Brute-force protection -------------------------------------------------

test('rate limiter blocks attempts before the credential lookup runs', async () => {
  let lookupCalls = 0;
  const limiter = new FixedWindowLimiter({ max: 3, windowMs: 60_000, now: () => 0 });
  const auth = new AuthService(
    { async findByEmail() { lookupCalls++; return undefined; }, async createIfAbsent() { return undefined; } },
    { async hash() { return 'argon2id$long-enough-hash-value-here-1234567890'; }, async verify() { return false; } },
    { async create() { return { id: 's' }; }, async destroy() {} },
    { limiter, dummyPasswordHash: 'argon2id$application-specific-dummy-hash-value' },
  );
  await auth.login('a@b.com', 'pw');
  await auth.login('a@b.com', 'pw');
  await auth.login('a@b.com', 'pw');
  assert.equal(await auth.login('a@b.com', 'pw'), undefined); // blocked
  assert.equal(lookupCalls, 3); // the 4th never reached the store
});

// --- Permission enforcement / authorization bypass -------------------------

test('RBAC denies by default and cannot be escalated by unknown roles', () => {
  const rbac = new RbacBuilder();
  rbac.defineRole('user', { permissions: ['profile:read'] });
  rbac.defineRole('admin', { permissions: ['users:read'] });
  // A user presenting a forged/absent role list is denied admin capability.
  assert.throws(() => rbac.requirePermission(['user'], 'users:read'), AuthForbiddenError);
  assert.throws(() => rbac.requirePermission(['hacker'], 'users:read'), AuthForbiddenError);
});

test('missing roles cannot satisfy a required permission (no authz bypass)', () => {
  const rbac = new RbacBuilder();
  rbac.defineRole('admin', { permissions: ['users:delete'] });
  // No roles at all resolves to Unauthorized (401), never to a granted permission.
  assert.throws(() => rbac.requirePermission(undefined, 'users:delete'), AuthUnauthorizedError);
});

// --- Token replay / single-use protections ----------------------------------

test('a password-reset token cannot be replayed after redemption', async () => {
  let now = 1000;
  const clock = () => now;
  const users = new Map([['a@b.com', { id: 'u1', email: 'a@b.com', passwordHash: 'old' }]]);
  const store = {
    users,
    async findByEmail(email) { return users.get(email); },
    async findById(id) { for (const u of users.values()) if (u.id === id) return u; return undefined; },
    async updatePassword(id, h) { for (const u of users.values()) if (u.id === id) { u.passwordHash = h; return true; } return false; },
  };
  const tokens = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const hasher = { async hash(pw) { return `argon2id$${pw}`; }, async verify() { return false; } };
  const svc = new PasswordResetService(store, hasher, tokens);
  let ctx;
  await svc.requestReset('a@b.com', { async send(c) { ctx = c; } });
  await svc.completeReset(ctx.token, 'first-password-12345');
  // Replay attempt is rejected (single-use), even with a valid new password.
  await assert.rejects(() => svc.completeReset(ctx.token, 'second-password-123'), AuthTokenUsedError);
});

// --- Invalid / expired credential handling ----------------------------------

test('login with malformed inputs fails closed without leaking internals', async () => {
  const auth = new AuthService(
    { async findByEmail() { return undefined; }, async createIfAbsent() { return undefined; } },
    { async hash() { return 'argon2id$long-enough-hash-value-here-1234567890'; }, async verify() { return false; } },
    { async create() { return { id: 's' }; }, async destroy() {} },
    { dummyPasswordHash: 'argon2id$application-specific-dummy-hash-value' },
  );
  await assert.rejects(() => auth.login('bad', 'x'), TypeError); // invalid email
  await assert.rejects(() => auth.login('a@b.com', 'x'.repeat(4097)), TypeError); // over-max password
});

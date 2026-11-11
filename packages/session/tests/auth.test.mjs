import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '@sveltex/auth';
import { Argon2Hasher, generateDummyHash } from '@sveltex/auth/argon2';
import { MemorySessionStore, SessionManager, SessionRevocationUnsupportedError } from '../dist/index.js';
import {
  createAuthSessionPort,
  supportsRevocation,
  revokeAllForUser,
  SessionRevocationUnsupportedError as ReexportedError,
} from '../dist/auth.js';

function manager(overrides = {}) {
  let n = 0;
  return new SessionManager(new MemorySessionStore(), {
    ttlMs: 60_000,
    createId: () => `session_auth_${String(++n).padStart(6, '0')}`,
    ...overrides,
  });
}

test('createAuthSessionPort.create stores userId and returns a valid session', async () => {
  const m = manager();
  const port = createAuthSessionPort(m);
  const session = await port.create({ userId: 'u1' });
  assert.equal(session.data.userId, 'u1');
  assert.equal(session.revision, 1);
  assert.equal((await m.get(session.id))?.data.userId, 'u1');
});

test('createAuthSessionPort.destroy removes the session (logout)', async () => {
  const m = manager();
  const port = createAuthSessionPort(m);
  const session = await port.create({ userId: 'u1' });
  await port.destroy(session.id);
  assert.equal(await m.get(session.id), undefined);
});

test('createAuthSessionPort.rotate invalidates the old id (session-fixation defence)', async () => {
  const m = manager();
  const port = createAuthSessionPort(m);
  const original = await port.create({ userId: 'u1' });
  const rotated = await port.rotate(original.id);
  assert.notEqual(rotated.id, original.id);
  assert.equal(await m.get(original.id), undefined);
  assert.equal((await m.get(rotated.id))?.data.userId, 'u1');
  assert.equal(await port.rotate('session_auth_missing_001'), undefined);
});

test('createAuthSessionPort rejects invalid userId and a missing manager', async () => {
  assert.throws(() => createAuthSessionPort({}), TypeError);
  const port = createAuthSessionPort(manager());
  await assert.rejects(() => port.create({ userId: '' }), TypeError);
  await assert.rejects(() => port.create({}), TypeError);
  await assert.rejects(() => port.create({ userId: 'x'.repeat(256) }), TypeError);
});

test('supportsRevocation detects the capability and revokeAllForUser throws otherwise', async () => {
  assert.equal(supportsRevocation(new MemorySessionStore()), true);
  const bare = {
    get: async () => undefined,
    createIfAbsent: async () => true,
    compareAndSet: async () => true,
    delete: async () => undefined,
    rotate: async () => true,
  };
  assert.equal(supportsRevocation(bare), false);
  await assert.rejects(() => revokeAllForUser(bare, 'u1'), SessionRevocationUnsupportedError);
  assert.equal(ReexportedError, SessionRevocationUnsupportedError);
});

test('SessionManager.revokeAllForUser throws on a store without the capability', async () => {
  const bare = {
    get: async () => undefined,
    createIfAbsent: async () => true,
    compareAndSet: async () => true,
    delete: async () => undefined,
    rotate: async () => true,
  };
  const m = new SessionManager(bare);
  await assert.rejects(() => m.revokeAllForUser('u1'), SessionRevocationUnsupportedError);
});

test('MemorySessionStore.revokeAllForUser removes only the target user\'s sessions', async () => {
  const m = manager();
  const a = await m.create({ userId: 'alice' });
  const b = await m.create({ userId: 'bob' });
  const c = await m.create({ userId: 'alice' });
  assert.equal(await m.revokeAllForUser('alice'), 2);
  assert.equal(await m.get(a.id), undefined);
  assert.equal((await m.get(b.id))?.data.userId, 'bob');
  assert.equal(await m.get(c.id), undefined);
  assert.equal(await m.revokeAllForUser('alice'), 0);
  await assert.rejects(() => m.revokeAllForUser(''), TypeError);
});

test('real @sveltex/auth AuthService: register → login → rotate → revoke → logout', async () => {
  const hasher = new Argon2Hasher();
  const dummyPasswordHash = await generateDummyHash();
  const users = {
    store: new Map(),
    async findByEmail(email) { return this.store.get(email); },
    async createIfAbsent(input) {
      if (this.store.has(input.email)) return undefined;
      const rec = { id: 'user-1', email: input.email, passwordHash: input.passwordHash, roles: ['user'] };
      this.store.set(input.email, rec);
      return rec;
    },
  };
  const m = manager();
  const port = createAuthSessionPort(m);
  const auth = new AuthService(users, hasher, port, { dummyPasswordHash });

  await auth.register({ email: 'Alice@Example.com', password: 'correct-horse-battery' });
  const result = await auth.login('alice@example.com', 'correct-horse-battery');
  assert.ok(result);
  assert.equal(result.user.id, 'user-1');
  assert.equal(result.session.data.userId, 'user-1');
  assert.equal(result.user.passwordHash, undefined);

  const rotated = await auth.rotateSession(result.session.id);
  assert.notEqual(rotated.id, result.session.id);
  assert.equal(await m.get(result.session.id), undefined);

  assert.equal(await m.revokeAllForUser('user-1'), 1);
  assert.equal(await m.get(rotated.id), undefined);

  const second = await auth.login('alice@example.com', 'correct-horse-battery');
  await auth.logout(second.session.id);
  assert.equal(await m.get(second.session.id), undefined);
});

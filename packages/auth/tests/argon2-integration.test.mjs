import test from 'node:test';
import assert from 'node:assert/strict';
import { Argon2Hasher, generateDummyHash } from '../dist/argon2.js';
import { AuthService, AuthConflictError } from '../dist/index.js';

const TEST_PASSWORD = 'my-very-secure-password-123';
const WEAK_PASSWORD = 'short';

test('argon2 hasher: hash produces a valid Argon2id encoded string', async () => {
  const hasher = new Argon2Hasher();
  const hash = await hasher.hash(TEST_PASSWORD);
  assert.ok(typeof hash === 'string');
  assert.ok(hash.startsWith('$argon2id$'), `Hash should start with $argon2id$, got: ${hash.substring(0, 20)}...`);
  assert.ok(hash.length > 40, 'Hash should be reasonably long');
  assert.ok(hash.includes('$m='), 'Hash should contain memory cost parameter');
});

test('argon2 hasher: verify succeeds with correct password', async () => {
  const hasher = new Argon2Hasher();
  const hash = await hasher.hash(TEST_PASSWORD);
  const valid = await hasher.verify(TEST_PASSWORD, hash);
  assert.equal(valid, true);
});

test('argon2 hasher: verify fails with wrong password', async () => {
  const hasher = new Argon2Hasher();
  const hash = await hasher.hash(TEST_PASSWORD);
  const valid = await hasher.verify('completely-wrong-password', hash);
  assert.equal(valid, false);
});

test('argon2 hasher: each hash produces a unique salt', async () => {
  const hasher = new Argon2Hasher();
  const hash1 = await hasher.hash(TEST_PASSWORD);
  const hash2 = await hasher.hash(TEST_PASSWORD);
  assert.notEqual(hash1, hash2, 'Two hashes of the same password should differ due to random salt');
  // Both should verify against the same password
  assert.equal(await hasher.verify(TEST_PASSWORD, hash1), true);
  assert.equal(await hasher.verify(TEST_PASSWORD, hash2), true);
});

test('argon2 hasher: rejects empty password', async () => {
  const hasher = new Argon2Hasher();
  await assert.rejects(() => hasher.hash(''), TypeError);
});

test('argon2 hasher: rejects non-string password', async () => {
  const hasher = new Argon2Hasher();
  await assert.rejects(() => hasher.hash(null), TypeError);
  await assert.rejects(() => hasher.hash(123), TypeError);
});

test('argon2 hasher: verify returns false for invalid hash format', async () => {
  const hasher = new Argon2Hasher();
  assert.equal(await hasher.verify(TEST_PASSWORD, 'not-a-valid-hash'), false);
  assert.equal(await hasher.verify(TEST_PASSWORD, '$bcrypt$invalid'), false);
  assert.equal(await hasher.verify(TEST_PASSWORD, ''), false);
});

test('argon2 hasher: verify returns false for empty password', async () => {
  const hasher = new Argon2Hasher();
  const hash = await hasher.hash(TEST_PASSWORD);
  assert.equal(await hasher.verify('', hash), false);
});

test('argon2 hasher: custom parameters work', async () => {
  // Use lower memory cost for faster tests
  const hasher = new Argon2Hasher({ memoryCost: 4096, timeCost: 1, parallelism: 1 });
  const hash = await hasher.hash(TEST_PASSWORD);
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(await hasher.verify(TEST_PASSWORD, hash), true);
});

test('argon2 hasher: rejects invalid constructor parameters', () => {
  assert.throws(() => new Argon2Hasher({ memoryCost: 0 }), RangeError);
  assert.throws(() => new Argon2Hasher({ memoryCost: -1 }), RangeError);
  assert.throws(() => new Argon2Hasher({ timeCost: 0 }), RangeError);
  assert.throws(() => new Argon2Hasher({ parallelism: 0 }), RangeError);
});

test('argon2 hasher: rejects overly long password', async () => {
  const hasher = new Argon2Hasher();
  const longPassword = 'a'.repeat(2000);
  await assert.rejects(() => hasher.hash(longPassword), TypeError);
});

test('generateDummyHash produces a valid Argon2id hash', async () => {
  const dummyHash = await generateDummyHash();
  assert.ok(typeof dummyHash === 'string');
  assert.ok(dummyHash.startsWith('$argon2id$'));
  assert.ok(dummyHash.length > 40);
  // Should be verifiable (against the original dummy password, though we don't know it)
  // The key property is that it's a valid hash format
});

test('argon2 hasher: full AuthService integration with real Argon2id', async () => {
  const hasher = new Argon2Hasher({ memoryCost: 4096, timeCost: 1 });
  const dummyHash = await generateDummyHash();

  const users = new Map();
  const sessions = new Map();
  const store = {
    async findByEmail(email) { return users.get(email); },
    async createIfAbsent(user) {
      if (users.has(user.email)) return undefined;
      const record = { id: `user_${users.size + 1}`, ...user };
      users.set(user.email, record);
      return record;
    },
  };
  const sessionPort = {
    async create(data) {
      const session = { id: `session_identifier_${sessions.size + 1}`, ...data };
      sessions.set(session.id, session);
      return session;
    },
    async destroy(id) { sessions.delete(id); },
    async rotate(id) {
      const prev = sessions.get(id);
      if (!prev) return undefined;
      sessions.delete(id);
      const next = { ...prev, id: `session_identifier_rotated_${sessions.size + 1}` };
      sessions.set(next.id, next);
      return next;
    },
  };

  const auth = new AuthService(store, hasher, sessionPort, { dummyPasswordHash: dummyHash });

  // Register
  const user = await auth.register({ email: 'test@example.com', password: TEST_PASSWORD });
  assert.equal(user.email, 'test@example.com');
  assert.equal('passwordHash' in user, false);

  // Login with correct password
  const result = await auth.login('test@example.com', TEST_PASSWORD);
  assert.ok(result, 'Login should succeed with correct password');
  assert.equal(result.user.email, 'test@example.com');
  assert.ok(result.session.id.startsWith('session_identifier_'));

  // Login with wrong password
  const failed = await auth.login('test@example.com', 'wrong-password-xyz');
  assert.equal(failed, undefined);

  // Login with non-existent user (should use dummy hash for timing)
  const noUser = await auth.login('nobody@example.com', TEST_PASSWORD);
  assert.equal(noUser, undefined);

  // Logout
  await auth.logout(result.session.id);
  assert.equal(sessions.size, 0);
});

test('argon2 hasher: verify does not throw on corrupted hash', async () => {
  const hasher = new Argon2Hasher();
  // Corrupted but starts with $argon2
  assert.equal(await hasher.verify(TEST_PASSWORD, '$argon2id$corrupted'), false);
  assert.equal(await hasher.verify(TEST_PASSWORD, '$argon2id$v=19$m=19456,t=2,p=1$invalid$alsobroken'), false);
});

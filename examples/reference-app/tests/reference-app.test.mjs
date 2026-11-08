import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthConflictError } from '@sveltex/auth';
import { ValidationError } from '@sveltex/validation';
import { createApp } from '../dist/index.js';

const PASSWORD = 'correct-horse-battery-staple-42';

function registration(email = 'alice@example.com', overrides = {}) {
  return { email, password: PASSWORD, displayName: 'Alice', ...overrides };
}

async function harness(t, options = {}) {
  const app = await createApp(options);
  t.after(async () => {
    try { await app.close(); } catch { /* close() is idempotent */ }
  });
  return app;
}

test('register validates input and rejects malformed payloads', async (t) => {
  const app = await harness(t);
  await assert.rejects(
    () => app.register({ email: 'not-an-email', password: 'short', displayName: '' }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.issues.length >= 3);
      return true;
    },
  );
  for (const bad of [null, 42, 'text', ['array']]) {
    await assert.rejects(() => app.register(bad), { name: 'ValidationError' });
  }
});

test('register persists a user without leaking the password hash', async (t) => {
  const app = await harness(t);
  const user = await app.register(registration('Alice@Example.COM'));
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.displayName, 'Alice');
  assert.deepEqual(user.roles, ['user']);
  assert.match(user.id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof user.createdAt, 'number');
  assert.equal(Object.prototype.hasOwnProperty.call(user, 'passwordHash'), false);

  const rows = await app.database.query('SELECT password_hash FROM users WHERE id = ?', [user.id]);
  assert.equal(rows.rows.length, 1);
  assert.match(String(rows.rows[0]['password_hash']), /^\$argon2id\$/);
});

test('duplicate email is rejected atomically', async (t) => {
  const app = await harness(t);
  await app.register(registration('dupe@example.com'));
  await assert.rejects(() => app.register(registration('DUPE@example.com')), AuthConflictError);
  const rows = await app.database.query('SELECT COUNT(*) AS n FROM users');
  assert.equal(Number(rows.rows[0]['n']), 1);
});

test('client-supplied roles cannot self-grant admin', async (t) => {
  const app = await harness(t);
  const user = await app.register(registration('mallory@example.com', { roles: ['admin'] }));
  assert.deepEqual(user.roles, ['user']);
  const token = await app.login('mallory@example.com', PASSWORD);
  await assert.rejects(() => app.listUsers(token.id), { name: 'AuthorizationError' });
});

test('login succeeds with correct credentials and rejects bad ones', async (t) => {
  const app = await harness(t);
  await app.register(registration());
  const token = await app.login('ALICE@example.com', PASSWORD);
  assert.match(token.id, /^[A-Za-z0-9_-]{16,256}$/);
  assert.equal(typeof token.userId, 'string');
  assert.ok(token.expiresAt > Date.now());
  await assert.rejects(() => app.login('alice@example.com', 'wrong-password'), { name: 'AuthenticationError' });
  await assert.rejects(() => app.login('nobody@example.com', PASSWORD), { name: 'AuthenticationError' });
});

test('currentUser resolves the principal from a live session', async (t) => {
  const app = await harness(t);
  const user = await app.register(registration());
  const token = await app.login('alice@example.com', PASSWORD);
  const me = await app.currentUser(token.id);
  assert.equal(me.id, user.id);
  assert.equal(me.email, user.email);
});

test('logout invalidates the session', async (t) => {
  const app = await harness(t);
  await app.register(registration());
  const token = await app.login('alice@example.com', PASSWORD);
  await app.logout(token.id);
  await assert.rejects(() => app.currentUser(token.id), { name: 'AuthenticationError' });
  assert.equal(await app.sessionManager.get(token.id), undefined);
});

test('rotateSession invalidates the old id and returns a working new one', async (t) => {
  const app = await harness(t);
  const user = await app.register(registration());
  const token = await app.login('alice@example.com', PASSWORD);
  const rotated = await app.rotateSession(token.id);
  assert.ok(rotated);
  assert.notEqual(rotated.id, token.id);
  assert.equal(rotated.userId, user.id);
  await assert.rejects(() => app.currentUser(token.id), { name: 'AuthenticationError' });
  assert.equal((await app.currentUser(rotated.id)).id, user.id);
});

test('invalid session identifiers are rejected as authentication errors', async (t) => {
  const app = await harness(t);
  for (const id of ['', 'short', 'has spaces in it!!', 'x'.repeat(300)]) {
    await assert.rejects(() => app.currentUser(id), { name: 'AuthenticationError' });
    await assert.rejects(() => app.logout(id), { name: 'AuthenticationError' });
    await assert.rejects(() => app.rotateSession(id), { name: 'AuthenticationError' });
  }
  // Well-formed but unknown ids must also fail closed.
  await assert.rejects(() => app.currentUser('x'.repeat(36)), { name: 'AuthenticationError' });
});

test('createPost requires authentication and validates the payload', async (t) => {
  const app = await harness(t);
  const user = await app.register(registration());
  await assert.rejects(
    () => app.createPost('x'.repeat(36), { title: 'Hello', body: 'World' }),
    { name: 'AuthenticationError' },
  );
  const token = await app.login('alice@example.com', PASSWORD);
  await assert.rejects(
    () => app.createPost(token.id, { title: '', body: '' }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues.length, 2);
      return true;
    },
  );
  const post = await app.createPost(token.id, {
    title: '  Hello  ', body: '  World  ', authorId: 'attacker',
  });
  assert.equal(post.title, 'Hello');
  assert.equal(post.body, 'World');
  assert.equal(post.authorId, user.id);
});

test('listPosts is cached and invalidated on write', async (t) => {
  const app = await harness(t);
  await app.register(registration());
  const token = await app.login('alice@example.com', PASSWORD);
  assert.deepEqual(await app.listPosts(), []);
  const post = await app.createPost(token.id, { title: 'One', body: 'First' });
  const posts = await app.listPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, post.id);
  const cached = await app.cache.get('posts:list');
  assert.ok(Array.isArray(cached));
  assert.equal(cached.length, 1);
  assert.deepEqual(await app.listPosts(), posts);
});

test('getPublicProfile uses the cache', async (t) => {
  const app = await harness(t);
  const user = await app.register(registration());
  const profile = await app.getPublicProfile(user.id);
  assert.equal(profile.id, user.id);
  const cached = await app.cache.get(`user:${user.id}`);
  assert.equal(cached.id, user.id);
  assert.equal(await app.getPublicProfile('missing-id'), undefined);
});

test('role-based authorization denies ordinary users', async (t) => {
  const app = await harness(t);
  await app.register(registration());
  const token = await app.login('alice@example.com', PASSWORD);
  await assert.rejects(() => app.listUsers(token.id), { name: 'AuthorizationError' });
  await assert.rejects(() => app.grantRole(token.id, 'anyone', 'editor'), { name: 'AuthorizationError' });
});

test('trusted bootstrap grants admin and admin can list users', async (t) => {
  const app = await harness(t, { adminEmails: ['BOSS@Example.com'] });
  const boss = await app.register(registration('boss@example.com'));
  assert.ok(boss.roles.includes('admin'));
  const alice = await app.register(registration('alice@example.com'));
  assert.deepEqual(alice.roles, ['user']);
  const token = await app.login('boss@example.com', PASSWORD);
  const users = await app.listUsers(token.id);
  assert.equal(users.length, 2);
  assert.ok(users.every(u => !Object.prototype.hasOwnProperty.call(u, 'passwordHash')));
});

test('grantRole updates privileges in a transaction and invalidates the profile cache', async (t) => {
  const app = await harness(t, { adminEmails: ['boss@example.com'] });
  await app.register(registration('boss@example.com'));
  const alice = await app.register(registration('alice@example.com'));
  const bossToken = await app.login('boss@example.com', PASSWORD);

  const before = await app.getPublicProfile(alice.id);
  assert.deepEqual(before.roles, ['user']);
  assert.equal(await app.cache.has(`user:${alice.id}`), true);

  const roles = await app.grantRole(bossToken.id, alice.id, 'editor');
  assert.deepEqual(roles, ['user', 'editor']);
  assert.equal(await app.cache.has(`user:${alice.id}`), false);

  const after = await app.getPublicProfile(alice.id);
  assert.ok(after.roles.includes('editor'));
  const users = await app.listUsers(bossToken.id);
  assert.ok(users.find(u => u.id === alice.id).roles.includes('editor'));

  assert.deepEqual(await app.grantRole(bossToken.id, alice.id, 'editor'), ['user', 'editor']);
  await assert.rejects(
    () => app.grantRole(bossToken.id, alice.id, 'superadmin'),
    { name: 'AuthorizationError' },
  );
  await assert.rejects(
    () => app.grantRole(bossToken.id, 'does-not-exist', 'editor'),
    { name: 'AuthorizationError' },
  );
});

test('expired sessions are rejected', async (t) => {
  let clock = 1_000_000;
  const app = await harness(t, { now: () => clock, sessionTtlMs: 1000, cacheTtlMs: 5000 });
  await app.register(registration());
  const token = await app.login('alice@example.com', PASSWORD);
  assert.equal((await app.currentUser(token.id)).email, 'alice@example.com');
  clock += 2000;
  await assert.rejects(() => app.currentUser(token.id), { name: 'AuthenticationError' });
  assert.equal(await app.sessionManager.get(token.id), undefined);
});

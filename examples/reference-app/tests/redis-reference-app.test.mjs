import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/index.js';

const REDIS_URL = process.env['SVELTEX_REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const parsed = new URL(REDIS_URL);
const PASSWORD = 'correct-horse-battery-staple-42';

// Pure TCP probe: no extra dependency, no socket left behind to hold the event loop open.
async function redisAvailable() {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
    });
    socket.setTimeout(1500);
    const settle = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

const READY = await redisAvailable();
const skip = READY ? false : 'Redis is unreachable — real integration skipped, no fake provider substituted';

function registration(email) {
  return { email, password: PASSWORD, displayName: email.split('@')[0] };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sveltex-ref-'));
  const options = {
    databasePath: join(dir, 'app.sqlite'),
    redisUrl: REDIS_URL,
    redisKeyPrefix: `sveltex-ref-test:${randomUUID()}:`,
    adminEmails: ['boss@example.com'],
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return options;
}

test('Redis-backed sessions and cache survive an app restart', { skip }, async (t) => {
  const options = fixture(t);

  const app1 = await createApp(options);
  t.after(async () => { try { await app1.close(); } catch { /* idempotent */ } });
  const user = await app1.register(registration('alice@example.com'));
  const token = await app1.login('alice@example.com', PASSWORD);
  const post = await app1.createPost(token.id, { title: 'Hello', body: 'World' });
  assert.equal((await app1.listPosts()).length, 1);
  assert.equal(await app1.cache.has('posts:list'), true);
  await app1.close(); // simulate a process exit

  const app2 = await createApp(options); // same SQLite file + same Redis namespace
  t.after(async () => {
    try { await app2.cache.clear(); } catch { /* best effort */ }
    try { await app2.close(); } catch { /* idempotent */ }
  });

  assert.equal((await app2.currentUser(token.id)).id, user.id); // session survived
  const posts = await app2.listPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, post.id);
  const cached = await app2.cache.get('posts:list');
  assert.ok(Array.isArray(cached)); // cache survived
  assert.equal(cached.length, 1);

  const rotated = await app2.rotateSession(token.id);
  assert.ok(rotated);
  assert.notEqual(rotated.id, token.id);
  await assert.rejects(() => app2.currentUser(token.id), { name: 'AuthenticationError' });
  assert.equal((await app2.currentUser(rotated.id)).id, user.id);
});

test('concurrent app instances share Redis sessions atomically', { skip }, async (t) => {
  const options = fixture(t);

  const app1 = await createApp(options);
  const app2 = await createApp(options);
  for (const app of [app1, app2]) {
    t.after(async () => {
      try { await app.cache.clear(); } catch { /* best effort */ }
      try { await app.close(); } catch { /* idempotent */ }
    });
  }

  const user = await app1.register(registration('alice@example.com'));
  const token = await app1.login('alice@example.com', PASSWORD);

  // A session minted by app1 is visible to app2.
  assert.equal((await app2.currentUser(token.id)).id, user.id);

  // Rotation performed by app2 immediately invalidates the old id for app1.
  const rotated = await app2.rotateSession(token.id);
  assert.ok(rotated);
  await assert.rejects(() => app1.currentUser(token.id), { name: 'AuthenticationError' });
  assert.equal((await app1.currentUser(rotated.id)).id, user.id);

  // Logout on app1 invalidates the session for app2 as well.
  await app1.logout(rotated.id);
  await assert.rejects(() => app2.currentUser(rotated.id), { name: 'AuthenticationError' });
});

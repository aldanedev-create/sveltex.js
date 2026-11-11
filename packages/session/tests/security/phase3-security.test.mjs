import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@sveltex/database';
import { SqliteAdapter } from '@sveltex/database/sqlite';
import { MemorySessionStore, SessionManager } from '../../dist/index.js';
import { DEFAULT_SESSION_COOKIE_NAME } from '../../dist/cookie.js';
import { SessionCookieTransport, resolveSessionCookieOptions, serializeSetCookie, parseCookieHeader } from '../../dist/cookie.js';
import { CsrfProtection } from '../../dist/csrf.js';
import { DatabaseSessionStore } from '../../dist/database.js';

function makeJar(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get(name) { return values.get(name); },
    set(name, value, options) { values.set(name, value); },
    delete(name, options) { values.delete(name); },
  };
}

function makeManager() {
  let n = 0;
  return new SessionManager(new MemorySessionStore(), {
    now: () => 1000, ttlMs: 60_000,
    createId: () => `session_security_${String(++n).padStart(6, '0')}`,
  });
}

test('SEC: Set-Cookie injection via name, value and path is rejected', () => {
  const opts = resolveSessionCookieOptions();
  assert.throws(() => serializeSetCookie('sid\r\nX-Evil: 1', 'v', opts), Error);
  assert.throws(() => serializeSetCookie(opts.name, 'v\r\nSet-Cookie: session=attacker', opts), Error);
  assert.throws(() => serializeSetCookie(opts.name, 'v; Domain=evil.example', opts), Error);
  assert.throws(() => resolveSessionCookieOptions({ path: '/\r\nX: y' }), Error);
});

test('SEC: session id cookie defaults are HttpOnly + Secure + SameSite=Lax + __Host-', () => {
  const o = resolveSessionCookieOptions();
  assert.equal(o.httpOnly, true);
  assert.equal(o.secure, true);
  assert.equal(o.sameSite, 'lax');
  assert.equal(o.path, '/');
  assert.ok(o.name.startsWith('__Host-'));
  assert.equal(serializeSetCookie(o.name, 'session_security_000001', o).includes('Domain='), false);
});

test('SEC: __Host- prefix hardening cannot be downgraded', () => {
  assert.throws(() => resolveSessionCookieOptions({ secure: false }), Error);
  assert.throws(() => resolveSessionCookieOptions({ domain: 'example.com' }), Error);
  assert.throws(() => resolveSessionCookieOptions({ path: '/app' }), Error);
  assert.throws(() => resolveSessionCookieOptions({ sameSite: 'none', secure: false }), Error);
});

test('SEC: cookie header parsing cannot pollute Object.prototype', () => {
  const parsed = parseCookieHeader('__proto__=evil; constructor=polluted; ok=1');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.prototype.evil, undefined);
  assert.equal(parsed['ok'], '1');
});

test('SEC: forged / mismatched CSRF tokens are rejected in constant time', () => {
  const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
  const issued = csrf.issue('session-aaa');
  assert.throws(() => csrf.assertValid({ method: 'POST', headerToken: 'forged', cookieToken: issued.value, sessionId: 'session-aaa' }), { code: 'CSRF_TOKEN_MISMATCH' });
  assert.throws(() => csrf.assertValid({ method: 'POST' }), { code: 'CSRF_TOKEN_MISSING' });
  assert.throws(() => csrf.assertValid({ method: 'POST', headerToken: issued.value }), { code: 'CSRF_COOKIE_MISSING' });
});

test('SEC: a token bound to one session cannot protect a different session', () => {
  const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
  const issued = csrf.issue('session-aaa');
  assert.throws(() => csrf.assertValid({
    method: 'POST', headerToken: issued.value, cookieToken: issued.value, sessionId: 'session-bbb',
  }), { code: 'CSRF_TOKEN_INVALID' });
});

test('SEC: safe methods need no CSRF token, unsafe methods always do', () => {
  const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) assert.doesNotThrow(() => csrf.assertValid({ method }));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.throws(() => csrf.assertValid({ method }), { code: 'CSRF_TOKEN_MISSING' });
});

test('SEC: session fixation — rotation rewrites the cookie and the old id is dead', async () => {
  const jar = makeJar();
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  const original = await transport.create({ userId: 'u1', role: 'user' });
  const oldId = original.id;
  const rotated = await transport.rotate();
  assert.notEqual(rotated.id, oldId);
  assert.equal(jar.values.get(DEFAULT_SESSION_COOKIE_NAME), rotated.id);
  const privileged = await transport.read();
  assert.equal(privileged.id, rotated.id);
  assert.equal((await transport.read()).data.role, 'user');
});

test('SEC: stale / tampered cookies are cleared, never accepted as a session', async () => {
  for (const bad of ['short', 'session_security_999999', '../../etc/passwd']) {
    const jar = makeJar({ [DEFAULT_SESSION_COOKIE_NAME]: bad });
    const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
    assert.equal(await transport.read(), undefined);
    assert.equal(jar.values.has(DEFAULT_SESSION_COOKIE_NAME), false);
  }
});

test('SEC: concurrent updates cannot silently lose data — a conflict is raised', async () => {
  const store = new MemorySessionStore();
  const manager = new SessionManager(store, { now: () => 1000, ttlMs: 60_000, createId: () => 'session_security_concurrent_01' });
  const created = await manager.create({ count: 0 });
  const conflicting = new SessionManager({
    get: id => store.get(id), createIfAbsent: r => store.createIfAbsent(r),
    compareAndSet: async () => false, delete: id => store.delete(id),
    rotate: (id, rev, r) => store.rotate(id, rev, r),
  }, { now: () => 1000, ttlMs: 60_000 });
  await assert.rejects(() => conflicting.update(created.id, d => ({ ...d, count: 1 })), { name: 'SessionConflictError' });
  assert.equal((await manager.get(created.id)).data.count, 0);
});

test('SEC: a failing store never yields a fabricated session', async () => {
  const failing = {
    get: async () => { throw new Error('store outage'); },
    createIfAbsent: async () => { throw new Error('store outage'); },
    compareAndSet: async () => false,
    delete: async () => undefined,
    rotate: async () => false,
  };
  const manager = new SessionManager(failing);
  await assert.rejects(() => manager.get('session_security_outage_01'), /store outage/);
  await assert.rejects(() => manager.create({ userId: 'u1' }), /store outage/);
});

test('SEC: application shutdown — a closed database cannot be used to mint or read sessions', async () => {
  const db = new Database(new SqliteAdapter({ path: ':memory:' }));
  await db.connect();
  const store = new DatabaseSessionStore(db, { dialect: 'sqlite', tableName: 'p3_security_shutdown' });
  const manager = new SessionManager(store, { ttlMs: 60_000 });
  const created = await manager.create({ userId: 'u1' });
  assert.equal((await manager.get(created.id))?.data.userId, 'u1');
  await db.close();
  await assert.rejects(() => manager.get(created.id), Error);
  await assert.rejects(() => manager.create({ userId: 'u2' }), Error);
  await assert.rejects(() => manager.update(created.id, d => ({ ...d, n: 1 })), Error);
});

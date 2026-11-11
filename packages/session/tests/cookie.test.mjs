import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSessionCookieOptions,
  serializeSetCookie,
  parseCookieHeader,
  SessionCookieTransport,
  SessionCookieError,
  DEFAULT_SESSION_COOKIE_NAME,
} from '../dist/cookie.js';
import { MemorySessionStore, SessionManager } from '../dist/index.js';

function makeJar(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    get(name) { return values.get(name); },
    set(name, value, options) { values.set(name, value); writes.push({ type: 'set', name, value, options }); },
    delete(name, options) { values.delete(name); writes.push({ type: 'delete', name, options }); },
  };
}

function makeManager(overrides = {}) {
  let n = 0;
  return new SessionManager(new MemorySessionStore(), {
    now: () => 1000,
    ttlMs: 60_000,
    createId: () => `session_cookie_${String(++n).padStart(6, '0')}`,
    ...overrides,
  });
}

test('default cookie options are secure and use the __Host- prefix', () => {
  const o = resolveSessionCookieOptions();
  assert.equal(o.name, DEFAULT_SESSION_COOKIE_NAME);
  assert.equal(o.name.startsWith('__Host-'), true);
  assert.equal(o.secure, true);
  assert.equal(o.httpOnly, true);
  assert.equal(o.sameSite, 'lax');
  assert.equal(o.path, '/');
  assert.equal(o.domain, undefined);
  assert.equal(Object.isFrozen(o), true);
});

test('serializeSetCookie emits all hardened attributes', () => {
  const o = resolveSessionCookieOptions({ maxAge: 60 });
  const header = serializeSetCookie(o.name, 'session_identifier_0001', o);
  assert.match(header, /^__Host-sveltex_session=session_identifier_0001/);
  assert.match(header, /Path=\//);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=60/);
  assert.equal(header.includes('Domain='), false);
});

test('serializeSetCookie rejects CRLF / semicolon injection in the value', () => {
  const o = resolveSessionCookieOptions();
  for (const bad of ['a\r\nSet-Cookie: evil=1', 'a; Domain=evil.example', 'a,b', 'a"b', 'a b']) {
    assert.throws(() => serializeSetCookie(o.name, bad, o), SessionCookieError);
  }
});

test('resolveSessionCookieOptions rejects unsafe names and values', () => {
  assert.throws(() => resolveSessionCookieOptions({ name: 'bad;name' }), SessionCookieError);
  assert.throws(() => resolveSessionCookieOptions({ name: 'bad\r\nname' }), SessionCookieError);
  assert.throws(() => resolveSessionCookieOptions({ name: '' }), SessionCookieError);
  assert.throws(() => resolveSessionCookieOptions({ path: '/\r\nX: y' }), SessionCookieError);
});

test('resolveSessionCookieOptions rejects insecure combinations', () => {
  assert.throws(() => resolveSessionCookieOptions({ sameSite: 'none', secure: false }), SessionCookieError);
  assert.throws(() => resolveSessionCookieOptions({ secure: false }), SessionCookieError); // prefixed name
  assert.throws(() => resolveSessionCookieOptions({ path: '/app' }), SessionCookieError); // __Host- requires /
  assert.throws(() => resolveSessionCookieOptions({ domain: 'example.com' }), SessionCookieError); // __Host- forbids Domain
  assert.throws(() => resolveSessionCookieOptions({ partitioned: true, secure: false }), SessionCookieError);
  assert.throws(() => resolveSessionCookieOptions({ maxAge: -1 }), SessionCookieError);
  assert.throws(() => resolveSessionCookieOptions({ domain: 'bad..example' }), SessionCookieError);
});

test('a non-prefixed name may disable Secure for local HTTP development', () => {
  const o = resolveSessionCookieOptions({ name: 'sveltex_dev', secure: false, domain: 'localhost' });
  assert.equal(o.secure, false);
  assert.equal(o.domain, 'localhost');
});

test('SameSite=None and Partitioned are allowed when Secure', () => {
  const o = resolveSessionCookieOptions({ name: 'sveltex_cross', sameSite: 'none', partitioned: true, domain: 'example.com' });
  assert.equal(o.sameSite, 'none');
  assert.equal(o.partitioned, true);
  assert.match(serializeSetCookie(o.name, 'session_identifier_0001', o), /SameSite=None/);
  assert.match(serializeSetCookie(o.name, 'session_identifier_0001', o), /Partitioned/);
});

test('parseCookieHeader decodes values, keeps the first duplicate, and blocks __proto__', () => {
  const parsed = parseCookieHeader('a=1; a=2; session=x%20y; __proto__=evil');
  assert.equal(parsed['a'], '1');
  assert.equal(parsed['session'], 'x y');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(parseCookieHeader(undefined)['a'], undefined);
  assert.equal(parseCookieHeader('garbage')['a'], undefined);
});

test('transport.create writes a cookie whose Max-Age matches the remaining TTL', async () => {
  const jar = makeJar();
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  const handle = await transport.create({ userId: 'u1' });
  assert.equal(jar.values.get(transport.cookieName), handle.id);
  assert.equal(jar.writes[0].options.maxAge, 60);
  assert.equal(jar.writes[0].options.httpOnly, true);
  assert.equal(jar.writes[0].options.secure, true);
  assert.equal(jar.writes[0].options.path, '/');
});

test('transport.serialize produces a hardened Set-Cookie header', async () => {
  const jar = makeJar();
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  const handle = await transport.create({ userId: 'u1' });
  const header = transport.serialize(handle);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, new RegExp(handle.id));
});

test('transport.read resolves the session through the manager', async () => {
  const jar = makeJar();
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  const created = await transport.create({ userId: 'u1' });
  const read = await transport.read();
  assert.equal(read.id, created.id);
  assert.equal(read.data.userId, 'u1');
});

test('transport.read clears a stale cookie whose session no longer exists', async () => {
  const jar = makeJar({ [DEFAULT_SESSION_COOKIE_NAME]: 'session_cookie_000001' });
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  assert.equal(await transport.read(), undefined);
  assert.equal(jar.values.has(DEFAULT_SESSION_COOKIE_NAME), false);
  assert.equal(jar.writes.at(-1).type, 'delete');
});

test('transport.read clears an invalid / attacker-controlled cookie id', async () => {
  const jar = makeJar({ [DEFAULT_SESSION_COOKIE_NAME]: 'short' });
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  assert.equal(await transport.read(), undefined);
  assert.equal(jar.values.has(DEFAULT_SESSION_COOKIE_NAME), false);
});

test('transport.rotate rewrites the cookie and invalidates the old id', async () => {
  const jar = makeJar();
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  const original = await transport.create({ userId: 'u1' });
  const rotated = await transport.rotate();
  assert.notEqual(rotated.id, original.id);
  assert.equal(jar.values.get(transport.cookieName), rotated.id);
  assert.equal(await transport.read().then(h => h.id), rotated.id);
  assert.equal((await transport.read()).data.userId, 'u1');
});

test('transport.destroy removes both the session and the cookie', async () => {
  const jar = makeJar();
  const manager = makeManager();
  const transport = new SessionCookieTransport({ cookies: jar, manager, now: () => 1000 });
  const created = await transport.create({ userId: 'u1' });
  await transport.destroy();
  assert.equal(await manager.get(created.id), undefined);
  assert.equal(jar.values.has(transport.cookieName), false);
});

test('transport.write clears instead of writing an already-expired session', () => {
  const jar = makeJar();
  const transport = new SessionCookieTransport({ cookies: jar, manager: makeManager(), now: () => 1000 });
  transport.write({ id: 'session_cookie_000001', data: {}, createdAt: 0, expiresAt: 500, revision: 1 });
  assert.equal(jar.values.has(transport.cookieName), false);
  assert.equal(jar.writes.at(-1).type, 'delete');
});

test('transport validates its CookieJar, manager and clock', () => {
  assert.throws(() => new SessionCookieTransport({ cookies: {}, manager: makeManager() }), SessionCookieError);
  assert.throws(() => new SessionCookieTransport({ cookies: makeJar(), manager: {} }), SessionCookieError);
  assert.throws(() => new SessionCookieTransport({ cookies: makeJar(), manager: makeManager(), now: 'no' }), SessionCookieError);
});

test('custom cookie options are honored end-to-end', async () => {
  const jar = makeJar();
  const transport = new SessionCookieTransport({
    cookies: jar, manager: makeManager(), now: () => 1000,
    cookie: { name: 'app_session', sameSite: 'strict', maxAge: 123 },
  });
  const handle = await transport.create({ userId: 'u1' });
  assert.equal(transport.cookieName, 'app_session');
  assert.equal(jar.values.get('app_session'), handle.id);
  assert.equal(jar.writes[0].options.sameSite, 'strict');
});

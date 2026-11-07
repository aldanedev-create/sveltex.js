import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, AuthConflictError, AuthConfigurationError } from '../dist/index.js';
function setup(options = {}) {
  const users = new Map(); const sessions = new Map(); const calls = { verify: 0, hash: 0, limiter: 0 };
  const store = {
    async findByEmail(email) { return users.get(email); },
    async createIfAbsent(user) { if (users.has(user.email)) return undefined; const record = { id: `user_${users.size + 1}`, ...user }; users.set(user.email, record); return record; },
  };
  const hasher = {
    async hash(password) { calls.hash++; return `argon2id$${password.padEnd(24, '_')}`; },
    async verify(password, hash) { calls.verify++; return hash === `argon2id$${password.padEnd(24, '_')}`; },
  };
  const sessionPort = { async create(data) { const session = { id: `session_identifier_${sessions.size + 1}`, ...data }; sessions.set(session.id, session); return session; }, async destroy(id) { sessions.delete(id); }, async rotate(id) { const previous = sessions.get(id); if (!previous) return undefined; sessions.delete(id); const next = { ...previous, id: 'session_identifier_rotated' }; sessions.set(next.id, next); return next; } };
  const limiter = { async consume() { calls.limiter++; return options.allowed ?? true; } };
  return { auth: new AuthService(store, hasher, sessionPort, { limiter, dummyPasswordHash: 'argon2id$dummy-encoded-password-hash', ...options }), users, sessions, calls };
}
test('register hashes password and never returns stored password hash', async () => {
  const { auth, users } = setup(); const user = await auth.register({ email: 'TEST@example.com', password: 'correct horse battery staple' });
  assert.equal(user.email, 'test@example.com'); assert.equal('passwordHash' in user, false); assert.equal(users.size, 1);
});
test('registration cannot assign privileged user fields from untrusted input', async () => {
  const { auth, users } = setup(); await auth.register({ email: 'a@example.com', password: 'correct horse battery staple', roles: ['admin'], isAdmin: true, passwordHash: 'attacker' });
  const saved = users.get('a@example.com'); assert.equal('roles' in saved, false); assert.equal('isAdmin' in saved, false); assert.notEqual(saved.passwordHash, 'attacker');
});
test('register rejects duplicate normalized email', async () => {
  const { auth } = setup(); await auth.register({ email: 'a@example.com', password: 'correct horse battery staple' });
  await assert.rejects(() => auth.register({ email: ' A@example.com ', password: 'correct horse battery staple' }), AuthConflictError);
});
test('login creates a session for valid credentials', async () => {
  const { auth, sessions } = setup(); await auth.register({ email: 'a@example.com', password: 'correct horse battery staple' });
  const result = await auth.login('A@example.com', 'correct horse battery staple'); assert.ok(result); assert.equal(sessions.size, 1); assert.equal('passwordHash' in result.user, false);
});
test('login returns the same empty result for unknown user and wrong password', async () => {
  const { auth, calls } = setup(); await auth.register({ email: 'a@example.com', password: 'correct horse battery staple' });
  assert.equal(await auth.login('missing@example.com', 'correct horse battery staple'), undefined);
  assert.equal(await auth.login('a@example.com', 'wrong password'), undefined); assert.equal(calls.verify, 2);
});
test('login rate limiter can deny attempts before user lookup', async () => {
  const { auth, calls } = setup({ allowed: false }); assert.equal(await auth.login('a@example.com', 'some password'), undefined); assert.equal(calls.limiter, 1); assert.equal(calls.verify, 0);
});
test('password policy and email validation reject invalid inputs', async () => {
  const { auth } = setup(); await assert.rejects(() => auth.register({ email: 'invalid', password: 'short' }), TypeError);
  await assert.rejects(() => auth.login('bad', 'x'), TypeError); await assert.rejects(() => auth.login('a@example.com', 'x'.repeat(4097)), TypeError);
});
test('logout destroys a session and rotation delegates to the atomic session adapter', async () => {
  const { auth } = setup(); await auth.register({ email: 'a@example.com', password: 'correct horse battery staple' });
  await auth.logout('session_identifier_12345'); const rotated = await auth.rotateSession('session_identifier_12345'); assert.equal(rotated, undefined);
});
test('rotation fails clearly when the session adapter has no atomic rotation operation', async () => {
  const auth = new AuthService({ async findByEmail(){return undefined;}, async createIfAbsent(){return undefined;} }, { async hash(){return 'argon2id$hash-long-enough-to-pass';}, async verify(){return false;} }, { async create(){return {};}, async destroy(){} }, { dummyPasswordHash: 'argon2id$dummy-encoded-password-hash' });
  await assert.rejects(() => auth.rotateSession('session_identifier_12345'), AuthConfigurationError);
});
test('hasher output is checked before persistence', async () => {
  const { auth } = setup(); const broken = new AuthService({ async findByEmail(){return undefined;}, async createIfAbsent(){return undefined;} }, { async hash(){return 'bad';}, async verify(){return false;} }, { async create(){return {};}, async destroy(){} }, { dummyPasswordHash: 'argon2id$dummy-encoded-password-hash' });
  await assert.rejects(() => broken.register({ email: 'a@example.com', password: 'correct horse battery staple' }), AuthConfigurationError);
});
test('auth requires a real precomputed dummy hash for timing-equalized lookup', () => {
  assert.throws(() => new AuthService({}, {}, {}, { dummyPasswordHash: '' }), AuthConfigurationError);
});
test('login verifies the configured dummy hash for unknown accounts', async () => {
  let verifiedHash; const auth = new AuthService({ async findByEmail(){return undefined;}, async createIfAbsent(){return undefined;} }, { async hash(){return 'argon2id$hash-long-enough-to-pass';}, async verify(_password, hash){verifiedHash=hash;return false;} }, { async create(){return {};}, async destroy(){} }, { dummyPasswordHash: 'argon2id$application-specific-dummy-hash' });
  assert.equal(await auth.login('missing@example.com','some password'),undefined); assert.equal(verifiedHash,'argon2id$application-specific-dummy-hash');
});

test('malformed stored password hashes use the dummy verification path', async () => {
  let checked; const auth = new AuthService({ async findByEmail(){return {id:'user_1',email:'a@example.com',passwordHash:'bad'};}, async createIfAbsent(){return undefined;} }, { async hash(){return 'argon2id$hash-long-enough-to-pass';}, async verify(_password, hash){checked=hash;return false;} }, { async create(){return {};}, async destroy(){} }, { dummyPasswordHash: 'argon2id$application-specific-dummy-hash' });
  assert.equal(await auth.login('a@example.com','some password'),undefined); assert.equal(checked,'argon2id$application-specific-dummy-hash');
});
test('registration clones metadata and rejects prototype-pollution metadata', async () => {
  const { auth, users } = setup(); const metadata = { preferences: { theme: 'dark' } }; await auth.register({ email: 'meta@example.com', password: 'correct horse battery staple', metadata });
  metadata.preferences.theme = 'light'; assert.equal(users.get('meta@example.com').metadata.preferences.theme, 'dark');
  await assert.rejects(() => auth.register({ email: 'unsafe@example.com', password: 'correct horse battery staple', metadata: JSON.parse('{"__proto__":{"admin":true}}') }));
});
test('auth rejects incomplete provider adapters', () => {
  assert.throws(() => new AuthService({}, {}, {}, { dummyPasswordHash: 'argon2id$application-specific-dummy-hash' }), AuthConfigurationError);
});

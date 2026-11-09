import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager, MemoryTokenStore, generateSecureToken } from '../dist/tokens.js';
import { AuthTokenExpiredError, AuthTokenUsedError, AuthTokenInvalidError } from '../dist/errors.js';

test('generateSecureToken yields high-entropy, unique, url-safe values', () => {
  const a = generateSecureToken();
  const b = generateSecureToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.throws(() => generateSecureToken(8), RangeError);
});

test('issue/verify/consume lifecycle', async () => {
  let now = 1000;
  const clock = () => now;
  const mgr = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const issued = await mgr.issue('purpose', 'user-1', 1000);
  assert.equal(issued.subject, 'user-1');
  assert.equal(await mgr.verify(issued.token, 'purpose'), 'user-1');
  assert.equal(await mgr.consume(issued.token, 'purpose'), 'user-1');
});

test('consume is single-use; a second consume fails', async () => {
  let now = 1000;
  const clock = () => now;
  const mgr = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const { token } = await mgr.issue('p', 'u', 1000);
  await mgr.consume(token, 'p');
  await assert.rejects(() => mgr.consume(token, 'p'), AuthTokenUsedError);
  await assert.rejects(() => mgr.verify(token, 'p'), AuthTokenUsedError);
});

test('expired token is rejected by verify and consume', async () => {
  let now = 1000;
  const clock = () => now;
  const mgr = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const { token } = await mgr.issue('p', 'u', 1000); // expires at 2000
  now = 2001;
  await assert.rejects(() => mgr.verify(token, 'p'), AuthTokenExpiredError);
  await assert.rejects(() => mgr.consume(token, 'p'), AuthTokenExpiredError);
});

test('wrong-purpose token is rejected', async () => {
  let now = 1000;
  const clock = () => now;
  const mgr = new TokenManager(new MemoryTokenStore({ now: clock }), { now: clock });
  const { token } = await mgr.issue('reset', 'u', 1000);
  await assert.rejects(() => mgr.verify(token, 'verify'), AuthTokenInvalidError);
  await assert.rejects(() => mgr.consume(token, 'verify'), AuthTokenInvalidError);
});

test('unknown token is rejected', async () => {
  const mgr = new TokenManager(new MemoryTokenStore());
  await assert.rejects(() => mgr.verify('nope', 'p'), AuthTokenInvalidError);
});

test('verifyOrNull returns undefined instead of throwing', async () => {
  const mgr = new TokenManager(new MemoryTokenStore());
  assert.equal(await mgr.verifyOrNull('missing', 'p'), undefined);
});

test('peek does not consume', async () => {
  let now = 1000;
  const clock = () => now;
  const store = new MemoryTokenStore({ now: clock });
  const mgr = new TokenManager(store, { now: clock });
  const { token } = await mgr.issue('p', 'u', 1000);
  assert.ok(await store.peek(token));
  assert.equal(await mgr.verify(token, 'p'), 'u'); // still usable after a peek
});

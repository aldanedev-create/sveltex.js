import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CsrfProtection,
  CsrfError,
  constantTimeEqual,
  serializeCsrfCookie,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
  SAFE_HTTP_METHODS,
} from '../dist/csrf.js';

test('constantTimeEqual compares equal and unequal strings without throwing on length mismatch', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('short', 'a-much-longer-string'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(1, '1'), false);
});

test('CSRF safe methods are GET/HEAD/OPTIONS/TRACE', () => {
  assert.deepEqual([...SAFE_HTTP_METHODS], ['GET', 'HEAD', 'OPTIONS', 'TRACE']);
  const csrf = new CsrfProtection();
  assert.equal(csrf.isSafeMethod('get'), true);
  assert.equal(csrf.isSafeMethod('POST'), false);
  assert.equal(csrf.isSafeMethod(123), false);
});

test('serializeCsrfCookie emits a readable, SameSite=Strict, Secure cookie', () => {
  const header = serializeCsrfCookie('session_csrf_token_0001');
  assert.match(header, /^__Host-sveltex_csrf=session_csrf_token_0001/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/);
  assert.match(header, /Path=\//);
  assert.equal(header.includes('HttpOnly'), false, 'double-submit cookies must be readable by JS');
});

test('serializeCsrfCookie rejects header injection', () => {
  assert.throws(() => serializeCsrfCookie('a\r\nSet-Cookie: evil=1'), CsrfError);
  assert.throws(() => serializeCsrfCookie('a; b'), CsrfError);
  assert.throws(() => serializeCsrfCookie('ok', { name: 'bad name' }), CsrfError);
  assert.throws(() => serializeCsrfCookie('ok', { name: '__Host-x', secure: false }), CsrfError);
});

test('issue() returns a token plus a matching Set-Cookie header (unbound mode)', () => {
  const csrf = new CsrfProtection();
  const issued = csrf.issue();
  assert.equal(typeof issued.value, 'string');
  assert.ok(issued.value.length >= 16);
  assert.ok(issued.cookie.includes(issued.value));
  assert.equal(csrf.verify(issued.value), true);
  // Without a secret, only the token's shape can be checked (that is exactly why
  // HMAC binding is offered). A well-formed random string is indistinguishable;
  // a malformed one is rejected.
  assert.equal(csrf.verify('tempered-with-token-value'), true);
  assert.equal(csrf.verify('bad!'), false);
  assert.equal(csrf.verify(''), false);
});

test('HMAC-bound tokens verify only for the session they were issued to', () => {
  const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
  const issued = csrf.issue('session-aaa');
  assert.ok(issued.value.includes('.'));
  assert.equal(csrf.verify(issued.value, 'session-aaa'), true);
  assert.equal(csrf.verify(issued.value, 'session-bbb'), false);
  assert.equal(csrf.verify(issued.value), false);
  assert.equal(csrf.verify('forged.token', 'session-aaa'), false);
});

test('safe methods bypass the token requirement', () => {
  const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
    assert.doesNotThrow(() => csrf.assertValid({ method }));
  }
});

test('state-changing requests require a token', () => {
  const csrf = new CsrfProtection();
  assert.throws(() => csrf.assertValid({ method: 'POST' }), { code: 'CSRF_TOKEN_MISSING' });
  assert.throws(() => csrf.assertValid({ method: 'POST', headerToken: 'tok' }), { code: 'CSRF_COOKIE_MISSING' });
  assert.throws(() => csrf.assertValid({ method: 'DELETE', headerToken: 'tok', cookieToken: 'other' }), { code: 'CSRF_TOKEN_MISMATCH' });
});

test('a valid double-submit token passes validation', () => {
  const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
  const issued = csrf.issue('session-aaa');
  assert.doesNotThrow(() => csrf.assertValid({
    method: 'POST', headerToken: issued.value, cookieToken: issued.value, sessionId: 'session-aaa',
  }));
});

test('a signed token bound to the wrong session is rejected', () => {
  const csrf = new CsrfProtection({ secret: 'a-very-long-csrf-secret-value' });
  const issued = csrf.issue('session-aaa');
  assert.throws(() => csrf.assertValid({
    method: 'POST', headerToken: issued.value, cookieToken: issued.value, sessionId: 'session-bbb',
  }), { code: 'CSRF_TOKEN_INVALID' });
});

test('form-field tokens are accepted as an alternative to the header', () => {
  const csrf = new CsrfProtection();
  const issued = csrf.issue();
  assert.doesNotThrow(() => csrf.assertValid({
    method: 'POST', fieldToken: issued.value, cookieToken: issued.value,
  }));
});

test('assertValidRequest extracts header and cookie tokens from a request-like object', () => {
  const csrf = new CsrfProtection();
  const issued = csrf.issue();
  assert.doesNotThrow(() => csrf.assertValidRequest({
    method: 'PUT',
    headers: { [CSRF_HEADER_NAME]: issued.value, cookie: `${CSRF_COOKIE_NAME}=${issued.value}` },
  }));
  assert.throws(() => csrf.assertValidRequest({
    method: 'PUT', headers: { [CSRF_HEADER_NAME]: issued.value, cookie: `${CSRF_COOKIE_NAME}=wrong` },
  }), { code: 'CSRF_TOKEN_MISMATCH' });
});

test('assertValidRequest works with a Headers-like get() interface and case-insensitive names', () => {
  const csrf = new CsrfProtection();
  const issued = csrf.issue();
  const headers = new Map([[CSRF_HEADER_NAME, issued.value], ['Cookie', `${CSRF_COOKIE_NAME}=${issued.value}`]]);
  // Mirror a real Headers object: lookup is case-insensitive on the header name.
  const get = (name) => {
    const target = name.toLowerCase();
    for (const [key, value] of headers) if (key.toLowerCase() === target) return value;
    return undefined;
  };
  assert.doesNotThrow(() => csrf.assertValidRequest({ method: 'PATCH', headers: { get } }));
});

test('assertValidRequest accepts a field token via formToken', () => {
  const csrf = new CsrfProtection();
  const issued = csrf.issue();
  assert.doesNotThrow(() => csrf.assertValidRequest({
    method: 'POST', cookieHeader: `${CSRF_COOKIE_NAME}=${issued.value}`, formToken: issued.value,
  }));
});

test('constructor rejects insecure / malformed configuration', () => {
  assert.throws(() => new CsrfProtection({ secret: 'short' }), CsrfError);
  assert.throws(() => new CsrfProtection({ tokenBytes: 4 }), CsrfError);
  assert.throws(() => new CsrfProtection({ headerName: 'bad header' }), CsrfError);
  assert.throws(() => new CsrfProtection({ sameSite: 'bogus' }), CsrfError);
  assert.throws(() => new CsrfProtection({ sameSite: 'none', secure: false }), CsrfError);
  assert.throws(() => new CsrfProtection({ path: 'relative' }), CsrfError);
  assert.throws(() => new CsrfProtection({ maxAge: -1 }), CsrfError);
  assert.doesNotThrow(() => new CsrfProtection({ cookieName: 'app_csrf', secure: false, sameSite: 'lax' }));
});

test('assertValidRequest rejects a missing request', () => {
  const csrf = new CsrfProtection();
  assert.throws(() => csrf.assertValidRequest({}), { code: 'CSRF_REQUEST_INVALID' });
});

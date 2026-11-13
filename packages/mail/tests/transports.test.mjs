import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Mailer,
  MailValidationError,
  MailConfigurationError,
  MailClosedError,
} from '../dist/index.js';
import { TestTransport } from '../dist/test-transport.js';
import { SmtpTransport, toNodemailerMessage } from '../dist/smtp.js';
import {
  HttpTransport,
  buildHttpPayload,
  MAIL_HTTP_ENVELOPE_VERSION,
  MAIL_HTTP_CONTENT_TYPE,
} from '../dist/http.js';
import {
  createPasswordResetMailSender,
  createEmailVerificationMailSender,
} from '../dist/auth.js';

const from = { email: 'noreply@example.com' };
const to = [{ email: 'alice@example.com' }];
const base = { from, to, subject: 'Hello', text: 'Hi' };
const opts = () => ({ now: () => 1_700_000_000_000, generateId: () => 'fixed-id', generateBoundary: () => 'FIXED' });

test('SMTP: toNodemailerMessage maps addresses, headers and in-memory attachments', () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const mapped = toNodemailerMessage({
    ...base,
    cc: [{ email: 'carol@example.com' }],
    bcc: [{ email: 'audit@example.com' }],
    replyTo: { email: 'reply@example.com' },
    headers: { 'X-App': 'sveltex' },
    html: '<p>Hi</p>',
    attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', content: bytes, contentId: 'cid-1' }],
  });
  assert.deepEqual(mapped.from, { address: 'noreply@example.com' });
  assert.deepEqual(mapped.to, [{ address: 'alice@example.com' }]);
  assert.deepEqual(mapped.bcc, [{ address: 'audit@example.com' }]);
  assert.deepEqual(mapped.replyTo, { address: 'reply@example.com' });
  assert.equal(mapped.headers['X-App'], 'sveltex');
  assert.equal(mapped.disableFileAccess, true, 'provider must never resolve file:// paths');
  assert.equal(mapped.disableUrlAccess, true, 'provider must never resolve http(s):// URLs');
  assert.deepEqual([...mapped.attachments[0].content], [...bytes]);
  assert.equal(mapped.attachments[0].contentDisposition, 'attachment');
  assert.equal(mapped.attachments[0].cid, 'cid-1');
});

test('SMTP: toNodemailerMessage validates before mapping', () => {
  assert.throws(() => toNodemailerMessage({ ...base, subject: 'x\r\nBcc: evil@x.com' }), MailValidationError);
  assert.throws(() => toNodemailerMessage({ ...base, attachments: [{ filename: '../x', contentType: 'text/plain', content: 'x' }] }), MailValidationError);
});

test('SMTP: configuration rejects unsafe host, port, booleans, timeouts, TLS and auth shapes', () => {
  const bad = [
    { host: '' },
    { host: 'smtp.example.com:587' },
    { host: 'user:pass@smtp.example.com' },
    { host: 'smtp.example.com\r\nX: y' },
    { host: 'smtp.example.com', port: 0 },
    { host: 'smtp.example.com', port: 65536 },
    { host: 'smtp.example.com', secure: 'yes' },
    { host: 'smtp.example.com', requireTLS: 1 },
    { host: 'smtp.example.com', connectionTimeoutMs: 0 },
    { host: 'smtp.example.com', greetingTimeoutMs: 120001 },
    { host: 'smtp.example.com', maxConnections: 101 },
    { host: 'smtp.example.com', auth: { user: '', pass: 'p' } },
    { host: 'smtp.example.com', auth: { user: 'u', pass: 'p\r\n' } },
    { host: 'smtp.example.com', tls: { rejectUnauthorized: 'no' } },
    { host: 'smtp.example.com', tls: { servername: 'bad host' } },
  ];
  for (const options of bad) {
    assert.throws(() => new SmtpTransport(options), MailConfigurationError, JSON.stringify(options));
  }
  assert.ok(new SmtpTransport({ host: 'smtp.example.com', port: 587, auth: { user: 'u', pass: 'p' } }));
});

test('SMTP: invalid credentials are never echoed into error messages or details', () => {
  const secret = 'super-secret-pass-9f8e7d';
  for (const options of [
    { host: 'smtp.example.com', auth: { user: 'u', pass: `${secret}\r\n` } },
    { host: 'smtp.example.com', auth: { user: `u\r\n${secret}`, pass: 'p' } },
  ]) {
    assert.throws(() => new SmtpTransport(options), (err) => {
      assert.equal(err.name, 'MailConfigurationError');
      assert.ok(!err.message.includes(secret));
      assert.ok(!JSON.stringify(err.details ?? {}).includes(secret));
      return true;
    });
  }
});

test('SMTP: close() is idempotent and closed transports refuse send/verify', async () => {
  const t = new SmtpTransport({ host: '127.0.0.1', port: 1 });
  await t.close();
  await t.close();
  assert.equal(t.isClosed, true);
  await assert.rejects(() => t.send(base), MailClosedError);
  await assert.rejects(() => t.verify(), MailClosedError);
});

test('HTTP: strict v1 envelope constants and deterministic payload', () => {
  assert.equal(MAIL_HTTP_ENVELOPE_VERSION, 1);
  assert.equal(MAIL_HTTP_CONTENT_TYPE, 'application/vnd.sveltex.mail.v1+json');
  const payload = buildHttpPayload({ ...base, bcc: [{ email: 'audit@example.com' }] }, opts());
  assert.equal(payload.version, 1);
  assert.deepEqual([...payload.envelope.to], ['alice@example.com', 'audit@example.com']);
  assert.equal(payload.envelope.from, 'noreply@example.com');
  assert.equal(payload.envelope.messageId, '<fixed-id@example.com>');
  assert.ok(payload.raw.includes('MIME-Version: 1.0'));
  assert.ok(!payload.raw.includes('audit@example.com'), 'bcc stays out of the raw message');
  assert.ok(Object.isFrozen(payload));
  assert.equal(buildHttpPayload(base, opts()).raw, buildHttpPayload(base, opts()).raw, 'deterministic with injected generators');
});

test('HTTP: buildHttpPayload validates the message', () => {
  assert.throws(() => buildHttpPayload({ ...base, subject: 'x\r\nBcc: y@z.com' }, opts()), MailValidationError);
  assert.throws(() => buildHttpPayload({ ...base, attachments: [{ filename: 'a/../b', contentType: 'text/plain', content: 'x' }] }, opts()), MailValidationError);
});

test('HTTP: configuration rejects SSRF-prone endpoints, fragments and credentials', () => {
  const bad = [
    { endpoint: '/relative' },
    { endpoint: 'ftp://example.com/send' },
    { endpoint: 'file:///etc/passwd' },
    { endpoint: 'https://user:pass@example.com/send' },
    { endpoint: 'https://example.com/send#frag' },
    { endpoint: 'https://example.com/send\r\nX: y' },
    { endpoint: 'https://example.com/send', allowedHosts: [] },
    { endpoint: 'https://example.com/send', allowedHosts: ['other.example.com'] },
    { endpoint: 'https://example.com/send', timeoutMs: 0 },
    { endpoint: 'https://example.com/send', timeoutMs: 120001 },
    { endpoint: 'https://example.com/send', maxResponseBytes: 65537 },
  ];
  for (const options of bad) {
    assert.throws(() => new HttpTransport(options), MailConfigurationError, JSON.stringify(options));
  }
  assert.ok(new HttpTransport({ endpoint: 'https://example.com/send', allowedHosts: ['example.com'] }));
});

test('HTTP: client-settable header validation (hop-by-hop and injection guards)', () => {
  const endpoint = 'https://example.com/send';
  for (const headers of [
    { Host: 'evil.example.com' },
    { 'Content-Length': '10' },
    { Connection: 'keep-alive' },
    { 'Transfer-Encoding': 'chunked' },
    { 'X-Auth': 'a\r\nX: y' },
    { 'Bad Name': 'x' },
    { 'X-Auth': 42 },
  ]) {
    assert.throws(() => new HttpTransport({ endpoint, headers }), MailConfigurationError, JSON.stringify(headers));
  }
  assert.ok(new HttpTransport({ endpoint, headers: { Authorization: 'Bearer token' } }));
});

test('HTTP: close() is idempotent and a closed transport refuses send', async () => {
  const t = new HttpTransport({ endpoint: 'https://example.com/send' });
  await t.close();
  await t.close();
  assert.equal(t.isClosed, true);
  await assert.rejects(() => t.send(base), MailClosedError);
});

test('AUTH: password-reset sender builds a percent-encoded, single-parameter link', async () => {
  const transport = new TestTransport();
  const mailer = new Mailer({ transport, sleep: async () => {}, now: () => 0 });
  const sender = createPasswordResetMailSender({ mailer, from, endpoint: 'https://app.example.com/reset', appName: 'Acme' });
  const token = 'a+b/c=?&more';
  await sender.send({ email: 'alice@example.com', token, expiresAt: 1_700_000_000 });
  const sent = transport.sent[0].message;
  assert.match(sent.subject, /Acme/);
  // HTML escaping turns the URL's '&' separators into '&amp;' inside the href
  // attribute; that is correct HTML (browsers decode it back to '&').
  const rawLink = /https:\/\/app\.example\.com\/reset\?[^"\s<]+/.exec(sent.html)[0];
  const link = rawLink.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const url = new URL(link);
  assert.equal(url.searchParams.get('token'), token, 'token must round-trip exactly');
  assert.equal(url.searchParams.get('email'), 'alice@example.com');
  assert.equal(url.searchParams.get('expires'), '1700000000');
  assert.equal(sent.html.includes('onmouseover'), false);
  await mailer.close();
});

test('AUTH: verification sender escapes a hostile token inside the HTML attribute', async () => {
  const transport = new TestTransport();
  const mailer = new Mailer({ transport, sleep: async () => {}, now: () => 0 });
  const sender = createEmailVerificationMailSender({ mailer, from, endpoint: 'https://app.example.com/verify' });
  await sender.send({ email: 'bob@example.com', token: 'x" onmouseover="alert(1)', expiresAt: 1 });
  const html = transport.sent[0].message.html;
  assert.ok(html.includes('%22') || html.includes('&quot;'), 'quotes must be encoded/escaped');
  assert.ok(!html.includes('onmouseover="'), 'no attribute breakout');
  await mailer.close();
});

test('AUTH: sender validates endpoint, context and tokenParam', async () => {
  const transport = new TestTransport();
  const mailer = new Mailer({ transport, sleep: async () => {}, now: () => 0 });
  const good = { mailer, from, endpoint: 'https://app.example.com/reset' };
  assert.throws(() => createPasswordResetMailSender({ ...good, endpoint: 'https://u:p@app.example.com/reset' }), MailConfigurationError);
  assert.throws(() => createPasswordResetMailSender({ ...good, endpoint: 'javascript:alert(1)' }), MailConfigurationError);
  assert.throws(() => createPasswordResetMailSender({ ...good, tokenParam: 'bad param' }), MailConfigurationError);
  assert.throws(() => createPasswordResetMailSender({ ...good, appName: 'x\r\nBcc: y@z.com' }), MailConfigurationError);
  const sender = createPasswordResetMailSender(good);
  await assert.rejects(() => sender.send({ email: 'not-an-email', token: 't', expiresAt: 1 }), MailValidationError);
  await assert.rejects(() => sender.send({ email: 'a@b.com', token: 't\r\nBcc: x', expiresAt: 1 }), MailValidationError);
  await assert.rejects(() => sender.send({ email: 'a@b.com', token: 't', expiresAt: 1.5 }), MailValidationError);
  assert.equal(transport.sent.length, 0, 'invalid contexts never reach the transport');
  await mailer.close();
});

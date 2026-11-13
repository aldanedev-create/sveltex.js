import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailer, renderTemplate, validateMessage, MailValidationError, MailConfigurationError, attachmentBytes } from '../../dist/index.js';
import { TestTransport } from '../../dist/test-transport.js';
import { buildMimeMessage } from '../../dist/mime.js';
import { toNodemailerMessage, SmtpTransport } from '../../dist/smtp.js';
import { buildHttpPayload, HttpTransport } from '../../dist/http.js';
import { createPasswordResetMailSender } from '../../dist/auth.js';

const from = { email: 'noreply@example.com' };
const to = [{ email: 'alice@example.com' }];
const base = { from, to, subject: 'Hello', text: 'Hi' };

function mailer(transport, extra = {}) {
  return new Mailer({ transport, sleep: async () => {}, now: () => 0, ...extra });
}

test('SEC: CRLF header injection is rejected in subject, names and headers', () => {
  assert.throws(() => validateMessage({ ...base, subject: 'Hi\r\nBcc: attacker@evil.com' }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...base, from: { email: 'a@b.com', name: 'X\r\nBcc: evil@x.com' } }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...base, headers: { 'X-Custom': 'ok\r\nBcc: evil@x.com' } }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...base, headers: { 'Bad Name': 'x' } }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...base, to: [{ email: 'a@b.com\u0000' }] }), { name: 'MailValidationError' });
});

test('SEC: HTML template body escapes interpolated data (XSS defense)', () => {
  const tpl = { subject: 'Verify {{ link }}', html: '<a href="{{ link }}">{{ link }}</a>' };
  const out = renderTemplate(tpl, { link: 'javascript:alert(1)" onmouseover="x' });
  assert.equal(out.html, '<a href="javascript:alert(1)&quot; onmouseover=&quot;x">javascript:alert(1)&quot; onmouseover=&quot;x</a>');
  assert.ok(!out.html.includes('onmouseover="'));
});

test('SEC: escaping can only be disabled explicitly by the template author', () => {
  const tpl = { subject: 'S', html: '<b>{{ v }}</b>' };
  const raw = renderTemplate(tpl, { v: '<script>' }, { escapeHtml: false });
  assert.equal(raw.html, '<b><script></b>');
  const safe = renderTemplate(tpl, { v: '<script>' });
  assert.equal(safe.html, '<b>&lt;script&gt;</b>');
});

test('SEC: template data cannot inject headers via rendered subject (post-render validation)', async () => {
  const transport = new TestTransport();
  const m = mailer(transport);
  const tpl = { subject: 'Hi {{ name }}', text: 'body' };
  await assert.rejects(
    () => m.sendTemplate(tpl, { from, to, data: { name: 'X\r\nBcc: attacker@evil.com' } }),
    { name: 'MailValidationError' },
  );
  assert.equal(transport.attempts, 0, 'no email leaked to a provider');
  await m.close();
});

test('SEC: permanent provider failure never produces a success receipt', async () => {
  const transport = new TestTransport({ failAlways: true });
  const m = mailer(transport, { retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1, factor: 1 } });
  await assert.rejects(() => m.send(base), { name: 'MailSendError' });
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.attempts, 4);
  await m.close();
});

test('SEC: transport errors are not swallowed or misreported as validation errors', async () => {
  const transport = new TestTransport({ failAlways: true });
  const m = mailer(transport, { retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, factor: 1 } });
  await assert.rejects(() => m.send(base), (err) => {
    assert.equal(err.name, 'MailSendError');
    assert.equal(err.cause.name, 'MailTransportError');
    return true;
  });
  await m.close();
});

test('SEC: bcc is preserved but never placed into headers by the library', async () => {
  const transport = new TestTransport();
  const m = mailer(transport);
  const message = { ...base, bcc: [{ email: 'audit@example.com' }], headers: { 'X-App': 'sveltex' } };
  await m.send(message);
  const sent = transport.sent[0].message;
  assert.deepEqual(sent.bcc, [{ email: 'audit@example.com' }]);
  assert.equal(sent.headers['X-App'], 'sveltex');
  assert.equal('Bcc' in sent.headers, false);
  await m.close();
});

test('SEC: body size limit prevents oversized payloads', () => {
  assert.throws(
    () => validateMessage({ ...base, html: '<p>' + 'x'.repeat(200) + '</p>' }, { maxBodyBytes: 16 }),
    { name: 'MailValidationError' },
  );
});

test('SEC: recipient count is bounded (mass-mail abuse guard)', () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ email: `u${i}@example.com` }));
  assert.throws(() => validateMessage({ ...base, to: many }), { name: 'MailValidationError' });
  assert.ok(MailValidationError);
});

// ---- Phase 8 security review (SEC-072 .. SEC-081) ---------------------------------

const att = (over = {}) => ({ filename: 'report.txt', contentType: 'text/plain', content: 'body', ...over });

test('SEC-072: attachment filenames cannot inject headers or traverse paths on any serializer', () => {
  for (const filename of ['a\r\nBcc: evil@x.com', '../secret', 'a/b.txt', 'a\\b.txt', 'C:\\x', '.hidden', 'x\u0000y']) {
    const message = { ...base, attachments: [att({ filename })] };
    assert.throws(() => validateMessage(message), MailValidationError, `validateMessage ${JSON.stringify(filename)}`);
    assert.throws(() => buildMimeMessage(message), MailValidationError, `MIME ${JSON.stringify(filename)}`);
    assert.throws(() => toNodemailerMessage(message), MailValidationError, `SMTP ${JSON.stringify(filename)}`);
    assert.throws(() => buildHttpPayload(message), MailValidationError, `HTTP ${JSON.stringify(filename)}`);
  }
});

test('SEC-073: base64 attachments are validated before decoding (no decoder smuggling)', () => {
  assert.throws(() => validateMessage({ ...base, attachments: [att({ content: 'AAE', encoding: 'base64' })] }), MailValidationError);
  assert.throws(() => validateMessage({ ...base, attachments: [att({ content: 'not base64!', encoding: 'base64' })] }), MailValidationError);
  assert.throws(() => attachmentBytes(att({ content: 'AAAA\r\nBBBB', encoding: 'base64' })), MailValidationError);
  assert.deepEqual([...attachmentBytes(att({ content: 'AAEC/w==', encoding: 'base64' }))], [0, 1, 2, 255]);
});

test('SEC-074: attachment count and aggregate byte caps bound memory (DoS guard)', () => {
  const tooMany = { ...base, attachments: Array.from({ length: 21 }, () => att()) };
  assert.throws(() => validateMessage(tooMany), MailValidationError);
  assert.throws(() => buildMimeMessage(tooMany), MailValidationError);
  const tooBig = { ...base, attachments: [att({ content: 'x'.repeat(50) })] };
  assert.throws(() => validateMessage(tooBig, { maxAttachmentBytes: 10 }), MailValidationError);
  const tooBigTotal = { ...base, attachments: [att({ content: 'x'.repeat(11) }), att({ filename: 'b.txt', content: 'y'.repeat(11) })] };
  assert.throws(() => validateMessage(tooBigTotal, { maxTotalAttachmentBytes: 20 }), MailValidationError);
});

test('SEC-075: custom headers cannot shadow structural headers (MIME/BCC smuggling)', () => {
  for (const key of ['Bcc', 'From', 'To', 'Cc', 'Subject', 'Content-Type', 'Content-Disposition', 'MIME-Version', 'Content-Transfer-Encoding']) {
    const message = { ...base, headers: { [key]: 'x' } };
    assert.throws(() => validateMessage(message), MailValidationError, `header ${key}`);
    assert.throws(() => buildMimeMessage(message), MailValidationError, `MIME header ${key}`);
  }
  assert.throws(() => validateMessage({ ...base, headers: { 'X-Ok': 'a\r\nBcc: evil@x.com' } }), MailValidationError);
});

test('SEC-076: BCC is envelope-only across MIME, HTTP payload and SMTP mapping', () => {
  const message = { ...base, bcc: [{ email: 'audit@example.com' }], cc: [{ email: 'carol@example.com' }] };
  const { raw, envelope } = buildMimeMessage(message);
  assert.ok(!raw.includes('audit@example.com'), 'no bcc address in the wire message');
  assert.ok(!/\bBcc:/i.test(raw), 'no Bcc header');
  assert.ok(!buildHttpPayload(message).raw.includes('audit@example.com'));
  const mapped = toNodemailerMessage(message);
  assert.deepEqual(mapped.bcc, [{ address: 'audit@example.com' }], 'bcc is an envelope recipient, not a header');
  assert.ok(!('Bcc' in (mapped.headers ?? {})), 'no Bcc custom header');
  assert.deepEqual([...envelope.to], ['alice@example.com', 'carol@example.com', 'audit@example.com']);
});

test('SEC-077: serialized MIME is CRLF-only, 7-bit safe headers, no raw control bytes', () => {
  const { raw } = buildMimeMessage({
    ...base,
    subject: 'Welcome ünicode 主题',
    text: 'a=b\r\nünicode\nline',
    attachments: [att({ filename: ' données ü.pdf', contentType: 'application/pdf', content: 'x' })],
  });
  assert.ok(!/(^|[^\r])\n/.test(raw), 'no bare LF');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw), 'no control bytes');
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /filename\*=UTF-8''%20donn%C3%A9es%20%C3%BC\.pdf/);
  assert.ok(!raw.includes('%25'), 'no double encoding');
});

test('SEC-078: SMTP config never leaks credentials and forbids file/URL access', () => {
  const secret = 'super-secret-pass-9f8e7d';
  assert.throws(() => new SmtpTransport({ host: 'smtp.example.com', auth: { user: 'u', pass: `${secret}\r\n` } }), (err) => {
    assert.equal(err.name, 'MailConfigurationError');
    assert.ok(!err.message.includes(secret));
    assert.ok(!JSON.stringify(err.details ?? {}).includes(secret));
    return true;
  });
  assert.equal(toNodemailerMessage(base).disableFileAccess, true);
  assert.equal(toNodemailerMessage(base).disableUrlAccess, true);
  assert.throws(() => new SmtpTransport({ host: 'user:pass@smtp.example.com' }), MailConfigurationError);
  assert.throws(() => new SmtpTransport({ host: 'smtp.example.com', tls: { rejectUnauthorized: 'no' } }), MailConfigurationError);
});

test('SEC-079: HTTP SSRF guards — scheme, userinfo, fragment, host allow-list, hop-by-hop headers', () => {
  for (const endpoint of [
    'ftp://example.com/send', 'file:///etc/passwd', '/relative',
    'https://user:pass@example.com/send', 'https://example.com/send#frag',
    'https://example.com/send\r\nX: y',
  ]) {
    assert.throws(() => new HttpTransport({ endpoint }), MailConfigurationError, endpoint);
  }
  assert.throws(() => new HttpTransport({ endpoint: 'https://example.com/send', allowedHosts: ['trusted.example.com'] }), MailConfigurationError);
  for (const headers of [{ Host: 'evil' }, { 'Content-Length': '9' }, { 'X-Auth': 'a\r\nBcc: x' }]) {
    assert.throws(() => new HttpTransport({ endpoint: 'https://example.com/send', headers }), MailConfigurationError);
  }
});

test('SEC-080: auth reset endpoint rejects credentials/fragments and tokens are percent-encoded', async () => {
  const transport = new TestTransport();
  const mailer = new Mailer({ transport, sleep: async () => {}, now: () => 0 });
  assert.throws(() => createPasswordResetMailSender({ mailer, from, endpoint: 'https://u:p@app.example.com/reset' }), MailConfigurationError);
  assert.throws(() => createPasswordResetMailSender({ mailer, from, endpoint: 'https://app.example.com/reset#x' }), MailConfigurationError);
  const sender = createPasswordResetMailSender({ mailer, from, endpoint: 'https://app.example.com/reset' });
  await sender.send({ email: 'alice@example.com', token: 'a&b=evil"x', expiresAt: 1 });
  const html = transport.sent[0].message.html;
  assert.ok(html.includes('%26') || html.includes('&amp;'), 'token separators are encoded/escaped');
  assert.ok(!html.includes('onmouseover="') && !html.includes('evil"x'), 'no query/attribute injection');
  await mailer.close();
});

test('SEC-081: auth templates escape interpolated values by default and validate context', async () => {
  const transport = new TestTransport();
  const mailer = new Mailer({ transport, sleep: async () => {}, now: () => 0 });
  const sender = createPasswordResetMailSender({ mailer, from, endpoint: 'https://app.example.com/reset' });
  await assert.rejects(() => sender.send({ email: 'a@b.com', token: 't\r\nBcc: evil@x.com', expiresAt: 1 }), MailValidationError);
  await assert.rejects(() => sender.send({ email: 'not-an-email', token: 't', expiresAt: 1 }), MailValidationError);
  await assert.rejects(() => sender.send({ email: 'a@b.com', token: 't', expiresAt: Number.NaN }), MailValidationError);
  assert.equal(transport.sent.length, 0, 'invalid contexts never reach a provider');
  await sender.send({ email: 'alice@example.com', token: '<script>', expiresAt: 1 });
  assert.ok(!transport.sent[0].message.html.includes('<script>'), 'HTML body is escaped');
  await mailer.close();
});

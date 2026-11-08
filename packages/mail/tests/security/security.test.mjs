import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailer, renderTemplate, validateMessage, MailValidationError } from '../../dist/index.js';
import { TestTransport } from '../../dist/test-transport.js';

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

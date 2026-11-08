import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Mailer,
  renderTemplate,
  escapeHtml,
  validateMessage,
  validateAddress,
  computeRetryDelay,
  DEFAULT_RETRY,
  MailValidationError,
  MailTemplateError,
  MailSendError,
  MailClosedError,
} from '../dist/index.js';
import { TestTransport } from '../dist/test-transport.js';

const from = { email: 'noreply@example.com', name: 'SvelteX' };
const to = [{ email: 'alice@example.com', name: 'Alice' }];
const baseMessage = { from, to, subject: 'Hello', text: 'Hi Alice' };

function mailer(transport, extra = {}) {
  return new Mailer({ transport, sleep: async () => {}, now: () => 1000, ...extra });
}

test('computeRetryDelay is exponential and capped', () => {
  const p = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, factor: 2 };
  assert.equal(computeRetryDelay(1, p), 100);
  assert.equal(computeRetryDelay(2, p), 200);
  assert.equal(computeRetryDelay(3, p), 400);
  assert.equal(computeRetryDelay(4, p), 800);
  assert.equal(computeRetryDelay(5, p), 1000);
  assert.ok(DEFAULT_RETRY.maxAttempts >= 1);
});

test('escapeHtml escapes all dangerous characters', () => {
  assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});

test('renderTemplate interpolates subject/text/html and escapes HTML by default', () => {
  const tpl = { subject: 'Hi {{ user.name }}', text: 'Welcome {{ user.name }}', html: '<p>{{ user.name }}</p>' };
  const out = renderTemplate(tpl, { user: { name: '<script>' } });
  assert.equal(out.subject, 'Hi <script>');
  assert.equal(out.text, 'Welcome <script>'); // text is not HTML-escaped
  assert.equal(out.html, '<p>&lt;script&gt;</p>'); // html is escaped
  assert.ok(Object.isFrozen(out));
});

test('renderTemplate supports opting out of HTML escaping and allowMissing', () => {
  const tpl = { subject: 'S {{ a }} {{ missing }}', html: '<b>{{ a }}</b>' };
  const out = renderTemplate(tpl, { a: '<i>' }, { escapeHtml: false, allowMissing: true });
  assert.equal(out.subject, 'S <i> ');
  assert.equal(out.html, '<b><i></b>');
});

test('renderTemplate is strict about missing variables by default', () => {
  assert.throws(() => renderTemplate({ subject: '{{ missing }}' }, {}), { name: 'MailTemplateError' });
});

test('validateMessage accepts a well-formed message and rejects invalid shapes', () => {
  assert.doesNotThrow(() => validateMessage(baseMessage));
  assert.throws(() => validateMessage({ ...baseMessage, to: [] }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...baseMessage, text: undefined }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...baseMessage, subject: '' }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...baseMessage, from: { email: 'not-an-email' } }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...baseMessage, text: 'x'.repeat(50) }, { maxBodyBytes: 4 }), { name: 'MailValidationError' });
});

test('validateAddress checks email format', () => {
  assert.doesNotThrow(() => validateAddress({ email: 'a.b+c@example.co.uk' }, 'x'));
  assert.throws(() => validateAddress({ email: 'a@b' }, 'x'), { name: 'MailValidationError' });
  assert.throws(() => validateAddress({ email: 'a@@b.com' }, 'x'), { name: 'MailValidationError' });
  assert.ok(MailValidationError && MailTemplateError);
});

test('Mailer.send delivers a message and returns a receipt with attempts=1', async () => {
  const transport = new TestTransport({ now: () => 1000, generateId: () => 'mid-1' });
  const m = mailer(transport);
  const receipt = await m.send(baseMessage);
  assert.equal(receipt.messageId, 'mid-1');
  assert.equal(receipt.acceptedAt, 1000);
  assert.equal(receipt.attempts, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].message.subject, 'Hello');
  assert.ok(Object.isFrozen(transport.sent[0]));
  await m.close();
});

test('Mailer.send freezes the message handed to the transport (no caller mutation)', async () => {
  const transport = new TestTransport();
  const m = mailer(transport);
  const mutable = { ...baseMessage, to: [{ email: 'alice@example.com' }] };
  await m.send(mutable);
  mutable.subject = 'tampered';
  mutable.to[0].email = 'evil@evil.com';
  assert.equal(transport.sent[0].message.subject, 'Hello');
  assert.equal(transport.sent[0].message.to[0].email, 'alice@example.com');
  await m.close();
});

test('Mailer retries transient failures and then succeeds with attempts=N+1', async () => {
  const transport = new TestTransport({ failFirst: 2, now: () => 1000 });
  const errors = [];
  const m = mailer(transport, { onError: (e, attempt) => errors.push(attempt) });
  const receipt = await m.send(baseMessage);
  assert.equal(receipt.attempts, 3);
  assert.deepEqual(errors, [1, 2]);
  assert.equal(transport.attempts, 3);
  assert.equal(transport.sent.length, 1);
  await m.close();
});

test('Mailer uses the injected sleeper with exponential delays (deterministic)', async () => {
  const transport = new TestTransport({ failFirst: 2 });
  const sleeps = [];
  const m = mailer(transport, { sleep: async (ms) => { sleeps.push(ms); } });
  await m.send(baseMessage);
  assert.deepEqual(sleeps, [100, 200]);
  await m.close();
});

test('Mailer throws MailSendError after exhausting retries (never a false success)', async () => {
  const transport = new TestTransport({ failAlways: true });
  const errors = [];
  const m = mailer(transport, { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, factor: 1 }, onError: (e) => errors.push(e) });
  await assert.rejects(() => m.send(baseMessage), (err) => {
    assert.equal(err.name, 'MailSendError');
    assert.equal(err.attempts, 3);
    assert.equal(err.cause.name, 'MailTransportError');
    return true;
  });
  assert.equal(errors.length, 3);
  assert.equal(transport.sent.length, 0);
  await m.close();
});

test('Mailer.sendTemplate renders then validates then sends', async () => {
  const transport = new TestTransport({ now: () => 42 });
  const m = mailer(transport);
  const tpl = { subject: 'Welcome {{ name }}', text: 'Hello {{ name }}', html: '<b>{{ name }}</b>' };
  const receipt = await m.sendTemplate(tpl, { from, to, data: { name: 'Alice' } });
  assert.equal(receipt.attempts, 1);
  const sent = transport.sent[0].message;
  assert.equal(sent.subject, 'Welcome Alice');
  assert.equal(sent.text, 'Hello Alice');
  assert.equal(sent.html, '<b>Alice</b>');
  await m.close();
});

test('validation happens before transport (invalid message never reaches provider)', async () => {
  const transport = new TestTransport();
  const m = mailer(transport);
  await assert.rejects(() => m.send({ ...baseMessage, subject: 'Bad\r\nBcc: victim@x.com' }), { name: 'MailValidationError' });
  assert.equal(transport.attempts, 0);
  await m.close();
});

test('close() is idempotent and rejects later sends', async () => {
  const transport = new TestTransport();
  const m = mailer(transport);
  await m.close();
  await m.close();
  assert.equal(m.isClosed, true);
  assert.equal(transport.isClosed, true);
  await assert.rejects(() => m.send(baseMessage), { name: 'MailClosedError' });
  assert.ok(MailSendError && MailClosedError);
});

test('constructor validates transport and retry configuration', () => {
  assert.throws(() => new Mailer({}), { name: 'MailValidationError' });
  assert.throws(() => new Mailer({ transport: new TestTransport(), retry: { maxAttempts: 0 } }), { name: 'MailValidationError' });
  assert.throws(() => new Mailer({ transport: new TestTransport(), retry: { maxAttempts: 3, baseDelayMs: -1, maxDelayMs: 0, factor: 1 } }), { name: 'MailValidationError' });
});

test('TestTransport records attempts, is deterministic and close guards sends', async () => {
  const transport = new TestTransport({ generateId: () => 'fixed' });
  const a = await transport.send(baseMessage);
  const b = await transport.send(baseMessage);
  assert.equal(a.messageId, 'fixed');
  assert.equal(b.messageId, 'fixed');
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[0].attempt, 1);
  assert.equal(transport.sent[1].attempt, 2);
  await transport.close();
  await assert.rejects(() => transport.send(baseMessage), { name: 'MailTransportError' });
});

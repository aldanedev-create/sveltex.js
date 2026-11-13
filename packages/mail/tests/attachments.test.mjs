import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMessage,
  validateAttachment,
  attachmentBytes,
  Mailer,
  MailValidationError,
  escapeHtml,
  MAX_ATTACHMENTS,
  DEFAULT_MAX_ATTACHMENT_BYTES,
} from '../dist/index.js';
import { TestTransport } from '../dist/test-transport.js';

const from = { email: 'noreply@example.com' };
const to = [{ email: 'alice@example.com' }];
const base = { from, to, subject: 'Hello', text: 'Hi' };
const att = (over = {}) => ({ filename: 'report.txt', contentType: 'text/plain', content: 'body', ...over });
const mailer = (transport, extra = {}) => new Mailer({ transport, sleep: async () => {}, now: () => 0, ...extra });

test('validateMessage accepts well-formed attachments', () => {
  assert.doesNotThrow(() => validateMessage({ ...base, attachments: [att()] }));
  assert.doesNotThrow(() => validateMessage({ ...base, attachments: [
    att({ content: new Uint8Array([0, 1, 255]) }),
    att({ filename: 'data.bin', contentType: 'application/octet-stream', content: 'AAEC/w==', encoding: 'base64' }),
    att({ filename: 'logo.png', contentType: 'image/png', content: 'x', contentId: 'logo-1', inline: true }),
  ] }));
});

test('attachmentBytes decodes string / Uint8Array / base64 exactly', () => {
  assert.deepEqual([...attachmentBytes(att({ content: 'héllo' }))], [...Buffer.from('héllo', 'utf8')]);
  assert.deepEqual([...attachmentBytes(att({ content: new Uint8Array([1, 2, 255]) }))], [1, 2, 255]);
  assert.deepEqual([...attachmentBytes(att({ content: 'AAEC/w==', encoding: 'base64' }))], [0, 1, 2, 255]);
  assert.throws(() => attachmentBytes(att({ content: 'not base64!', encoding: 'base64' })), { name: 'MailValidationError' });
  assert.throws(() => attachmentBytes(att({ content: 'AAE', encoding: 'base64' })), { name: 'MailValidationError' });
});

test('validateAttachment rejects CRLF/NUL/control, path separators, colons, traversal names', () => {
  for (const filename of ['a\r\nBcc: x@y.com', 'a\u0000b', '../secret', 'a/b.txt', 'a\\b.txt', 'C:\\x', '.hidden', '..', '', 'x'.repeat(256)]) {
    assert.throws(() => validateAttachment(att({ filename }), 'a'), { name: 'MailValidationError' }, `filename ${JSON.stringify(filename)}`);
  }
});

test('validateAttachment rejects header injection / invalid MIME type', () => {
  for (const contentType of ['text/plain\r\nX: y', 'not-a-mime', '', 'text/\u0000plain', 'x'.repeat(256)]) {
    assert.throws(() => validateAttachment(att({ contentType }), 'a'), { name: 'MailValidationError' });
  }
  assert.doesNotThrow(() => validateAttachment(att({ contentType: 'application/vnd.api+json; charset=utf-8' }), 'a'));
});

test('validateMessage enforces attachment count and size caps', () => {
  assert.throws(() => validateMessage({ ...base, attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => att()) }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...base, attachments: [att({ content: 'x'.repeat(50) })] }, { maxAttachmentBytes: 10 }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...base, attachments: [att({ content: 'x'.repeat(11) }), att({ filename: 'b.txt', content: 'y'.repeat(11) })] }, { maxTotalAttachmentBytes: 20 }), { name: 'MailValidationError' });
  assert.throws(() => validateMessage({ ...base, attachments: [att()] }, { maxAttachments: 0 }), { name: 'MailValidationError' });
  assert.ok(DEFAULT_MAX_ATTACHMENT_BYTES > 0);
});

test('validateAttachment validates contentId, inline, encoding, content type of content', () => {
  assert.throws(() => validateAttachment(att({ contentId: 'bad\r\n' }), 'a'), { name: 'MailValidationError' });
  assert.throws(() => validateAttachment(att({ contentId: '<x>' }), 'a'), { name: 'MailValidationError' });
  assert.throws(() => validateAttachment(att({ inline: 'yes' }), 'a'), { name: 'MailValidationError' });
  assert.throws(() => validateAttachment(att({ encoding: 'hex' }), 'a'), { name: 'MailValidationError' });
  assert.throws(() => validateAttachment(att({ content: 42 }), 'a'), { name: 'MailValidationError' });
});

test('custom headers cannot shadow structural headers (BCC/MIME smuggling guard)', () => {
  for (const key of ['Bcc', 'From', 'To', 'Content-Type', 'MIME-Version', 'Subject']) {
    assert.throws(() => validateMessage({ ...base, headers: { [key]: 'x' } }), { name: 'MailValidationError' }, `header ${key}`);
  }
  assert.doesNotThrow(() => validateMessage({ ...base, headers: { 'X-App': 'ok' } }));
});

test('Mailer freezes attachments (caller cannot mutate bytes after send)', async () => {
  const transport = new TestTransport();
  const m = mailer(transport);
  const bytes = new Uint8Array([1, 2, 3]);
  const message = { ...base, attachments: [att({ content: bytes })] };
  await m.send(message);
  const sent = transport.sent[0].message;
  assert.ok(Object.isFrozen(sent.attachments));
  assert.ok(Object.isFrozen(sent.attachments[0]));
  bytes[0] = 99;
  assert.equal(sent.attachments[0].content[0], 1, 'frozen copy must be detached from caller buffer');
  assert.deepEqual([...sent.attachments[0].content], [1, 2, 3]);
  await m.close();
});

test('Mailer.sendTemplate forwards attachments and validates them', async () => {
  const transport = new TestTransport();
  const m = mailer(transport);
  const tpl = { subject: 'Hi {{ name }}', text: 'Hello {{ name }}' };
  const receipt = await m.sendTemplate(tpl, { from, to, data: { name: 'Alice' }, attachments: [att()] });
  assert.equal(receipt.attempts, 1);
  assert.equal(transport.sent[0].message.attachments.length, 1);
  await assert.rejects(() => m.sendTemplate(tpl, { from, to, data: { name: 'Alice' }, attachments: [att({ filename: '../x' })] }), MailValidationError);
  assert.equal(transport.sent.length, 1, 'invalid attachment never reaches transport');
  await m.close();
});

test('escapeHtml unchanged for Phase 8 and MailValidationError exported', () => {
  assert.equal(escapeHtml('<&"\'>'), '&lt;&amp;&quot;&#39;&gt;');
  assert.ok(MailValidationError);
});

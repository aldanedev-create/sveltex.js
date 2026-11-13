import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMimeMessage } from '../dist/mime.js';

const from = { email: 'noreply@example.com', name: 'SvelteX' };
const to = [{ email: 'alice@example.com' }];
const base = { from, to, subject: 'Hello', text: 'Hi' };

// Deterministic build: injected clock / Message-ID / constant boundary generator.
const opts = () => ({
  now: () => 1_700_000_000_000,
  generateId: () => 'fixed-id',
  generateBoundary: () => 'FIXED',
});

function decodeQp(qp) {
  const text = qp.replace(/=\r\n/g, '').replace(/\r\n/g, '\n');
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(text[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

test('MIME: deterministic raw is CRLF-only and carries structural headers', () => {
  const doc = buildMimeMessage(base, opts());
  assert.ok(doc.raw.includes('From: "SvelteX" <noreply@example.com>\r\n'));
  assert.ok(doc.raw.includes('To: alice@example.com\r\n'));
  assert.ok(doc.raw.includes('Subject: Hello\r\n'));
  assert.ok(doc.raw.includes('Message-ID: <fixed-id@example.com>\r\n'));
  assert.ok(doc.raw.includes('MIME-Version: 1.0\r\n'));
  assert.ok(doc.raw.includes('Date: Tue, 14 Nov 2023 22:13:20 +0000\r\n'));
  assert.match(doc.raw, /Content-Type: text\/plain; charset=utf-8\r\n/);
  assert.match(doc.raw, /Content-Transfer-Encoding: 7bit\r\n/);
  assert.ok(!/(^|[^\r])\n/.test(doc.raw), 'no bare LF anywhere');
  assert.ok(Object.isFrozen(doc));
  assert.ok(Object.isFrozen(doc.envelope));
  assert.deepEqual([...doc.envelope.to], ['alice@example.com']);
  assert.equal(doc.envelope.messageId, '<fixed-id@example.com>');
  assert.equal(doc.envelope.from, 'noreply@example.com');
});

test('MIME: plain-text-only message uses a 7bit text/plain entity', () => {
  const { raw } = buildMimeMessage({ ...base, text: 'A simple line.' }, opts());
  assert.ok(raw.endsWith('\r\n\r\nA simple line.'));
  assert.ok(!raw.includes('multipart/'));
});

test('MIME: html-only message uses a text/html entity', () => {
  const { raw } = buildMimeMessage({ from, to, subject: 'S', html: '<p>Hi</p>' }, opts());
  assert.match(raw, /Content-Type: text\/html; charset=utf-8/);
  assert.ok(raw.endsWith('\r\n\r\n<p>Hi</p>'));
});

test('MIME: text + html produce multipart/alternative with both parts', () => {
  const { raw } = buildMimeMessage({ ...base, text: 'plain', html: '<b>rich</b>' }, opts());
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="=_sveltex_FIXED1_="/);
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(raw, /Content-Type: text\/html; charset=utf-8/);
  assert.ok(raw.includes('\r\n\r\nplain\r\n'));
  assert.ok(raw.includes('\r\n\r\n<b>rich</b>\r\n'));
  assert.ok(raw.trimEnd().endsWith('--=_sveltex_FIXED1_=--'));
});

test('MIME: nested multiparts get distinct boundaries even with a constant generator', () => {
  const message = {
    ...base,
    html: '<p>rich</p>',
    attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'abc' }],
  };
  const { raw } = buildMimeMessage(message, opts());
  const boundaries = [...raw.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(boundaries.length, 2);
  assert.notEqual(boundaries[0], boundaries[1], 'alternative and mixed boundaries must differ');
  assert.match(raw, /multipart\/mixed; boundary="=_sveltex_FIXED2_="/);
});

test('MIME: binary attachment is base64-encoded and round-trips byte-exact', () => {
  const bytes = new Uint8Array([0, 1, 2, 37, 80, 68, 70, 255]);
  const { raw } = buildMimeMessage({ ...base, attachments: [{ filename: 'blob.bin', contentType: 'application/octet-stream', content: bytes }] }, opts());
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.match(raw, /Content-Disposition: attachment; filename="blob.bin"/);
  const encoded = Buffer.from(bytes).toString('base64');
  assert.ok(raw.includes(encoded));
  assert.deepEqual([...Buffer.from(encoded, 'base64')], [...bytes]);
});

test('MIME: inline attachment with contentId emits inline disposition and Content-ID', () => {
  const { raw } = buildMimeMessage({
    ...base,
    attachments: [{ filename: 'logo.png', contentType: 'image/png', content: 'AAEC', inline: true, contentId: 'logo-1' }],
  }, opts());
  assert.match(raw, /Content-Disposition: inline; filename="logo.png"/);
  assert.match(raw, /Content-ID: <logo-1>/);
});

test('MIME: BCC is envelope-only and never serialized into headers', () => {
  const { raw, envelope } = buildMimeMessage({
    ...base,
    cc: [{ email: 'carol@example.com' }],
    bcc: [{ email: 'audit@example.com' }],
  }, opts());
  assert.ok(!/\bBcc:/i.test(raw), 'no Bcc header');
  assert.ok(!raw.includes('audit@example.com'), 'bcc address must not appear anywhere in the wire message');
  assert.ok(raw.includes('Cc: carol@example.com'));
  assert.deepEqual([...envelope.to], ['alice@example.com', 'carol@example.com', 'audit@example.com']);
});

test('MIME: non-ASCII subject uses RFC 2047 encoded-words, unicode filename uses RFC 2231', () => {
  const { raw } = buildMimeMessage({
    ...base,
    subject: 'Welcome ünicode 主题',
    attachments: [{ filename: ' données ü.pdf', contentType: 'application/pdf', content: 'x' }],
  }, opts());
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /filename\*=UTF-8''%20donn%C3%A9es%20%C3%BC\.pdf/);
  assert.ok(!raw.includes('%25'), 'no double percent-encoding');
  assert.ok(!/(^|[^\r])\n/.test(raw));
});

test('MIME: quoted-printable preserves equals signs, unicode and hard newlines', () => {
  const text = 'a=b\r\nsecond line with ünicode\nthird';
  const { raw } = buildMimeMessage({ ...base, text }, opts());
  assert.match(raw, /Content-Transfer-Encoding: quoted-printable/);
  const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  assert.ok(body.includes('a=3Db'));
  assert.ok(!/(^|[^\r])\n/.test(body), 'QP body must use CRLF only');
  assert.equal(decodeQp(body), 'a=b\nsecond line with ünicode\nthird');
});

test('MIME: custom headers are emitted, structural/header injection is rejected', () => {
  const { raw } = buildMimeMessage({ ...base, headers: { 'X-App': 'sveltex' } }, opts());
  assert.match(raw, /X-App: sveltex\r\n/);
  assert.throws(() => buildMimeMessage({ ...base, subject: 'Hi\r\nBcc: evil@x.com' }, opts()), { name: 'MailValidationError' });
  assert.throws(() => buildMimeMessage({ ...base, headers: { Bcc: 'x' } }, opts()), { name: 'MailValidationError' });
});

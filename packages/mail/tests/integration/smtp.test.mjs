// Real SMTP integration tests: a genuine smtp-server on an ephemeral loopback
// port, real nodemailer client, real MIME parsed by mailparser. No mocks.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startSmtpServer, baseMessage } from './helpers.mjs';
import { SmtpTransport } from '../../dist/smtp.js';
import {
  Mailer,
  MailSendError,
  MailTransportError,
  MailClosedError,
} from '../../dist/index.js';

let srv;
let port;

before(async () => {
  srv = await startSmtpServer({ disabledCommands: ['STARTTLS'], authOptional: false });
  port = srv.port;
});
after(async () => { if (srv) await srv.close(); });

function smtp(extra = {}) {
  return new SmtpTransport({
    host: '127.0.0.1',
    port,
    auth: { user: 'sveltex', pass: 'sveltex_test_pw' },
    now: () => 1700000000000,
    ...extra,
  });
}

test('INT-8-1: real SMTP AUTH + delivery metadata + verify()', async () => {
  const transport = smtp();
  await transport.verify();
  const receipt = await transport.send(baseMessage);
  assert.match(receipt.messageId, /^<.+@.+>$/);
  assert.equal(receipt.acceptedAt, 1700000000000);
  assert.equal(receipt.delivery.backend, 'smtp');
  assert.deepEqual([...receipt.delivery.accepted], ['alice@example.com']);
  assert.deepEqual([...receipt.delivery.rejected], []);
  assert.equal(receipt.delivery.envelopeFrom, 'noreply@example.com');
  assert.match(receipt.delivery.response, /250/);
  assert.equal(srv.authLog.length, 2); // verify() AUTH + send() AUTH
  assert.equal(srv.authLog[0].username, 'sveltex');
  await transport.close();
});

test('INT-8-2: cc/bcc/replyTo envelope — BCC never appears in wire headers', async () => {
  const transport = smtp();
  await transport.send({
    ...baseMessage,
    cc: [{ email: 'cc@example.com' }],
    bcc: [{ email: 'audit@example.com' }],
    replyTo: { email: 'reply@example.com' },
    headers: { 'X-App': 'sveltex' },
  });
  const cap = srv.captured.at(-1);
  assert.deepEqual([...cap.envelope.rcpt].sort(), ['alice@example.com', 'audit@example.com', 'cc@example.com']);
  const headerBlock = cap.raw.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/im.test(headerBlock), 'BCC must never be serialized into headers');
  assert.ok(/^Cc: cc@example.com/im.test(headerBlock));
  assert.ok(/^Reply-To: reply@example.com/im.test(headerBlock));
  assert.ok(/^X-App: sveltex/im.test(headerBlock));
  assert.equal(cap.parsed.replyTo?.text, 'reply@example.com');
  await transport.close();
});

test('INT-8-3: binary + unicode attachments survive the real SMTP wire', async () => {
  const transport = smtp();
  await transport.send({
    ...baseMessage,
    text: 'plain body',
    html: '<b>html body</b>',
    attachments: [
      { filename: 'report.txt', contentType: 'text/plain', content: 'text attachment' },
      { filename: ' données ü.pdf', contentType: 'application/pdf', content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]), contentId: 'logo-1' },
      { filename: 'b64.bin', contentType: 'application/octet-stream', content: Buffer.from([1, 2, 3, 253, 254, 255]).toString('base64'), encoding: 'base64' },
    ],
  });
  const cap = srv.captured.at(-1);
  assert.equal(cap.parsed.text.trim(), 'plain body');
  assert.equal(cap.parsed.html.trim(), '<b>html body</b>');
  assert.equal(cap.parsed.attachments.length, 3);
  const byName = new Map(cap.parsed.attachments.map((a) => [a.filename, a]));
  assert.deepEqual([...byName.keys()].sort(), [' données ü.pdf', 'b64.bin', 'report.txt']);
  assert.equal(byName.get('report.txt').content.toString('utf8'), 'text attachment');
  assert.deepEqual([...byName.get(' données ü.pdf').content], [0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
  assert.deepEqual([...byName.get('b64.bin').content], [1, 2, 3, 253, 254, 255]);
  await transport.close();
});

test('INT-8-4: STARTTLS upgrade over a real TLS socket', async () => {
  // Fresh server that advertises STARTTLS with our generated self-signed cert.
  const tlsSrv = await startSmtpServer({ authOptional: true });
  try {
    const transport = new SmtpTransport({
      host: '127.0.0.1', port: tlsSrv.port, requireTLS: true,
      tls: { rejectUnauthorized: false }, // test-only self-signed cert
    });
    await transport.send(baseMessage);
    const cap = tlsSrv.captured.at(-1);
    assert.equal(cap.secure, true, 'session must have been upgraded to TLS');
    assert.equal(cap.parsed.subject, 'Hello from SvelteX');
    await transport.close();
  } finally {
    await tlsSrv.close();
  }
});

test('INT-8-5: implicit TLS (secure: true) over a real TLS socket', async () => {
  const tlsSrv = await startSmtpServer({ secure: true, authOptional: true });
  try {
    const transport = new SmtpTransport({
      host: '127.0.0.1', port: tlsSrv.port, secure: true,
      tls: { rejectUnauthorized: false },
    });
    await transport.send(baseMessage);
    assert.equal(tlsSrv.captured.at(-1).secure, true);
    await transport.close();
  } finally {
    await tlsSrv.close();
  }
});

test('INT-8-6: untrusted TLS certificate is rejected by default (no silent downgrade)', async () => {
  const tlsSrv = await startSmtpServer({ authOptional: true });
  try {
    // Default rejectUnauthorized=true; the self-signed cert is untrusted.
    const transport = new SmtpTransport({ host: '127.0.0.1', port: tlsSrv.port, requireTLS: true });
    await assert.rejects(() => transport.send(baseMessage), (err) => {
      assert.equal(err.name, 'MailTransportError');
      assert.equal(err.details.backend, 'smtp');
      assert.ok(!err.message.includes('sveltex_test_pw'));
      return true;
    });
    assert.equal(tlsSrv.captured.length, 0, 'no message delivered without verified TLS');
    await transport.close();
  } finally {
    await tlsSrv.close();
  }
});

test('INT-8-7: transient SMTP failure is retried by Mailer, then succeeds', async () => {
  const flaky = await startSmtpServer({ disabledCommands: ['STARTTLS'], authOptional: true, failFirstMailFrom: 1 });
  try {
    const transport = new SmtpTransport({ host: '127.0.0.1', port: flaky.port });
    const mailer = new Mailer({ transport, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, factor: 1 }, sleep: async () => {}, now: () => 1 });
    const receipt = await mailer.send(baseMessage);
    assert.equal(receipt.attempts, 2);
    assert.equal(flaky.captured.length, 1);
    await mailer.close();
  } finally {
    await flaky.close();
  }
});

test('INT-8-8: permanent SMTP failure -> MailSendError, never a false success', async () => {
  const dead = await startSmtpServer({ disabledCommands: ['STARTTLS'], authOptional: false, failFirstMailFrom: 999 });
  try {
    const transport = new SmtpTransport({ host: '127.0.0.1', port: dead.port, auth: { user: 'x', pass: 'y' } });
    const mailer = new Mailer({ transport, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, factor: 1 }, sleep: async () => {} });
    await assert.rejects(() => mailer.send(baseMessage), (err) => {
      assert.equal(err.name, 'MailSendError');
      assert.equal(err.attempts, 2);
      assert.equal(err.cause.name, 'MailTransportError');
      return true;
    });
    assert.equal(dead.captured.length, 0);
    await mailer.close();
  } finally {
    await dead.close();
  }
});

test('INT-8-9: bad AUTH credentials -> wrapped error without credential leakage', async () => {
  const authSrv = await startSmtpServer({
    disabledCommands: ['STARTTLS'], authOptional: false,
    authValidator: (_auth, cb) => cb(new Error('535 Authentication credentials invalid')),
  });
  try {
    const transport = new SmtpTransport({
      host: '127.0.0.1', port: authSrv.port,
      auth: { user: 'sveltex', pass: 'SUPER_SECRET_PW' },
    });
    await assert.rejects(() => transport.send(baseMessage), (err) => {
      assert.equal(err.name, 'MailTransportError');
      assert.ok(!err.message.includes('SUPER_SECRET_PW'));
      assert.ok(!JSON.stringify(err.details).includes('SUPER_SECRET_PW'));
      return true;
    });
    await transport.close();
  } finally {
    await authSrv.close();
  }
});

test('INT-8-10: close() is idempotent and later sends are refused', async () => {
  const transport = smtp();
  await transport.close();
  await transport.close();
  assert.equal(transport.isClosed, true);
  await assert.rejects(() => transport.send(baseMessage), { name: 'MailClosedError' });
  await assert.rejects(() => transport.verify(), { name: 'MailClosedError' });
  assert.ok(MailSendError && MailTransportError && MailClosedError);
});

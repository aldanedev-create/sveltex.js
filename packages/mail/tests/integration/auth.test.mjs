// Real cross-package integration: genuine @sveltex/auth services + real mail
// senders + real SmtpTransport + real SMTP server. No fake provider anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PasswordResetService } from '@sveltex/auth/reset';
import { EmailVerificationService } from '@sveltex/auth/verification';
import { TokenManager, MemoryTokenStore } from '@sveltex/auth/tokens';
import { startSmtpServer } from './helpers.mjs';
import { SmtpTransport } from '../../dist/smtp.js';
import { Mailer, MailValidationError } from '../../dist/index.js';
import { TestTransport } from '../../dist/test-transport.js';
import {
  createPasswordResetMailSender,
  createEmailVerificationMailSender,
} from '../../dist/auth.js';

const FROM = { email: 'noreply@example.com', name: 'SvelteX' };
const RESET_URL = 'https://app.example.com/reset-password';
const VERIFY_URL = 'https://app.example.com/verify-email';

function buildStore() {
  return {
    findByEmail: async (email) => (email === 'alice@example.com' ? { id: 'u1', email, passwordHash: 'x'.repeat(30) } : undefined),
    findById: async (id) => ({ id, email: 'alice@example.com' }),
    updatePassword: async () => true,
    markVerified: async () => true,
  };
}
const HASHER = { hash: async () => 'h'.repeat(30), verify: async () => false };

function harness(capturedServerPort) {
  const transport = new SmtpTransport({ host: '127.0.0.1', port: capturedServerPort });
  const mailer = new Mailer({ transport, sleep: async () => {}, now: () => 1000 });
  return { transport, mailer };
}

test('INT-8-A1: PasswordResetService -> real SMTP: reset link delivered, unknown email silent', async () => {
  const srv = await startSmtpServer({ disabledCommands: ['STARTTLS'], authOptional: true });
  try {
    const { mailer, transport } = harness(srv.port);
    const tokens = new TokenManager(new MemoryTokenStore({ now: () => 1000 }));
    const service = new PasswordResetService(buildStore(), HASHER, tokens);
    const sender = createPasswordResetMailSender({ mailer, from: FROM, endpoint: RESET_URL, appName: 'Acme' });

    await service.requestReset('alice@example.com', sender);
    await service.requestReset('nobody@example.com', sender); // no user enumeration

    assert.equal(srv.captured.length, 1);
    const cap = srv.captured[0];
    assert.equal(cap.parsed.subject, 'Reset your Acme password');
    assert.equal(cap.envelope.rcpt[0], 'alice@example.com');
    assert.match(cap.parsed.text, /reset-password\?token=/);
    assert.match(cap.parsed.html, /href="https:\/\/app\.example\.com\/reset-password\?token=/);
    // Token is real (issued by auth) and present in the delivered link.
    assert.ok(/token=[A-Za-z0-9._~-]+/.test(cap.parsed.text));
    await mailer.close();
    assert.equal(transport.isClosed, true);
  } finally {
    await srv.close();
  }
});

test('INT-8-A2: EmailVerificationService -> real SMTP: verification link delivered', async () => {
  const srv = await startSmtpServer({ disabledCommands: ['STARTTLS'], authOptional: true });
  try {
    const { mailer } = harness(srv.port);
    const tokens = new TokenManager(new MemoryTokenStore({ now: () => 1000 }));
    const service = new EmailVerificationService(buildStore(), tokens);
    const sender = createEmailVerificationMailSender({ mailer, from: FROM, endpoint: VERIFY_URL });
    await service.requestVerification({ id: 'u1', email: 'alice@example.com' }, sender);
    assert.equal(srv.captured.length, 1);
    assert.equal(srv.captured[0].parsed.subject, 'Verify your SvelteX email address');
    assert.match(srv.captured[0].parsed.text, /verify-email\?token=/);
    await mailer.close();
  } finally {
    await srv.close();
  }
});

test('INT-8-A3: reset + verification tokens are single-use and purpose-scoped (end-to-end)', async () => {
  const srv = await startSmtpServer({ disabledCommands: ['STARTTLS'], authOptional: true });
  try {
    const { mailer } = harness(srv.port);
    const tokens = new TokenManager(new MemoryTokenStore({ now: () => 1000 }));
    const store = buildStore();
    const reset = new PasswordResetService(store, HASHER, tokens);
    const verify = new EmailVerificationService(store, tokens);
    await reset.requestReset('alice@example.com', createPasswordResetMailSender({ mailer, from: FROM, endpoint: RESET_URL }));
    await verify.requestVerification({ id: 'u1', email: 'alice@example.com' }, createEmailVerificationMailSender({ mailer, from: FROM, endpoint: VERIFY_URL }));
    assert.equal(srv.captured.length, 2);

    const resetText = srv.captured[0].parsed.text;
    const verifyText = srv.captured[1].parsed.text;
    const resetToken = decodeURIComponent(/token=([^&\s]+)/.exec(resetText)[1]);
    const verifyToken = decodeURIComponent(/token=([^&\s]+)/.exec(verifyText)[1]);
    assert.notEqual(resetToken, verifyToken);

    // A verification token cannot be replayed as a password-reset token.
    await assert.rejects(() => reset.completeReset(verifyToken, 'a-strong-new-password'), { code: 'AUTH_TOKEN_INVALID' });
    // The genuine reset token works and is single-use.
    const updated = await reset.completeReset(resetToken, 'a-strong-new-password');
    assert.equal(updated.id, 'u1');
    await assert.rejects(() => reset.completeReset(resetToken, 'another-password'), { code: 'AUTH_TOKEN_USED' });
    // The verification token works for its own purpose.
    assert.equal(await verify.verify(verifyToken), 'u1');
    await mailer.close();
  } finally {
    await srv.close();
  }
});

test('INT-8-A4: sender injects cc/bcc/attachments and validates context', async () => {
  const transport = new TestTransport();
  const mailer = new Mailer({ transport, sleep: async () => {}, now: () => 1000 });
  const sender = createPasswordResetMailSender({
    mailer, from: FROM, endpoint: RESET_URL,
    cc: [{ email: 'ops@example.com' }],
    bcc: [{ email: 'audit@example.com' }],
    headers: { 'X-Flow': 'password-reset' },
    attachments: [{ filename: 'policy.txt', contentType: 'text/plain', content: 'reset policy' }],
  });
  await sender.send({ email: 'alice@example.com', token: 'tok-123', expiresAt: 1700000000000 });
  const sent = transport.sent[0].message;
  assert.deepEqual(sent.cc, [{ email: 'ops@example.com' }]);
  assert.deepEqual(sent.bcc, [{ email: 'audit@example.com' }]);
  assert.equal(sent.headers['X-Flow'], 'password-reset');
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].filename, 'policy.txt');
  assert.equal(sent.subject, 'Reset your SvelteX password');

  await assert.rejects(() => sender.send({ email: 'bad', token: 't', expiresAt: 1 }), MailValidationError);
  await assert.rejects(() => sender.send({ email: 'a@b.com', token: 'bad\r\nBcc: x@y.com', expiresAt: 1 }), MailValidationError);
  await assert.rejects(() => sender.send({ email: 'a@b.com', token: 't', expiresAt: Infinity }), MailValidationError);
  assert.equal(transport.sent.length, 1, 'invalid contexts never reach the provider');
  await mailer.close();
});

test('INT-8-A5: endpoint validation rejects credentials, schemes, and fragments', async () => {
  const transport = new TestTransport();
  const mailer = new Mailer({ transport, sleep: async () => {} });
  const bad = [
    'https://user:pw@app.example.com/reset',
    'javascript:alert(1)',
    'ftp://app.example.com/reset',
    'https://app.example.com/reset#frag',
    'not-a-url',
  ];
  for (const endpoint of bad) {
    assert.throws(
      () => createPasswordResetMailSender({ mailer, from: FROM, endpoint }),
      { name: 'MailConfigurationError' },
      `should reject ${endpoint}`,
    );
  }
  assert.equal(transport.sent.length, 0);
  await mailer.close();
});

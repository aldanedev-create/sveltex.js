// Real HTTP integration tests: a genuine node:http server on an ephemeral
// loopback port, real fetch, real MIME parsed by mailparser. No mocks.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { startHttpServer, jsonResponse, baseMessage } from './helpers.mjs';
import {
  HttpTransport,
  buildHttpPayload,
  MAIL_HTTP_CONTENT_TYPE,
  MAIL_HTTP_ENVELOPE_VERSION,
} from '../../dist/http.js';
import { Mailer, MailSendError, MailTransportError, MailClosedError } from '../../dist/index.js';

test('INT-8-H1: real HTTP POST with strict v1 envelope and round-trippable MIME', async () => {
  const srv = await startHttpServer((_req, res) => jsonResponse(res, 202, { id: 'provider-abc' }));
  try {
    const transport = new HttpTransport({
      endpoint: srv.url,
      headers: { Authorization: 'Bearer TOP_SECRET_TOKEN' },
      now: () => 777,
      mime: { generateId: () => 'fixed-id', generateBoundary: () => 'BOUNDARY', now: () => 1700000000000 },
    });
    const receipt = await transport.send({
      ...baseMessage,
      subject: 'Welcome ünicode',
      text: 'plain',
      html: '<b>html</b>',
      bcc: [{ email: 'audit@example.com' }],
      attachments: [{ filename: 'report.txt', contentType: 'text/plain', content: 'attachment body' }],
    });
    assert.equal(receipt.messageId, 'provider-abc');
    assert.equal(receipt.acceptedAt, 777);
    assert.equal(receipt.delivery.backend, 'http');
    assert.equal(receipt.delivery.envelopeFrom, 'noreply@example.com');
    assert.deepEqual([...receipt.delivery.envelopeTo], ['alice@example.com', 'audit@example.com']);

    const req = srv.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], MAIL_HTTP_CONTENT_TYPE);
    assert.equal(req.headers['authorization'], 'Bearer TOP_SECRET_TOKEN');
    const payload = JSON.parse(req.body);
    assert.equal(payload.version, MAIL_HTTP_ENVELOPE_VERSION);
    assert.equal(payload.envelope.messageId, '<fixed-id@example.com>');
    assert.ok(!/^Bcc:/im.test(payload.raw.split('\r\n\r\n')[0]));
    const parsed = await simpleParser(payload.raw);
    assert.equal(parsed.subject, 'Welcome ünicode');
    assert.equal(parsed.text.trim(), 'plain');
    assert.equal(parsed.html.trim(), '<b>html</b>');
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].content.toString('utf8'), 'attachment body');
    await transport.close();
  } finally {
    await srv.close();
  }
});

test('INT-8-H2: allowedHosts SSRF guard rejects a mismatched host', async () => {
  const srv = await startHttpServer((_req, res) => jsonResponse(res, 200, { id: 'x' }));
  try {
    assert.throws(
      () => new HttpTransport({ endpoint: srv.url, allowedHosts: ['allowed.example.com'] }),
      { name: 'MailConfigurationError' },
    );
    const ok = new HttpTransport({ endpoint: srv.url, allowedHosts: [srv.host] });
    assert.equal(ok.isClosed, false);
    await ok.close();
    assert.equal(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});

test('INT-8-H3: non-2xx provider response is retried then fails (never a false success)', async () => {
  let calls = 0;
  const srv = await startHttpServer((_req, res) => {
    calls += 1;
    jsonResponse(res, 503, { error: 'unavailable' });
  });
  try {
    const transport = new HttpTransport({ endpoint: srv.url });
    const mailer = new Mailer({ transport, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, factor: 1 }, sleep: async () => {} });
    await assert.rejects(() => mailer.send(baseMessage), (err) => {
      assert.equal(err.name, 'MailSendError');
      assert.equal(err.attempts, 2);
      assert.equal(err.cause.name, 'MailTransportError');
      assert.equal(err.cause.details.status, 503);
      return true;
    });
    assert.equal(calls, 2);
    await mailer.close();
  } finally {
    await srv.close();
  }
});

test('INT-8-H4: redirects are not followed (Authorization cannot escape to another host)', async () => {
  const srv = await startHttpServer((_req, res) => res.writeHead(302, { location: 'http://evil.example.com/' }).end());
  try {
    const transport = new HttpTransport({ endpoint: srv.url, headers: { Authorization: 'Bearer NO_LEAK' } });
    await assert.rejects(() => transport.send(baseMessage), (err) => {
      assert.equal(err.name, 'MailTransportError');
      assert.equal(err.details.status, 302);
      assert.ok(!err.message.includes('NO_LEAK'));
      return true;
    });
    assert.equal(srv.requests.length, 1, 'no request was made to the redirect target');
    await transport.close();
  } finally {
    await srv.close();
  }
});

test('INT-8-H5: invalid JSON / missing message id is rejected', async () => {
  const badJson = await startHttpServer((_req, res) => jsonResponse(res, 200, 'not-json'));
  try {
    const t1 = new HttpTransport({ endpoint: badJson.url });
    await assert.rejects(() => t1.send(baseMessage), { name: 'MailTransportError' });
    await t1.close();
  } finally { await badJson.close(); }

  const noId = await startHttpServer((_req, res) => jsonResponse(res, 200, { ok: true }));
  try {
    const t2 = new HttpTransport({ endpoint: noId.url });
    await assert.rejects(() => t2.send(baseMessage), { name: 'MailTransportError' });
    await t2.close();
  } finally { await noId.close(); }
});

test('INT-8-H6: oversized provider response is bounded before parsing', async () => {
  const srv = await startHttpServer((_req, res) => jsonResponse(res, 200, 'x'.repeat(5000)));
  try {
    const transport = new HttpTransport({ endpoint: srv.url, maxResponseBytes: 128 });
    await assert.rejects(() => transport.send(baseMessage), (err) => {
      assert.equal(err.name, 'MailTransportError');
      assert.ok(!err.message.includes('xxxx'), 'provider body is never echoed into the error');
      return true;
    });
    await transport.close();
  } finally {
    await srv.close();
  }
});

test('INT-8-H7: connection failure is wrapped without leaking credentials', async () => {
  // Port 1 on loopback is not listening -> real fetch failure, no fake.
  const transport = new HttpTransport({
    endpoint: 'http://127.0.0.1:1/send',
    headers: { Authorization: 'Bearer SECRET_NEVER_LEAK' },
    timeoutMs: 2000,
  });
  await assert.rejects(() => transport.send(baseMessage), (err) => {
    assert.equal(err.name, 'MailTransportError');
    assert.equal(err.details.operation, 'request');
    assert.ok(!err.message.includes('SECRET_NEVER_LEAK'));
    assert.ok(!JSON.stringify(err.details).includes('SECRET_NEVER_LEAK'));
    return true;
  });
  await transport.close();
});

test('INT-8-H8: close() is idempotent and later sends are refused', async () => {
  const srv = await startHttpServer((_req, res) => jsonResponse(res, 200, { id: 'x' }));
  try {
    const transport = new HttpTransport({ endpoint: srv.url });
    await transport.close();
    await transport.close();
    assert.equal(transport.isClosed, true);
    await assert.rejects(() => transport.send(baseMessage), { name: 'MailClosedError' });
    assert.equal(srv.requests.length, 0);
    assert.ok(MailSendError && MailTransportError && MailClosedError);
  } finally {
    await srv.close();
  }
});

test('INT-8-H9: buildHttpPayload is deterministic with injected id/boundary/now', async () => {
  const opts = { generateId: () => 'abc', generateBoundary: () => 'B', now: () => 1700000000000 };
  const a = buildHttpPayload(baseMessage, opts);
  const b = buildHttpPayload(baseMessage, opts);
  assert.equal(a.raw, b.raw);
  assert.equal(a.envelope.messageId, '<abc@example.com>');
  assert.match(a.raw, /^From: /);
  assert.ok(a.raw.includes('\r\n'));
});

before(() => { /* servers are created per-test to keep state isolated */ });
after(() => { /* nothing global to close */ });

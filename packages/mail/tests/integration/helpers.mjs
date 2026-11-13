// Shared harness for Phase 8 real integration tests. Every server here is a
// genuine protocol server bound to an ephemeral loopback TCP port (smtp-server
// speaks real SMTP; node:http speaks real HTTP). No mocks, no fake providers.
import { SMTPServer } from 'smtp-server';
import http from 'node:http';
import { simpleParser } from 'mailparser';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const certDir = mkdtempSync(join(tmpdir(), 'sveltex-mail-tls-'));
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'),
    '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
} catch (error) {
  throw new Error('A self-signed test certificate could not be generated with openssl (required for real TLS integration tests).', { cause: error });
}
export const TLS_KEY = readFileSync(join(certDir, 'key.pem'));
export const TLS_CERT = readFileSync(join(certDir, 'cert.pem'));
process.on('exit', () => rmSync(certDir, { recursive: true, force: true }));

/** Start a real SMTP server. Returns captured MIME + envelope + session metadata. */
export async function startSmtpServer(options = {}) {
  const captured = [];
  let dataAttempts = 0;
  const authLog = [];
  const rcptRejects = options.rejectRcpt ?? new Set();
  const server = new SMTPServer({
    authOptional: options.authOptional ?? true,
    ...(options.secure !== undefined ? { secure: options.secure } : {}),
    ...(options.key !== undefined ? { key: options.key } : { key: TLS_KEY }),
    ...(options.cert !== undefined ? { cert: options.cert } : { cert: TLS_CERT }),
    ...(options.disabledCommands !== undefined ? { disabledCommands: options.disabledCommands } : {}),
    ...(options.hideSTARTTLS !== undefined ? { hideSTARTTLS: options.hideSTARTTLS } : {}),
    onAuth(auth, _session, callback) {
      authLog.push({ username: auth.username });
      if (options.authValidator) return options.authValidator(auth, callback);
      callback(null, { user: auth.username });
    },
    onMailFrom(_address, _session, callback) {
      if (options.failFirstMailFrom && dataAttempts < options.failFirstMailFrom) {
        dataAttempts += 1;
        return callback(new Error('421 Service temporarily unavailable, try again'));
      }
      callback();
    },
    onRcptTo(address, _session, callback) {
      if (rcptRejects.has(address.address)) return callback(new Error('550 Mailbox unavailable'));
      callback();
    },
    onData(stream, session, callback) {
      dataAttempts += 1;
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        const parsed = await simpleParser(raw).catch(() => ({}));
        captured.push({
          raw: raw.toString('utf8'),
          parsed,
          envelope: {
            from: session.envelope.mailFrom?.address,
            rcpt: session.envelope.rcptTo.map((r) => r.address),
          },
          user: session.user,
          secure: session.secure,
        });
        if (options.failFirstData && captured.length <= options.failFirstData && !options._failed) {
          // Fail at the DATA response boundary so nodemailer surfaces a retryable error.
          callback(new Error('451 Temporary local problem, try again'));
          return;
        }
        callback(null, '250 OK: queued as SVELTEX-IT');
      });
    },
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.server.address().port;
  return {
    server,
    port,
    captured,
    authLog,
    get dataAttempts() { return dataAttempts; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Start a real node:http server that records requests and serves a scripted response. */
export async function startHttpServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      await handler(req, res, body, requests.length);
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    server,
    url: `http://127.0.0.1:${port}/v1/mail/send`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function jsonResponse(res, status, payload, extraHeaders = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(body);
}

export const baseMessage = {
  from: { email: 'noreply@example.com', name: 'SvelteX' },
  to: [{ email: 'alice@example.com', name: 'Alice' }],
  subject: 'Hello from SvelteX',
  text: 'Hello Alice',
};

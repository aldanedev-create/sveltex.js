# @sveltex/mail

Email message contracts with safe template rendering, capped-backoff retries, attachments, a real
RFC 5322/2045 MIME serializer, **real SMTP and HTTP provider adapters**, auth-workflow senders, and
a deterministic in-memory test transport.

## Install

```sh
pnpm add @sveltex/mail
```

`nodemailer` is a runtime dependency of the SMTP adapter. Nothing else is required for the core
contracts, MIME layer, HTTP adapter or test transport.

## Concepts

- **`MailMessage`** — a validated message (`from`, `to`, optional `cc`/`bcc`/`replyTo`/`headers`, `subject`, at least one of `text`/`html`, and optional `attachments`).
- **`MailTransport`** — the contract every provider adapter implements (`send`, `close`, `isClosed`). Three implementations ship: `SmtpTransport`, `HttpTransport`, `TestTransport`.
- **`Mailer`** — validates, freezes, then sends through a transport with capped exponential-backoff retries. A permanent failure throws `MailSendError` (with `cause` and `attempts`); it never reports a false success.
- **`TransportReceipt.delivery`** — provider-reported `accepted`/`rejected`/`response`/`backend` metadata. It never contains credentials.
- **`TestTransport`** (`@sveltex/mail/test-transport`) — a deterministic in-memory transport for tests. It **never sends real email**.

## Minimal example

```ts
import { Mailer } from '@sveltex/mail';
import { TestTransport } from '@sveltex/mail/test-transport';

const transport = new TestTransport(); // swap for SmtpTransport / HttpTransport
const mailer = new Mailer({ transport, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000, factor: 2 } });

const receipt = await mailer.send({
  from: { email: 'noreply@example.com', name: 'SvelteX' },
  to: [{ email: 'alice@example.com' }],
  subject: 'Welcome',
  text: 'Hello Alice',
});
console.log(receipt.messageId, receipt.attempts);
await mailer.close();
```

## Real SMTP adapter

`SmtpTransport` (`@sveltex/mail/smtp`) is a real SMTP client backed by the official
[nodemailer](https://nodemailer.com/) library. It speaks EHLO / AUTH / STARTTLS / implicit TLS /
MAIL FROM / RCPT TO / DATA over a TCP socket.

```ts
import { Mailer } from '@sveltex/mail';
import { SmtpTransport } from '@sveltex/mail/smtp';

const transport = new SmtpTransport({
  host: 'smtp.example.com',
  port: 587,
  secure: false,          // implicit TLS: use true on port 465
  requireTLS: true,       // refuse to send without a successful STARTTLS upgrade
  auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
  // tls: { rejectUnauthorized: true }  // default; do NOT disable in production
});
await transport.verify(); // real connection + AUTH round-trip, without sending mail
const mailer = new Mailer({ transport });
```

- `rejectUnauthorized` defaults to **true**; untrusted/self-signed certificates are rejected.
- `disableFileAccess` and `disableUrlAccess` are always set, so no message field can make nodemailer
  read a local file or fetch a URL.
- Configuration errors throw `MailConfigurationError`; credentials are never placed in error
  messages or `details`.
- `close()` is idempotent and later sends are refused with `MailClosedError`.

## Real HTTP provider adapter

`HttpTransport` (`@sveltex/mail/http`) POSTs a strict versioned JSON envelope via `fetch`. It is
vendor-neutral: any provider that accepts the envelope can be wired in.

```ts
import { HttpTransport } from '@sveltex/mail/http';

const transport = new HttpTransport({
  endpoint: 'https://mail.example.com/v1/send',
  headers: { Authorization: `Bearer ${process.env.MAIL_API_KEY!}` },
  allowedHosts: ['mail.example.com'], // optional SSRF allow-list
  timeoutMs: 10_000,
});
```

Request:

| Property | Value |
| --- | --- |
| `Content-Type` | `application/vnd.sveltex.mail.v1+json` |
| `version` | `1` |
| `envelope` | `{ from, to, messageId }` (BCC included in `to`, never in the raw message) |
| `raw` | complete RFC 5322 message with CRLF line endings |

The provider must answer `2xx` with JSON containing a valid `id` (or `messageId`), bounded to 512
characters. Redirects are **never followed** (`redirect: 'manual'`), response bodies are bounded
before JSON parsing, and provider response bodies/credentials are never reflected into errors.

## MIME serializer

`buildMimeMessage` (`@sveltex/mail/mime`) produces a deterministic, byte-exact RFC 5322 document,
independent of nodemailer. It is used by the HTTP adapter and can be used to build custom adapters.

- CRLF-only line endings; RFC 2047 encoded-words for non-ASCII headers; RFC 2231 / RFC 5987
  percent-encoded filenames.
- `multipart/alternative` for text + HTML, `multipart/mixed` for attachments; distinct boundaries
  even with a deterministic generator.
- Quoted-printable for complex text, base64 for binary attachments.
- BCC is envelope-only: it is **never** serialized into headers.
- `now`, `generateId`, `generateBoundary` are injectable for reproducible output.

## Attachments

```ts
await mailer.send({
  ...message,
  attachments: [
    { filename: 'report.pdf', contentType: 'application/pdf', content: pdfBytes },
    { filename: 'logo.png', contentType: 'image/png', content: base64, encoding: 'base64',
      contentId: 'logo-1', inline: true },
  ],
});
```

`content` is a UTF-8 string, `Uint8Array`, or a padded base64 string (`encoding: 'base64'`).
Filenames are validated against CRLF/NUL/control characters, path separators, colons, and
traversal/leading dots; content types, `contentId`, `inline`, and `encoding` are strictly checked.
Defaults: **20 attachments**, **10 MiB per file**, **25 MiB total** (all overridable via
`MailerOptions` / `ValidateMessageOptions`). Attachments are frozen and byte-copied before send.

## Templates

`renderTemplate` interpolates `{{ path.to.value }}` placeholders. **HTML bodies escape interpolated
values by default** to prevent injection; text/subject are not HTML-escaped. Rendering is strict
about missing variables unless `allowMissing` is set. Rendered subjects pass through the same
validation, so template data cannot inject headers. `sendTemplate` forwards attachments too.

```ts
const tpl = { subject: 'Welcome {{ user.name }}', html: '<p>Hi {{ user.name }}</p>' };
await mailer.sendTemplate(tpl, { from, to, data: { user: { name: '<Alice>' } } });
// html -> <p>Hi &lt;Alice&gt;</p>
```

## Auth workflow integration

`createPasswordResetMailSender` and `createEmailVerificationMailSender` (`@sveltex/mail/auth`)
structurally implement the sender ports used by `@sveltex/auth`'s `PasswordResetService` and
`EmailVerificationService`. They build the link with `URLSearchParams` (token percent-encoded),
validate the endpoint and context, and use real `Mailer.sendTemplate`. No runtime dependency from
`@sveltex/auth` to `@sveltex/mail` is introduced.

```ts
import { createPasswordResetMailSender } from '@sveltex/mail/auth';

const sender = createPasswordResetMailSender({
  mailer, from: { email: 'noreply@example.com' },
  endpoint: 'https://app.example.com/reset', appName: 'Acme',
});
// PasswordResetService accepts `sender` as its PasswordResetSender port.
```

## Retries and deterministic testing

`Mailer` retries with `computeRetryDelay(attempt, policy)`. Both `sleep` and `now` are injectable,
so retry/backoff behavior is testable without real timers:

```ts
const transport = new TestTransport({ failFirst: 2 }); // first two attempts fail
const mailer = new Mailer({ transport, sleep: async () => {}, onError: (e, attempt) => log(attempt) });
const receipt = await mailer.send(message); // attempts === 3
```

`TestTransport.sent` exposes frozen snapshots for assertions. `Mailer.close()` and every transport's
`close()` are idempotent and reject subsequent sends.

## API surface

| Export | Kind |
| --- | --- |
| `Mailer` | class |
| `renderTemplate`, `escapeHtml`, `validateMessage`, `validateAddress`, `validateAttachment`, `attachmentBytes`, `computeRetryDelay`, `DEFAULT_RETRY` | functions / constant |
| `MAX_ATTACHMENTS`, `DEFAULT_MAX_ATTACHMENT_BYTES`, `DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES`, `MAX_ATTACHMENT_*_LENGTH` | limits |
| `MailMessage`, `MailAddress`, `MailAttachment`, `MailDeliveryInfo`, `MailTransport`, `TransportReceipt`, `SendReceipt`, `MailTemplate`, `RenderedMail`, `RenderTemplateOptions`, `RetryPolicy`, `MailerOptions`, `SendTemplateOptions`, `ValidateMessageOptions` | types |
| `MailError`, `MailValidationError`, `MailTemplateError`, `MailTransportError`, `MailSendError`, `MailClosedError`, `MailConfigurationError` | errors |
| `TestTransport`, `TestTransportOptions`, `SentMail` (`@sveltex/mail/test-transport`) | test transport |
| `buildMimeMessage`, `MimeEnvelope`, `MimeDocument`, `BuildMimeOptions` (`@sveltex/mail/mime`) | MIME serializer |
| `SmtpTransport`, `toNodemailerMessage`, `SmtpCredentials`, `SmtpTlsOptions`, `SmtpTransportOptions` (`@sveltex/mail/smtp`) | SMTP adapter |
| `HttpTransport`, `buildHttpPayload`, `MAIL_HTTP_ENVELOPE_VERSION`, `MAIL_HTTP_CONTENT_TYPE`, `HttpTransportOptions`, `HttpMailPayload` (`@sveltex/mail/http`) | HTTP adapter |
| `createPasswordResetMailSender`, `createEmailVerificationMailSender`, `AuthMailSender`, `AuthMailContext`, `AuthMailSenderOptions`, `TemplateMailer` (`@sveltex/mail/auth`) | auth senders |

## Security notes (SEC-072 … SEC-081)

- Header injection (CRLF/NUL/control) is rejected in addresses, names, subjects, headers, attachment filenames and content types.
- Custom headers cannot shadow structural headers (`Bcc`, `From`, `Content-Type`, `MIME-Version`, …) — prevents BCC leaks and MIME smuggling.
- Attachment count/size caps bound memory; base64 content is strictly validated before decoding.
- BCC is envelope-only across all serializers; the frozen message detaches caller-owned byte buffers.
- SMTP credentials never leak into errors; TLS verification is on by default; file/URL access disabled.
- HTTP endpoints reject non-http(s) schemes, embedded credentials, fragments, control characters and hosts outside `allowedHosts`; hop-by-hop headers are forbidden; redirects are not followed.
- Auth links percent-encode tokens; hostile tokens cannot inject query parameters or break HTML attributes; HTML escaping is on by default.

## Limitations and production notes

- Retries are in-process and best-effort. A process crash after provider acceptance but before returning a receipt can cause a duplicate send; use provider idempotency keys for exactly-once semantics.
- No DKIM/SPF signing, bounce handling, delivery tracking, templating service, or queue persistence is provided — those belong to the provider/adapter layer.
- The HTTP adapter requires a provider that accepts the documented v1 envelope; it is not tied to any specific vendor.
- SMTP delivery metadata is whatever the server reports (`accepted`, `rejected`, `response`); it is not a delivery confirmation.

## Status

Verified with 70 runtime/security unit tests, 24 real integration tests (real SMTP server with
AUTH/STARTTLS/TLS/attachments/MIME parsing, real HTTP server, real `@sveltex/auth` workflows) and
public-API type tests. No skipped tests. See `docs/completion/phase-8-mail.md`.

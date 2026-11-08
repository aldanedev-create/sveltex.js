# @sveltex/mail

Email message contracts with safe template rendering, capped-backoff retries, and a deterministic in-memory test transport.

## Install

```sh
pnpm add @sveltex/mail
```

## Concepts

- **`MailMessage`** — a validated message (`from`, `to`, optional `cc`/`bcc`/`replyTo`/`headers`, `subject`, and at least one of `text`/`html`).
- **`MailTransport`** — the contract any provider adapter implements (`send`, `close`, `isClosed`).
- **`Mailer`** — validates, then sends through a transport with capped exponential-backoff retries. A permanent failure throws `MailSendError` (with `cause` and `attempts`); it never reports a false success.
- **`TestTransport`** (`@sveltex/mail/test-transport`) — a real, deterministic in-memory transport that records every accepted message and can inject transient/permanent failures. It **never sends real email**.

## Minimal example

```ts
import { Mailer } from '@sveltex/mail';
import { TestTransport } from '@sveltex/mail/test-transport';

const transport = new TestTransport(); // swap for an SMTP/HTTP adapter implementing MailTransport
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

## Templates

`renderTemplate` interpolates `{{ path.to.value }}` placeholders. **HTML bodies escape interpolated values by default** to prevent injection; text/subject are not HTML-escaped. Rendering is strict about missing variables unless `allowMissing` is set.

```ts
const tpl = { subject: 'Welcome {{ user.name }}', html: '<p>Hi {{ user.name }}</p>' };
await mailer.sendTemplate(tpl, { from, to, data: { user: { name: '<Alice>' } } });
// html -> <p>Hi &lt;Alice&gt;</p>
```

Rendered subjects pass through the same validation, so template data cannot inject headers.

## Retries and deterministic testing

`Mailer` retries with `computeRetryDelay(attempt, policy)`. Both `sleep` and `now` are injectable, so retry/backoff behavior is testable without real timers:

```ts
const transport = new TestTransport({ failFirst: 2 }); // first two attempts fail
const mailer = new Mailer({ transport, sleep: async () => {}, onError: (e, attempt) => log(attempt) });
const receipt = await mailer.send(message); // attempts === 3
```

`TestTransport.sent` exposes frozen snapshots for assertions. `Mailer.close()` and `TestTransport.close()` are idempotent and reject subsequent sends.

## API surface

| Export | Kind |
| --- | --- |
| `Mailer` | class |
| `renderTemplate`, `escapeHtml`, `validateMessage`, `validateAddress`, `computeRetryDelay`, `DEFAULT_RETRY` | functions / constant |
| `MailMessage`, `MailAddress`, `MailTransport`, `TransportReceipt`, `SendReceipt`, `MailTemplate`, `RenderedMail`, `RenderTemplateOptions`, `RetryPolicy`, `MailerOptions`, `SendTemplateOptions`, `ValidateMessageOptions` | types |
| `MailError`, `MailValidationError`, `MailTemplateError`, `MailTransportError`, `MailSendError`, `MailClosedError` | errors |
| `TestTransport`, `TestTransportOptions`, `SentMail` (`@sveltex/mail/test-transport`) | test transport |

## Security notes

- CRLF/NUL header injection is rejected in addresses, names, subjects, and headers.
- Recipient counts, header counts, and body sizes are bounded.
- The message passed to the transport is frozen, so a caller cannot mutate it after send.
- HTML template interpolation is escaped by default; disabling it is an explicit, opt-in choice.

## Limitations and production notes

- **No SMTP/HTTP provider adapter is shipped.** `TestTransport` is for tests only; it does not send email and is not advertised as a provider. For production, implement `MailTransport` with your provider (SES, Postmark, SMTP, ...).
- Retries are in-process and best-effort. A process crash after provider acceptance but before returning a receipt can cause a duplicate send; use provider idempotency keys for exactly-once semantics.
- No DKIM/SPF, bounce handling, or delivery tracking is provided — those belong to the provider/adapter layer.

## Status

Verified with runtime, security, and public-API type tests. No live external service is required.

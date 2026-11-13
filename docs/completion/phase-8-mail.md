# Phase 8 — Mail completion report

**Status:** implemented, tested against a real SMTP server (AUTH / STARTTLS / implicit TLS / MIME
parsing), a real HTTP server, and real `@sveltex/auth` workflows; documented. Phase 8 done;
Phases 9–12 remain.

**Measured full-monorepo gate:** `pnpm check` → **871/871** runtime (0 failures, 0 skipped,
16 test projects), `pnpm test:security` → **160/160** (16 packages), `pnpm test:types` →
**16/16**, `pnpm --filter @sveltex/mail test:integration` → **24/24** (real SMTP/HTTP/auth),
`pnpm --filter @sveltex/jobs test:integration` → **17/17**, `pnpm --filter @sveltex/storage
test:integration` → **9/9** (live MinIO), `npm pack --dry-run` → `@sveltex/mail` **0.1.0,
27 files**, all exit 0 with live PostgreSQL 16 / MySQL 8.0 / Redis 7 / MinIO services.

## Objective

Per [`docs/completion-plan.md`](../completion-plan.md) Phase 8, close every gap the Phase 0 audit
recorded for `@sveltex/mail` **without creating a new package**. The Phase 0 table read:

> Message contract, HTML/text, templates, retries, test transport ✅ (`./test-transport`);
> **SMTP integration, attachments, provider adapter** ✗ — README: "no SMTP/HTTP provider".

Core rule honored: **finish what SvelteX already promises before making SvelteX promise more.**
No placeholder package, no fake provider, no skipped test. The pre-existing contracts, template
renderer, retrying `Mailer` and `TestTransport` were preserved unchanged in semantics and extended,
not replaced.

## Gap → delivery

| Gap / requirement | Delivered | Reality |
| --- | :---: | --- |
| SMTP integration | ✅ | `SmtpTransport` (`@sveltex/mail/smtp`) on official `nodemailer` 7. Real EHLO / AUTH / STARTTLS / implicit TLS / MAIL FROM / RCPT TO / DATA over TCP; `verify()` performs a real connection+AUTH round-trip. |
| Provider adapter interface | ✅ | `HttpTransport` (`@sveltex/mail/http`) POSTs a strict `application/vnd.sveltex.mail.v1+json` envelope via real `fetch`. Vendor-neutral; the `MailTransport` contract remains the single seam. |
| HTML email support | ✅ | Pre-existing `html` body + `multipart/alternative` MIME; preserved and now serialized on the wire. |
| Plain-text email support | ✅ | Pre-existing `text` body; preserved and now serialized with quoted-printable when needed. |
| Templates | ✅ | Pre-existing `renderTemplate` (`{{ path }}`, HTML escaping by default, strict missing variables); `sendTemplate` now forwards attachments. |
| Attachments | ✅ | `MailAttachment`, `validateAttachment`, `attachmentBytes`. UTF-8 / `Uint8Array` / padded base64 content; CRLF/NUL/control/path/colon/traversal filename rejection; strict MIME type, `contentId`, `inline`, `encoding` checks. Default caps: 20 files, 10 MiB each, 25 MiB total, all overridable. Bytes are frozen and copied before send. |
| Retry behavior | ✅ | Pre-existing capped exponential backoff with injectable `sleep`/`now`; `MailSendError` carries `attempts` and `cause`, never a false success. Verified against real transient SMTP failures. |
| Delivery metadata | ✅ | `MailDeliveryInfo` on `TransportReceipt.delivery`: `accepted`, `rejected`, `response`, `backend` (`smtp`/`http`/`test`), optional envelope from/to. Credentials never included. |
| Error handling | ✅ | `MailConfigurationError` added for invalid transport config; `MailTransportError` wraps provider failures with `operation`/`backend` details; `MailClosedError` guards lifecycle. No credential or provider-body leakage. |
| Authentication workflow integration | ✅ | `createPasswordResetMailSender` / `createEmailVerificationMailSender` (`@sveltex/mail/auth`) structurally implement the `@sveltex/auth` sender ports with a real `Mailer`; tokens are percent-encoded into the link via `URLSearchParams`. |
| Test transport | ✅ | `TestTransport` retained for deterministic tests and explicitly not advertised as a provider. |
| MIME serialization (enabler) | ✅ | `buildMimeMessage` (`@sveltex/mail/mime`): real RFC 5322/2045 serializer, CRLF-only, RFC 2047 encoded-word headers, RFC 2231 filenames, `multipart/alternative` + `multipart/mixed`, quoted-printable text, base64 attachments, BCC envelope-only, injectable clock/id/boundary. |

## What Phase 8 added

| Area | File | Content |
| --- | --- | --- |
| Core contracts | `packages/mail/src/index.ts` (extended) | `MailAttachment`, `MailDeliveryInfo`, `TransportReceipt.delivery`, `MailConfigurationError`, `attachmentBytes`, `validateAttachment`, size/count constants, `RESERVED_HEADERS` guard, attachment caps in `validateMessage`/`MailerOptions`/`SendTemplateOptions`, frozen byte copies in `freezeMessage`. |
| MIME serializer | `packages/mail/src/mime.ts` (new) | `buildMimeMessage`, `MimeEnvelope`, `MimeDocument`, `BuildMimeOptions`. CRLF-only output, RFC 2047/2231, QP/base64, distinct multipart boundaries even with a constant generator. |
| SMTP adapter | `packages/mail/src/smtp.ts` (new) | `SmtpTransport`, `toNodemailerMessage`, `SmtpCredentials`, `SmtpTlsOptions`, `SmtpTransportOptions`. Strict config validation, `rejectUnauthorized: true` default, `disableFileAccess`/`disableUrlAccess`, `verify()`, delivery metadata, idempotent `close()`. |
| HTTP adapter | `packages/mail/src/http.ts` (new) | `HttpTransport`, `buildHttpPayload`, `MAIL_HTTP_ENVELOPE_VERSION`, `MAIL_HTTP_CONTENT_TYPE`, `HttpTransportOptions`, `HttpMailPayload`. Endpoint/userinfo/fragment/allowedHosts SSRF guards, forbidden hop-by-hop headers, `redirect: 'manual'`, `AbortSignal.timeout`, bounded response body, required provider message id. |
| Auth senders | `packages/mail/src/auth.ts` (new) | `createPasswordResetMailSender`, `createEmailVerificationMailSender`, `TemplateMailer`, `AuthMailContext`, `AuthMailSender`, `AuthMailSenderOptions`. Default escaped templates, endpoint/context validation, link building. |
| Package exports | `packages/mail/package.json` | New `./mime`, `./smtp`, `./http`, `./auth` subpaths; `nodemailer` runtime dependency; `test:integration` script; SMTP/HTTP/MIME test dev dependencies. Version stays `0.1.0`. |
| Unit tests | `packages/mail/tests/attachments.test.mjs`, `mime.test.mjs`, `transports.test.mjs` (new) | 10 + 11 + 13 cases: attachment validation/decoding/caps/freezing/forwarding, deterministic MIME output, RFC 2047/2231, QP round-trip, nodemailer mapping, SMTP/HTTP config validation, auth link construction. |
| Security tests | `packages/mail/tests/security/security.test.mjs` (extended) | +10 cases (SEC-072 – SEC-081) on top of the 9 pre-existing; package total 19. |
| Integration tests | `packages/mail/tests/integration/{helpers,smtp,http,auth}.test.mjs` (new) | 24 real cases, 0 skipped. Runtime-generated self-signed TLS cert (never committed), real `smtp-server`, `node:http`, `mailparser`, and real `@sveltex/auth` services. |
| Type tests | `packages/mail/tests/types/public-api.test.ts` (extended) | All new exports, four subpath modules, negative `@ts-expect-error` cases. |
| CI | `.github/workflows/ci.yml` | Mandatory `pnpm --filter @sveltex/mail test:integration` step. |
| CLI registry truthfulness | `packages/cli/src/integrations/registry.ts`, `packages/cli/tests/unit/core.test.mjs` | Corrected `configHint`/`adapters` for realtime, jobs, storage and mail that denied shipped adapters; added a real test asserting every advertised adapter resolves to an actual package subpath export. No new integration or feature. |
| Package docs | `packages/mail/README.md`, `CHANGELOG.md` | Rewritten with SMTP/HTTP/MIME/attachments/auth usage, security notes and honest limitations. |

## Architecture notes

- **One transport seam, three real backends.** `MailTransport` (`send` / `close` / `isClosed`)
  is unchanged. `SmtpTransport`, `HttpTransport` and `TestTransport` all implement it; `Mailer`
  validates and retries identically regardless of backend.
- **Two independent composers.** The SMTP adapter uses nodemailer's own MIME composer;
  the HTTP adapter uses SvelteX's `buildMimeMessage` so the `raw` field is byte-exact,
  deterministic and independently testable. Both consume the same validated `MailMessage`.
- **BCC is envelope-only.** BCC recipients go into the SMTP envelope and the HTTP `envelope.to`,
  but are never serialized into MIME headers. Verified on the real SMTP wire and in the raw MIME.
- **Defense in depth on headers.** `validateMessage` rejects CRLF/NUL injection everywhere and
  refuses custom headers that shadow structural ones (`Bcc`, `Content-Type`, `MIME-Version`, …),
  so MIME/BCC smuggling is blocked at the boundary.
- **Boundaries are always unique.** Nested `multipart/alternative` + `multipart/mixed` mix in a
  per-call counter, so a deterministic (constant) boundary generator still produces valid MIME.
- **Credentials never travel into errors.** Config validation, `MailTransportError.details` and
  HTTP response handling all avoid credentials and provider bodies; headers with `Authorization`
  are validated but never logged.
- **Auth integration is structural, not a dependency inversion.** `@sveltex/mail/auth` depends
  only on mail's own types; `@sveltex/auth` is a devDependency used only in integration tests.
  No runtime edge auth → mail is introduced.
- **CLI registry is now honest about shipped adapters.** `sveltex add`/`info` no longer print
  "No SMTP/HTTP provider is shipped" (or the equivalent S3/WS/SSE denials). A consistency test
  resolves every advertised adapter against the package's real `exports` map. Phase 12 still owns
  blueprints, generators and addon extensibility.

## Test inventory

| Gate | Result |
| --- | --- |
| `pnpm check` | **871/871** runtime, 0 failures, 0 skipped, 16 test projects |
| `pnpm test:security` | **160/160**, 16 packages, 0 failures, 0 skipped |
| `pnpm test:types` | **16/16** |
| `pnpm --filter @sveltex/mail test` | **70/70** (51 unit + 19 security) + public-API type test |
| `pnpm --filter @sveltex/mail test:integration` | **24/24** — 10 SMTP + 9 HTTP + 5 auth, real servers, 0 skipped |
| `pnpm --filter @sveltex/jobs test:integration` | **17/17** (no regression) |
| `pnpm --filter @sveltex/storage test:integration` | **9/9** (no regression, live MinIO) |
| `npm pack --dry-run --json` | `@sveltex/mail` 0.1.0, 27 files |

**Phase 7 → Phase 8 delta:** +45 runtime (44 mail + 1 CLI registry consistency), +10 security,
+24 real integration tests. No test skipped, no fake provider substituted.

## XERJ

XERJ was used for repository research throughout Phase 8 (HTTP search on the `ax-docs` index for
`mail SMTP transport MailTransport`, the `docs/completion-plan.md` Phase 8 requirements, the
`docs/completion/phase-0-audit.md` gap table, the specification/audit inventory, and — via the
consistency work above — the CLI integration registry). Final `--fresh` rebuild: **473 files /
2812 records live / 28 duplicate aliases / 0 junk records / 0 junk or skipped files**; `ax-docs`
2797 docs, `ax-packages-cli` 15 docs, graph 1836 edges, `xerj-done ok=true exit=0
reason=completed`. The same numbers are recorded in [`docs/audit/README.md`](../audit/README.md).

## Docs synced

- `docs/completion-plan.md` — all 18 Phase 8 tasks/tests checked, delivery note added.
- `docs/completion/phase-0-audit.md` — Phase 8 gap table replaced with completion table; criteria/bottom line updated.
- `docs/completion/phase-8-mail.md` — this report (new).
- `docs/audit/README.md` — totals updated to 871 / 160 / 16; current focus updated to Phase 9.
- `docs/audit/package-status.md` — mail section and totals updated; stale "no SMTP/HTTP adapter" claims removed.
- `docs/audit/testing-status.md` — mail row, known-gap #6 and totals updated.
- `docs/audit/security-findings.md` — SEC-020 row refreshed, SEC-072 – SEC-081 Phase 8 review added.
- `docs/audit/repository-audit.md` — mail row and totals updated.
- `docs/audit/progress.md` — Session 15 added.
- `docs/specification.md` — mail rows, Stage 4/5 baselines and totals updated.
- `docs/packages/README.md` — mail row and totals updated.
- `docs/roadmap.md` — Phase 8 delivery noted; stale denials removed.
- `README.md` (root) — totals and Phase 8 description updated.
- `docs/manifest.json` — document count (43), Phase 8 report registered, note updated.
- `packages/mail/README.md`, `packages/mail/CHANGELOG.md` — rewritten / Phase 8 entry.
- `packages/cli/src/integrations/registry.ts` + `tests/unit/core.test.mjs` — truthfulness fix.

## Not claimed

- No DKIM/SPF/DMARC signing, bounce/complaint handling, delivery tracking, template service or
  queue persistence — those belong to the provider/adapter layer.
- The HTTP adapter is vendor-neutral: it requires a provider that accepts the documented v1
  envelope; no specific hosted email vendor is integrated or advertised.
- SMTP `delivery` reflects what the server reported (`accepted`/`rejected`/`response`); it is not
  a final delivery confirmation.
- Retries remain in-process and best-effort; provider idempotency keys are still required for
  exactly-once semantics.
- No SvelteKit `handle` wiring (Phase 10), no published-registry consumer install test (Phase 11),
  no blueprints/generators/addon extensibility (Phase 12).
- Package version stays `0.1.0` (bump deferred to Phase 11 release audit).

## Next

Phase 9 (`@sveltex/validation` / `@sveltex/testing`) per the plan. Phases 9–12 remain.

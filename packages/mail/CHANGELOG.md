# Changelog

## 0.1.0

- Initial independently installable SvelteX package.
- Phase 8 completion (still `0.1.0` — no version bump until the Phase 11 release audit):
  - Attachments with strict filename/MIME/content validation, count and byte caps, and frozen byte copies.
  - Provider delivery metadata (`MailDeliveryInfo`) and a dedicated `MailConfigurationError`.
  - Real RFC 5322/2045 MIME serializer (`@sveltex/mail/mime`) with CRLF-only output, RFC 2047 headers, RFC 2231 filenames, multipart/alternative and multipart/mixed.
  - Real SMTP adapter (`@sveltex/mail/smtp`) on official nodemailer, with AUTH, STARTTLS, implicit TLS and `rejectUnauthorized: true` by default.
  - Real HTTP provider adapter (`@sveltex/mail/http`) with the `application/vnd.sveltex.mail.v1+json` envelope, SSRF guards, manual redirects and bounded responses.
  - Auth workflow senders (`@sveltex/mail/auth`) for password reset and email verification.
  - Reserved-header rejection to prevent BCC/MIME header smuggling; SEC-072 … SEC-081 security review.
  - Real SMTP/HTTP/auth integration tests; `TestTransport` retained for deterministic tests.

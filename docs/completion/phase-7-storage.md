# Phase 7 — Storage completion report

**Status:** implemented, tested against a real S3-compatible object store (MinIO, official AWS
SDK v3 client), documented. Phase 7 done; Phases 8–12 remain.

**Measured full-monorepo gate:** `pnpm check` → **826/826** runtime (0 failures, 0 skipped,
16 test projects), `pnpm test:security` → **150/150** (16 packages), `pnpm test:types` →
**16/16**, `pnpm --filter @sveltex/storage test:integration` → **9/9** against live MinIO,
`pnpm --filter @sveltex/jobs test:integration` → **17/17** (Redis 7 + SQLite + PostgreSQL 16),
`npm pack --dry-run` → `@sveltex/storage` **0.1.0, 15 files**, all exit 0 with live
PostgreSQL 16 / MySQL 8.0 / Redis 7 / MinIO services.

## Objective

Per [`docs/completion-plan.md`](../completion-plan.md) Phase 7, close every gap the Phase 0 audit
recorded for `@sveltex/storage` **without creating a new package**. The Phase 0 table read:

> `StorageDriver` + `LocalStorageDriver` (real fs I/O) ✅ (24 tests);
> **No S3/object-store adapter; not a distributed store; no URL signing** ✗.

Core rule honored: **finish what SvelteX already promises before making SvelteX promise more.**
No placeholder package, no fake provider, no skipped test. The pre-existing local driver,
validation facade, runtime/security/type tests were preserved unchanged in semantics.

## Gap → delivery

| Gap / requirement | Delivered | Reality |
| --- | :---: | --- |
| S3-compatible storage adapter | ✅ | `S3StorageDriver` (`@sveltex/storage/s3`) built on the official `@aws-sdk/client-s3`. Real `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, paginated `ListObjectsV2`. Works with AWS S3 and S3-compatible services via `endpoint` + `forcePathStyle`. |
| Presigned URLs | ✅ | `Storage.presignGet` / `Storage.presignPut` backed by `@aws-sdk/s3-request-presigner` SigV4 query signing. TTL bounded to 1..604800 s (default 900). PUT signs the exact `content-type`; custom metadata is hoisted into the signed URL. Verified end-to-end with credential-free `fetch` against MinIO. |
| File uploads / downloads | ✅ | Existing `Storage.put`/`get` facade preserved; S3 driver adds a real object-store backend. |
| Streaming | ✅ | `GetObject` is streamed into a Web `ReadableStream<Uint8Array>` — downloads are never fully buffered by the driver. Uploads accept `AsyncIterable`/Web streams and are buffered once, bounded by `maxUploadBytes` (64 MiB) and the facade's `maxObjectSizeBytes` (16 MiB). |
| File metadata | ✅ | SHA-256 `etag`, creation time, content type and custom metadata stored as S3 user metadata (`x-amz-meta-sveltex-sha256`, `x-amz-meta-sveltex-created-at`); strict parsing on read rejects corrupt values. |
| Content-type validation | ✅ | `normalizeContentType` (existing) enforced on every put and presign PUT; CRLF/header injection rejected. |
| File-size limits | ✅ | `maxObjectSizeBytes` enforced while streaming by the facade; S3 driver adds its own `maxUploadBytes` cap. |
| Safe path handling | ✅ | `validateKey` (existing) rejects traversal, absolute paths, backslashes, control characters and overlong segments; S3 keys are namespaced under `keyPrefix` and never used to build filesystem paths. |
| Storage lifecycle / errors | ✅ | `StorageIOError` wraps every SDK failure with `operation`, `backend: 's3'` and the original `cause`; a missing **bucket** is a hard error, never mistaken for a missing object. `close()` destroys an owned client and rejects later operations. |
| Adapter behavior / storage failures | ✅ | 9 real MinIO integration cases: round-trip, streaming, listing, deletion, presigned GET/PUT (tamper, expiry, content-type enforcement), traversal, size limits, missing-bucket diagnostics, persistence across driver instances. |
| Explicit capability, no silent fallback | ✅ | `PresigningStorageDriver` is an optional capability. Drivers without it make presign methods throw `StorageUnsupportedError` instead of silently returning an unusable URL. |

## What Phase 7 added

| Area | File | Content |
| --- | --- | --- |
| S3 driver | `packages/storage/src/s3.ts` (new) | `S3StorageDriver`, `S3StorageDriverOptions`, `S3StorageCredentials`. Config validation (bucket, region, endpoint without embedded credentials/query/fragment, static credentials, BYO `client`, `keyPrefix`, `maxUploadBytes`). Real SDK commands, user-metadata encode/decode, SigV4 presign, `StorageIOError` wrapping, owned-client lifecycle. |
| Presign contracts | `packages/storage/src/index.ts` (extended) | `PresignOptions`, `ResolvedPresignOptions`, `PresignedRequest`, `PresigningStorageDriver`, `resolvePresignOptions`, TTL constants, `Storage.presignGet`/`presignPut`, `#requirePresigning()`, `StorageUnsupportedError`. |
| Metadata hardening | `packages/storage/src/index.ts` (extended) | `normalizeCustom` now rejects `__proto__` / `constructor` / `prototype`; the S3 driver rejects the reserved `sveltex-*` namespace so integrity metadata cannot be forged. |
| Package exports | `packages/storage/package.json` | New `./s3` subpath export, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` real dependencies, `test:integration` script. Version stays `0.1.0`. |
| Unit tests | `packages/storage/tests/s3.test.mjs` (new) | 11 local tests: config validation, keyPrefix, presign URL structure, signed content-type, metadata in URL, TTL bounds, unsupported driver, reserved/prototype keys, traversal, closed lifecycle. |
| Security tests | `packages/storage/tests/security/phase7-security.test.mjs` (new) | 9 cases (SEC-7-1 – SEC-7-9): secret leakage, TTL bounds, key traversal, header injection, prototype pollution, endpoint credential injection, reserved metadata, closed driver, explicit capability. |
| Integration tests | `packages/storage/tests/integration/s3.test.mjs` (new) | 9 real MinIO cases; an independent AWS SDK client proves objects really exist in the object store. Never skipped. |
| Type tests | `packages/storage/tests/types/public-api.test.ts` (extended) | Public API types for presign contracts and the S3 subpath export. |
| CI | `.github/workflows/ci.yml` | MinIO service started as an explicit step (image requires `server /data`), S3 env vars, mandatory `pnpm --filter @sveltex/storage test:integration`. |
| Package docs | `packages/storage/README.md`, `CHANGELOG.md` | Rewritten with S3 usage, presigned URL examples, honest limitations and Phase 7 entry. |

## Architecture notes

- **Backend-neutral facade.** `Storage` still validates keys, MIME types, custom metadata, size
  and TTL before any I/O; the S3 driver is just another `StorageDriver` implementation.
- **Integrity metadata.** Objects written through `Storage.put` carry a SHA-256 etag and creation
  timestamp as S3 user metadata. Objects uploaded directly through a presigned PUT are still
  readable, but honestly expose the **service ETag** and service `LastModified` — the driver
  cannot hash bytes it never received.
- **Metadata key normalization.** S3 lower-cases user metadata keys; collisions after
  lower-casing are rejected, and the returned `custom` map always uses the stored lower-case keys.
- **Presign security.** `assertPresignedUrl` rejects non-HTTP(S) URLs, embedded userinfo,
  unsigned URLs and any URL containing the configured secret access key. PUT signatures include
  `content-type;host`, so changing the content type invalidates the request (verified 403).
- **Not-found semantics.** Only `NoSuchKey` / `NotFound` mean "object missing". `NoSuchBucket`
  is surfaced as a diagnostic `StorageIOError`, not swallowed as `undefined`.

## Test inventory

| Gate | Result |
| --- | --- |
| `pnpm check` | **826/826** runtime, 0 failures, 0 skipped, 16 test projects |
| `pnpm test:security` | **150/150**, 16 packages, 0 failures, 0 skipped |
| `pnpm test:types` | **16/16** |
| `pnpm --filter @sveltex/storage test` | **44/44** (runtime + security) + public-API type test |
| `pnpm --filter @sveltex/storage test:integration` | **9/9** real MinIO (S3) |
| `pnpm --filter @sveltex/jobs test:integration` | **17/17** real Redis 7 / SQLite / PostgreSQL 16 |
| `npm pack --dry-run --json` | `@sveltex/storage` 0.1.0, 15 files |

## XERJ

XERJ was used for repository research throughout Phase 7 (HTTP search on the `ax-docs` index for
`storage S3 presigned adapter`, `docs/completion-plan.md` Phase 7 requirements, and the
specification/audit inventory). The final `--fresh` rebuild measured **460 files / 2677 records
live / 29 duplicate aliases / 0 junk records / 0 junk/skipped files**; `ax-docs` **2662 docs**,
`ax-packages-cli` **15 docs**, graph **1721 edges**, `xerj-done ok=true exit=0 reason=completed`.
The numbers are also recorded in [`docs/audit/README.md`](../audit/README.md).

## Docs synced

- `docs/completion-plan.md` — Phase 7 tasks and tests checked, delivery note added.
- `docs/completion/phase-0-audit.md` — Phase 7 gap table replaced with completion table.
- `docs/audit/README.md` — totals updated to 826 / 150 / 16; current focus updated to Phase 8.
- `docs/audit/package-status.md` — storage row and totals updated.
- `docs/audit/testing-status.md` — storage row, integration row and totals updated.
- `docs/audit/security-findings.md` — SEC-063 – SEC-071 added.
- `docs/audit/repository-audit.md` — storage tree line and package row updated.
- `docs/audit/progress.md` — Session 14 added.
- `docs/specification.md` — storage rows and totals updated.
- `docs/packages/README.md` — storage row and totals updated.
- `docs/roadmap.md` — Phase 7 delivery noted.
- `README.md` (root) — totals and Phase 7 description updated.
- `docs/manifest.json` — document count and status updated.
- `packages/storage/README.md`, `packages/storage/CHANGELOG.md` — rewritten / Phase 7 entry.

## Not claimed

- No multipart uploads, bucket creation, versioning, object locking, server-side encryption
  configuration, replication, CDN integration or virus scanning.
- No S3-side `ChecksumSHA256` assertion (integrity is a SvelteX-computed SHA-256 in user
  metadata, not a service-side checksum verification).
- No `list()` optimization for very large buckets (one `HeadObject` per key).
- No authentication-workflow wiring (Phase 8 mail integration / Phase 10 cross-package).
- Package version stays `0.1.0` (bump deferred to Phase 11 release audit).

## Next

Phase 8 (`@sveltex/mail`) per the plan. Phases 8–12 remain.

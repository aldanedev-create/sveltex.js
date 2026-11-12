# Changelog

## 0.1.0

- Initial independently installable SvelteX package.
- Completion-plan Phase 7 (`@sveltex/storage`):
  - Added `S3StorageDriver` (`@sveltex/storage/s3`) built on the official AWS SDK v3:
    real `PutObject`, streaming `GetObject`, `HeadObject`, `DeleteObject` and paginated
    `ListObjectsV2` against AWS S3 and S3-compatible services (MinIO, Ceph, LocalStack).
  - Added `presignGet` / `presignPut` SigV4 presigned URLs via
    `@aws-sdk/s3-request-presigner`, with bounded TTL (1..604800 s), signed `content-type`,
    custom metadata embedded in the signed URL, and a guard against leaking the secret key.
  - Extended the facade with `PresignOptions`, `ResolvedPresignOptions`, `PresignedRequest`,
    `PresigningStorageDriver`, `resolvePresignOptions`, TTL constants and
    `StorageUnsupportedError`. Unsupported drivers fail explicitly, never silently.
  - Hardened `normalizeCustom` against prototype-polluting metadata keys; rejected the reserved
    `sveltex-*` metadata namespace so integrity metadata cannot be forged.
  - Preserved SHA-256 `etag`, creation time and custom metadata as S3 user metadata, with strict
    parsing on read; objects written outside `Storage.put` honestly expose the service ETag.
  - Added real MinIO integration tests (9), S3 unit tests, Phase 7 security tests
    (SEC-7-1 – SEC-7-9) and public-API type tests; CI now starts MinIO and runs the integration
    suite without skipping.

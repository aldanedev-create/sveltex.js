# @sveltex/storage

Object storage contracts with safe upload metadata, true streaming downloads, a real
local-filesystem driver, and a real S3 / S3-compatible driver with SigV4 presigned URLs.

## Install

```sh
pnpm add @sveltex/storage
```

`@sveltex/storage/s3` uses the official AWS SDK v3 (`@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner`) and works against AWS S3 as well as S3-compatible services
(MinIO, Ceph, LocalStack, ...). No cloud account or network access is needed to use
`@sveltex/storage/local`.

## Concepts

- **`StorageDriver`** — the backend contract (`put`, `get`, `head`, `delete`, `list`, `close`).
- **`LocalStorageDriver`** (`@sveltex/storage/local`) — writes content and metadata sidecars
  atomically to a local directory. Development / single-node only.
- **`S3StorageDriver`** (`@sveltex/storage/s3`) — real S3 driver: `PutObject`, `GetObject`,
  `HeadObject`, `DeleteObject`, paginated `ListObjectsV2`, plus `presignGet`/`presignPut`.
- **`PresigningStorageDriver`** — optional capability for time-limited direct-to-storage URLs.
  Drivers without it make `Storage.presignGet`/`presignPut` throw `StorageUnsupportedError`.
- **`Storage`** — the driver-neutral facade that validates keys, MIME types, custom metadata,
  presign TTLs and maximum object size **before** delegating I/O.

## Minimal example (local)

```ts
import { Storage, collectStream } from '@sveltex/storage';
import { LocalStorageDriver } from '@sveltex/storage/local';

const storage = new Storage({
  driver: new LocalStorageDriver({ root: './.storage' }),
  maxObjectSizeBytes: 8 * 1024 * 1024,
});

const meta = await storage.put('avatars/user-1.png', pngBytes, {
  contentType: 'image/png',
  custom: { owner: 'user-1' },
});
// meta.etag is the SHA-256 of the stored bytes.

const object = await storage.get('avatars/user-1.png');
if (object) {
  const bytes = await collectStream(object.body); // Web ReadableStream, streamed not buffered
}
await storage.close();
```

## S3 example

```ts
import { Storage } from '@sveltex/storage';
import { S3StorageDriver } from '@sveltex/storage/s3';

const driver = new S3StorageDriver({
  bucket: 'my-bucket',
  region: 'us-east-1',
  // endpoint / forcePathStyle for S3-compatible services:
  endpoint: 'http://127.0.0.1:9000',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_KEY, secretAccessKey: process.env.AWS_SECRET },
  keyPrefix: 'uploads/', // optional namespace inside the bucket
});
const storage = new Storage({ driver });

await storage.put('docs/report.pdf', pdfBytes, { contentType: 'application/pdf' });

// Direct browser upload/download without proxying bytes through the app:
const upload = await storage.presignPut('docs/report.pdf', {
  expiresInSeconds: 300,
  contentType: 'application/pdf',
  custom: { owner: 'user-1' },
});
// Send upload.headers verbatim with a PUT to upload.url.
const download = await storage.presignGet('docs/report.pdf', { expiresInSeconds: 300 });
await storage.close();
```

Bodies accept `Uint8Array`, `string`, a Web `ReadableStream<Uint8Array>`, or any
`AsyncIterable<Uint8Array>`. `get` always returns a Web `ReadableStream<Uint8Array>`;
the S3 driver streams `GetObject` directly, so downloads are never fully buffered by the driver.
The S3 driver buffers a single upload in memory before one `PutObject` (bounded by
`maxUploadBytes`, default 64 MiB, and by the facade's `maxObjectSizeBytes`, default 16 MiB).

## Safe upload metadata

- **Keys**: `validateKey` rejects traversal (`..`), absolute paths, backslashes, control
  characters, empty segments, and overlong names. Local keys are mapped to **SHA-256 hex
  filenames**; S3 keys are namespaced under `keyPrefix` and never used to build a filesystem path.
- **Content types**: `normalizeContentType` enforces a MIME shape and rejects CRLF/control
  characters (header-injection defense). Defaults to `application/octet-stream`.
- **Custom metadata**: bounded to 32 entries, safe keys, control-character-free values, and a
  configurable total byte budget (default 4 KiB). Prototype-polluting keys (`__proto__`,
  `constructor`, `prototype`) and the reserved `sveltex-*` prefix are rejected. Frozen on return.
- **Size**: `maxObjectSizeBytes` (default 16 MiB) is enforced while streaming, so an oversized
  body is rejected before it can exhaust disk or memory.
- **Integrity**: objects written through `Storage.put` record their SHA-256 `etag`, size, creation
  time and custom metadata. On S3 these travel as user metadata (`x-amz-meta-sveltex-sha256`,
  `x-amz-meta-sveltex-created-at`); reads validate and reject corrupt values. Local reads verify
  that the on-disk size still matches the sidecar.
- **Presigned URLs**: TTL is bounded to 1..604800 seconds (default 900). The generated URL is
  SigV4-signed, never contains the secret access key, and embeds the exact `content-type` in the
  signature for PUT. Tampering with the signature, changing the content type, or using an expired
  URL is rejected by the object store. Only drivers implementing `PresigningStorageDriver` can
  issue them.
- **Atomic writes (local)**: content is written to a temp file then `rename`d; metadata is
  published last. A symlinked `objects/` directory is rejected to prevent writes escaping the root.

## API surface

| Export | Module | Kind |
| --- | --- | --- |
| `Storage` | `@sveltex/storage` | class (facade) |
| `validateKey`, `validatePrefix`, `normalizeContentType`, `normalizeCustom`, `toChunks`, `collectStream`, `resolvePresignOptions` | `@sveltex/storage` | functions |
| `MIN_PRESIGN_TTL_SECONDS`, `MAX_PRESIGN_TTL_SECONDS`, `DEFAULT_PRESIGN_TTL_SECONDS` | `@sveltex/storage` | constants |
| `StorageDriver`, `PresigningStorageDriver`, `ObjectMetadata`, `StoredObject`, `PutOptions`, `PutCommand`, `ObjectBody`, `StorageOptions`, `PresignOptions`, `ResolvedPresignOptions`, `PresignedRequest` | `@sveltex/storage` | types |
| `StorageError`, `StorageKeyError`, `StorageValidationError`, `StorageLimitError`, `StorageClosedError`, `StorageIOError`, `StorageUnsupportedError` | `@sveltex/storage` | errors |
| `LocalStorageDriver`, `LocalStorageDriverOptions` | `@sveltex/storage/local` | driver |
| `S3StorageDriver`, `S3StorageDriverOptions`, `S3StorageCredentials` | `@sveltex/storage/s3` | driver |

## Testing

```sh
pnpm --filter @sveltex/storage test              # runtime + security + public-API type tests
pnpm --filter @sveltex/storage test:integration  # real MinIO S3 integration (never skipped in CI)
```

The integration suite starts from a real MinIO service (`SVELTEX_TEST_S3_ENDPOINT`,
`SVELTEX_TEST_S3_ACCESS_KEY`, `SVELTEX_TEST_S3_SECRET_KEY`, `SVELTEX_TEST_S3_REGION`) and uses
an independent AWS SDK client to prove objects really exist in the object store. It covers
round-trips, streaming, listing, deletion, presigned GET/PUT (including signature tampering,
expiry and content-type enforcement), traversal, size limits, missing-bucket diagnostics and
persistence across driver instances.

## Limitations and production notes

- **`LocalStorageDriver` is a single-process, local-disk driver.** It is not a distributed object
  store: no replication, no cross-machine sharing, no durable multi-writer locking guarantees.
- `S3StorageDriver` issues one `PutObject` per upload, so uploads are bounded by
  `maxUploadBytes`. There is no multipart upload, no server-side encryption configuration, no
  object locking, no versioning management, no bucket creation, and no CDN integration.
- S3 lower-cases user metadata keys. Use lower-case custom metadata keys for portable
  round-trips; mixed-case keys are lower-cased and collisions are rejected.
- Objects uploaded directly through a presigned PUT are readable but expose the **service ETag**
  as `etag` (not a SvelteX SHA-256), because the driver never receives those bytes. `createdAt`
  falls back to the service `LastModified` timestamp for such objects.
- `list()` resolves metadata with a `HeadObject` per key (N+1 requests); it is not intended for
  very large buckets. Use object-store-native listing for bulk administrative operations.
- No virus scanning, encryption at rest, or rate limiting is provided.

## Status

Phase 7 complete: real AWS SDK v3 S3 driver, real SigV4 presigned GET/PUT URLs, and real MinIO
integration tests. Verified with runtime, security, public-API type, and live S3-service tests.

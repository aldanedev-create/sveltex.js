# @sveltex/storage

Object storage contracts with safe upload metadata, true streaming, and a real local-filesystem driver.

## Install

```sh
pnpm add @sveltex/storage
```

## Concepts

- **`StorageDriver`** — the backend contract (`put`, `get`, `head`, `delete`, `list`, `close`). Implement it for S3/GCS/etc.
- **`LocalStorageDriver`** (`@sveltex/storage/local`) — a working driver that writes content and metadata sidecars atomically to a local directory.
- **`Storage`** — the driver-neutral facade that validates keys, MIME types, custom metadata, and maximum object size **before** delegating I/O.

## Minimal example

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

Bodies accept `Uint8Array`, `string`, a Web `ReadableStream<Uint8Array>`, or any `AsyncIterable<Uint8Array>`. `get` returns a Web `ReadableStream<Uint8Array>` created from a Node file stream, so large objects are never fully buffered in the driver.

## Safe upload metadata

- **Keys**: `validateKey` rejects traversal (`..`), absolute paths, backslashes, control characters, empty segments, and overlong names. On disk, keys are mapped to **SHA-256 hex filenames**, so no user-controlled path is ever used.
- **Content types**: `normalizeContentType` enforces a MIME shape and rejects CRLF/control characters (header-injection defense). Defaults to `application/octet-stream`.
- **Custom metadata**: bounded to 32 entries, safe keys, control-character-free values, and a configurable total byte budget (default 4 KiB). Frozen on return.
- **Size**: `maxObjectSizeBytes` (default 16 MiB) is enforced while streaming, so an oversized body is rejected before it can exhaust disk.
- **Integrity**: each object records its SHA-256 `etag` and size; reads verify that the on-disk size still matches the sidecar. A corrupt sidecar never fabricates an object.
- **Atomic writes**: content is written to a temp file then `rename`d; metadata is published last. A symlinked `objects/` directory is rejected to prevent writes escaping the root.

## API surface

| Export | Kind |
| --- | --- |
| `Storage` | class (facade) |
| `validateKey`, `validatePrefix`, `normalizeContentType`, `normalizeCustom`, `toChunks`, `collectStream` | functions |
| `StorageDriver`, `ObjectMetadata`, `StoredObject`, `PutOptions`, `PutCommand`, `ObjectBody`, `StorageOptions` | types |
| `StorageError`, `StorageKeyError`, `StorageValidationError`, `StorageLimitError`, `StorageClosedError`, `StorageIOError` | errors |
| `LocalStorageDriver`, `LocalStorageDriverOptions` (`@sveltex/storage/local`) | driver |

## Limitations and production notes

- **`LocalStorageDriver` is a single-process, local-disk driver.** It is **not** a distributed object store: no replication, no cross-machine sharing, and no durable multi-writer locking guarantees. For multi-instance deployments, implement `StorageDriver` backed by S3/GCS/etc.; the `Storage` facade is backend-agnostic.
- No encryption at rest, no virus scanning, and no CDN/URL signing are provided. Add these at the deployment or adapter layer.
- Overwriting the same key concurrently from multiple processes is not coordinated. Treat the local driver as a development/single-node implementation.
- No S3/GCS/Azure provider adapter is shipped in this package; none is advertised as supported.

## Status

Verified with real-filesystem runtime tests, security tests, and public-API type tests. No external service is required.

import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { toError } from '@sveltex/shared';
import {
  StorageClosedError,
  StorageIOError,
  StorageLimitError,
  StorageValidationError,
  normalizeContentType,
  validateKey,
  validatePrefix,
} from './index.js';
import type {
  ObjectMetadata,
  PresignedRequest,
  PresigningStorageDriver,
  PutCommand,
  ResolvedPresignOptions,
  StoredObject,
} from './index.js';

export interface S3StorageCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3StorageDriverOptions {
  /** Target bucket. Must already exist; this driver never creates buckets implicitly. */
  readonly bucket: string;
  /** AWS region. Defaults to `us-east-1`. */
  readonly region?: string;
  /** Custom endpoint for S3-compatible services (MinIO, Ceph, LocalStack, ...). */
  readonly endpoint?: string;
  /** Use path-style addressing. Defaults to `true` when a custom endpoint is set. */
  readonly forcePathStyle?: boolean;
  /** Static credentials. Omit to use the SDK default provider chain. */
  readonly credentials?: S3StorageCredentials;
  /** Namespace for all keys inside the bucket. A trailing `/` is added when missing. */
  readonly keyPrefix?: string;
  /** Bring your own SDK client. An owned client is destroyed on `close()`. */
  readonly client?: S3Client;
  /** Hard cap on bytes buffered for a single PutObject. Defaults to 64 MiB. */
  readonly maxUploadBytes?: number;
}

const RESERVED_METADATA_PREFIX = 'sveltex-';
const SHA256_METADATA_KEY = 'sveltex-sha256';
const CREATED_AT_METADATA_KEY = 'sveltex-created-at';
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/;
const REGION_NAME = /^[a-z0-9-]{1,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface ObjectHeadLike {
  readonly ContentLength?: number;
  readonly ContentType?: string;
  readonly ETag?: string;
  readonly LastModified?: Date;
  readonly Metadata?: Record<string, string>;
}

interface CustomMetadataPair {
  readonly metadata: Record<string, string>;
  readonly stored: Readonly<Record<string, string>>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateEndpoint(value: string | undefined): void {
  if (value === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new StorageValidationError('endpoint must be an absolute http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorageValidationError('endpoint must use http or https.');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new StorageValidationError('endpoint must not embed credentials; use the credentials option.');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new StorageValidationError('endpoint must not contain a query string or fragment.');
  }
}

function normalizeKeyPrefix(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  validatePrefix(value);
  return value.endsWith('/') ? value : `${value}/`;
}

function buildClientConfig(options: S3StorageDriverOptions, region: string, forcePathStyle: boolean): S3ClientConfig {
  return {
    region,
    forcePathStyle,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.credentials !== undefined
      ? {
          credentials: {
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
            ...(options.credentials.sessionToken !== undefined
              ? { sessionToken: options.credentials.sessionToken }
              : {}),
          },
        }
      : {}),
  };
}

/** S3 lower-cases user metadata keys; reject collisions and reserved/dangerous keys up front. */
function customToS3Metadata(custom: Readonly<Record<string, string>>): CustomMetadataPair {
  const metadata: Record<string, string> = {};
  const stored: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(custom)) {
    const lower = key.toLowerCase();
    if (lower.startsWith(RESERVED_METADATA_PREFIX)) {
      throw new StorageValidationError(`Custom metadata key "${key}" uses the reserved "sveltex-" prefix.`);
    }
    if (DANGEROUS_KEYS.has(lower)) {
      throw new StorageValidationError(`Custom metadata key "${key}" is not allowed.`);
    }
    if (Object.prototype.hasOwnProperty.call(metadata, lower)) {
      throw new StorageValidationError(`Custom metadata key "${key}" collides after lower-casing.`);
    }
    if (!isNonEmptyString(value)) {
      throw new StorageValidationError(`Custom metadata value for "${key}" must be a safe non-empty string.`);
    }
    metadata[lower] = value;
    Object.defineProperty(stored, lower, { value, enumerable: true, writable: false, configurable: false });
  }
  return { metadata, stored: Object.freeze(stored) };
}

function parseStoredMetadata(
  raw: Record<string, string> | undefined,
  fallback: { readonly etag: string; readonly createdAt: number },
): { readonly etag: string; readonly createdAt: number; readonly custom: Readonly<Record<string, string>> } {
  let etag = fallback.etag;
  let createdAt = fallback.createdAt;
  const custom: Record<string, string> = Object.create(null) as Record<string, string>;
  if (raw !== undefined) {
    for (const [key, value] of Object.entries(raw)) {
      const lower = key.toLowerCase();
      if (typeof value !== 'string') continue;
      if (lower === SHA256_METADATA_KEY) {
        if (SHA256_HEX.test(value)) etag = value;
        continue;
      }
      if (lower === CREATED_AT_METADATA_KEY) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed >= 0) createdAt = parsed;
        continue;
      }
      if (lower.startsWith(RESERVED_METADATA_PREFIX) || DANGEROUS_KEYS.has(lower)) continue;
      Object.defineProperty(custom, lower, { value, enumerable: true, writable: false, configurable: false });
    }
  }
  return { etag, createdAt, custom: Object.freeze(custom) };
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly Code?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const code = typeof candidate.Code === 'string' ? candidate.Code : '';
  // A missing *bucket* is a configuration/backend failure, never a missing object.
  if (name === 'NoSuchBucket' || code === 'NoSuchBucket') return false;
  return name === 'NoSuchKey' || name === 'NotFound' || code === 'NoSuchKey' || code === 'NotFound';
}

function driverError(operation: string, error: unknown, key: string): StorageIOError {
  return new StorageIOError(`S3 ${operation} failed for object "${key}".`, {
    cause: toError(error),
    details: {
      operation,
      backend: 's3',
      ...(isNotFound(error) ? { notFound: true } : {}),
    },
  });
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  const iterable = body as AsyncIterable<Uint8Array | string> | undefined;
  if (iterable === undefined || typeof iterable[Symbol.asyncIterator] !== 'function') {
    throw new StorageIOError('S3 returned no readable object body.', { details: { backend: 's3' } });
  }
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        const chunk = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      } catch (error) {
        controller.error(toError(error));
      }
    },
    async cancel() {
      if (typeof iterator.return === 'function') await iterator.return();
    },
  });
}

function assertPresignedUrl(url: string, secret: string | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StorageIOError('S3 presigner returned a malformed URL.', { details: { backend: 's3' } });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorageIOError('S3 presigner returned a non-HTTP URL.', { details: { backend: 's3' } });
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new StorageIOError('S3 presigner embedded credentials in the URL.', { details: { backend: 's3' } });
  }
  if (!parsed.searchParams.has('X-Amz-Signature')) {
    throw new StorageIOError('S3 presigner returned an unsigned URL.', { details: { backend: 's3' } });
  }
  if (secret !== undefined && url.includes(secret)) {
    throw new StorageIOError('S3 presigner leaked the secret access key into the URL.', { details: { backend: 's3' } });
  }
}

/**
 * A real S3 / S3-compatible storage driver built on the official AWS SDK v3.
 *
 * Objects are written with a single `PutObject` (bounded by `maxUploadBytes`), and reads are
 * streamed from `GetObject` into a Web `ReadableStream` — downloads are never fully buffered.
 * SvelteX integrity metadata (SHA-256 etag, creation time, custom metadata) is stored as S3
 * user metadata. Presigned GET/PUT URLs are SigV4 query-string signatures generated locally by
 * `@aws-sdk/s3-request-presigner`, so they work against AWS S3 and S3-compatible services.
 *
 * Objects uploaded directly through a presigned PUT are readable, but their `etag` is the
 * service ETag rather than a SvelteX SHA-256 (the driver cannot hash bytes it never received).
 */
export class S3StorageDriver implements PresigningStorageDriver {
  readonly #client: S3Client;
  readonly #ownsClient: boolean;
  readonly #bucket: string;
  readonly #keyPrefix: string;
  readonly #maxUploadBytes: number;
  readonly #secret: string | undefined;
  #closed = false;

  constructor(options: S3StorageDriverOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new StorageValidationError('S3 driver options are required.');
    }
    if (typeof options.bucket !== 'string' || !BUCKET_NAME.test(options.bucket) || options.bucket.includes('..')) {
      throw new StorageValidationError('bucket must be a valid S3 bucket name.');
    }
    const region = options.region ?? DEFAULT_REGION;
    if (!REGION_NAME.test(region)) throw new StorageValidationError('region must be a valid AWS region name.');
    validateEndpoint(options.endpoint);
    if (options.credentials !== undefined) {
      const { accessKeyId, secretAccessKey, sessionToken } = options.credentials;
      if (!isNonEmptyString(accessKeyId) || !isNonEmptyString(secretAccessKey)) {
        throw new StorageValidationError('Static credentials must provide safe, non-empty keys.');
      }
      if (sessionToken !== undefined && !isNonEmptyString(sessionToken)) {
        throw new StorageValidationError('sessionToken must be a safe, non-empty string.');
      }
    }
    const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
      throw new StorageValidationError('maxUploadBytes must be a positive integer.');
    }
    if (options.client !== undefined && typeof (options.client as { send?: unknown }).send !== 'function') {
      throw new StorageValidationError('client must be an S3Client-like object with a send() method.');
    }

    this.#bucket = options.bucket;
    this.#keyPrefix = normalizeKeyPrefix(options.keyPrefix);
    this.#maxUploadBytes = maxUploadBytes;
    this.#secret = options.credentials?.secretAccessKey;
    this.#ownsClient = options.client === undefined;
    this.#client = options.client ?? new S3Client(
      buildClientConfig(options, region, options.forcePathStyle ?? (options.endpoint !== undefined)),
    );
  }

  get isClosed(): boolean { return this.#closed; }
  get bucket(): string { return this.#bucket; }
  get keyPrefix(): string { return this.#keyPrefix; }

  #assertOpen(): void {
    if (this.#closed) throw new StorageClosedError('The S3 storage driver is closed.');
  }

  #objectKey(key: string): string {
    validateKey(key);
    return `${this.#keyPrefix}${key}`;
  }

  #metadataFromHead(key: string, output: unknown): ObjectMetadata {
    const head = output as ObjectHeadLike;
    const size = head.ContentLength;
    if (!Number.isSafeInteger(size) || (size ?? -1) < 0) {
      throw new StorageIOError('S3 returned an invalid ContentLength.', {
        details: { backend: 's3', operation: 'metadata' },
      });
    }
    let contentType = 'application/octet-stream';
    if (typeof head.ContentType === 'string' && head.ContentType.length > 0) {
      try {
        contentType = normalizeContentType(head.ContentType);
      } catch {
        contentType = 'application/octet-stream';
      }
    }
    const serviceEtag = typeof head.ETag === 'string' ? head.ETag.replace(/^"|"$/g, '') : '';
    const lastModified = head.LastModified instanceof Date ? head.LastModified.getTime() : Date.now();
    const parsed = parseStoredMetadata(head.Metadata, { etag: serviceEtag, createdAt: lastModified });
    return Object.freeze({
      key,
      size: size as number,
      contentType,
      etag: parsed.etag,
      createdAt: parsed.createdAt,
      custom: parsed.custom,
    });
  }

  async put(command: PutCommand): Promise<ObjectMetadata> {
    this.#assertOpen();
    const objectKey = this.#objectKey(command.key);
    const built = customToS3Metadata(command.custom);
    const chunks: Uint8Array[] = [];
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of command.body) {
      if (!(chunk instanceof Uint8Array)) throw new StorageValidationError('Body chunks must be Uint8Array.');
      size += chunk.byteLength;
      if (size > this.#maxUploadBytes) {
        throw new StorageLimitError('Object exceeds the S3 driver upload limit.');
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
    const etag = hash.digest('hex');
    const s3Metadata: Record<string, string> = {
      ...built.metadata,
      [SHA256_METADATA_KEY]: etag,
      [CREATED_AT_METADATA_KEY]: String(command.now),
    };
    try {
      await this.#client.send(new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: concatChunks(chunks, size),
        ContentType: command.contentType,
        Metadata: s3Metadata,
      }));
    } catch (error) {
      throw driverError('put', error, command.key);
    }
    return Object.freeze({
      key: command.key,
      size,
      contentType: normalizeContentType(command.contentType),
      etag,
      createdAt: command.now,
      custom: built.stored,
    });
  }

  async get(key: string): Promise<StoredObject | undefined> {
    this.#assertOpen();
    const objectKey = this.#objectKey(key);
    let output: unknown;
    try {
      output = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw driverError('get', error, key);
    }
    const metadata = this.#metadataFromHead(key, output);
    const body = toWebStream((output as { readonly Body?: unknown }).Body);
    return Object.freeze({ metadata, body });
  }

  async head(key: string): Promise<ObjectMetadata | undefined> {
    this.#assertOpen();
    const objectKey = this.#objectKey(key);
    let output: unknown;
    try {
      output = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw driverError('head', error, key);
    }
    return this.#metadataFromHead(key, output);
  }

  async delete(key: string): Promise<boolean> {
    this.#assertOpen();
    const objectKey = this.#objectKey(key);
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
    } catch (error) {
      if (isNotFound(error)) return false;
      throw driverError('head', error, key);
    }
    try {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
    } catch (error) {
      throw driverError('delete', error, key);
    }
    return true;
  }

  async list(prefix = ''): Promise<readonly ObjectMetadata[]> {
    this.#assertOpen();
    validatePrefix(prefix);
    const fullPrefix = `${this.#keyPrefix}${prefix}`;
    const objectKeys: string[] = [];
    let continuationToken: string | undefined;
    for (;;) {
      let output;
      try {
        output = await this.#client.send(new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: fullPrefix,
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }));
      } catch (error) {
        throw driverError('list', error, prefix);
      }
      for (const item of output.Contents ?? []) {
        if (typeof item.Key === 'string' && item.Key.startsWith(this.#keyPrefix)) objectKeys.push(item.Key);
      }
      if (output.IsTruncated !== true) break;
      const next = output.NextContinuationToken;
      if (typeof next !== 'string' || next.length === 0) {
        throw new StorageIOError('S3 list pagination was truncated without a continuation token.', {
          details: { backend: 's3', operation: 'list' },
        });
      }
      continuationToken = next;
    }
    const result: ObjectMetadata[] = [];
    for (const objectKey of objectKeys) {
      const key = objectKey.slice(this.#keyPrefix.length);
      try {
        validateKey(key);
      } catch {
        continue;
      }
      const metadata = await this.head(key);
      if (metadata !== undefined) result.push(metadata);
    }
    result.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return Object.freeze(result);
  }

  async presignGet(key: string, options: ResolvedPresignOptions, now: number): Promise<PresignedRequest> {
    this.#assertOpen();
    const objectKey = this.#objectKey(key);
    let url: string;
    try {
      url = await getSignedUrl(
        this.#client,
        new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
        { expiresIn: options.expiresInSeconds },
      );
    } catch (error) {
      throw driverError('presignGet', error, key);
    }
    assertPresignedUrl(url, this.#secret);
    return Object.freeze({
      url,
      method: 'GET',
      headers: Object.freeze({}),
      expiresAt: now + options.expiresInSeconds * 1000,
    });
  }

  async presignPut(key: string, options: ResolvedPresignOptions, now: number): Promise<PresignedRequest> {
    this.#assertOpen();
    const objectKey = this.#objectKey(key);
    const contentType = options.contentType ?? 'application/octet-stream';
    const built = customToS3Metadata(options.custom);
    let url: string;
    try {
      url = await getSignedUrl(
        this.#client,
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          ContentType: contentType,
          ...(Object.keys(built.metadata).length > 0 ? { Metadata: built.metadata } : {}),
        }),
        { expiresIn: options.expiresInSeconds, signableHeaders: new Set(['content-type']) },
      );
    } catch (error) {
      throw driverError('presignPut', error, key);
    }
    assertPresignedUrl(url, this.#secret);
    return Object.freeze({
      url,
      method: 'PUT',
      headers: Object.freeze({ 'content-type': contentType }),
      expiresAt: now + options.expiresInSeconds * 1000,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsClient) this.#client.destroy();
  }
}

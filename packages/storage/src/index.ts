import { SvelteXError, toError } from '@sveltex/shared';

export type ObjectBody =
  | Uint8Array
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface ObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  /** SHA-256 hex digest of the stored bytes. */
  readonly etag: string;
  readonly createdAt: number;
  readonly custom: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly metadata: ObjectMetadata;
  readonly body: ReadableStream<Uint8Array>;
}

export interface PutOptions {
  readonly contentType?: string;
  readonly custom?: Readonly<Record<string, string>>;
}

/** Normalized command handed to a driver by the Storage facade. */
export interface PutCommand {
  readonly key: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentType: string;
  readonly custom: Readonly<Record<string, string>>;
  readonly now: number;
}

/** Contract for storage backends (local filesystem, S3, GCS, ...). */
export interface StorageDriver {
  put(command: PutCommand): Promise<ObjectMetadata>;
  get(key: string): Promise<StoredObject | undefined>;
  head(key: string): Promise<ObjectMetadata | undefined>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<readonly ObjectMetadata[]>;
  close(): Promise<void>;
  readonly isClosed: boolean;
}

export interface StorageErrorOptions {
  readonly cause?: Error;
  readonly details?: Record<string, unknown>;
}
export class StorageError extends SvelteXError {
  constructor(code: string, message: string, options: StorageErrorOptions = {}) {
    super(message, {
      code,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    });
    this.name = 'StorageError';
  }
}
export class StorageKeyError extends StorageError {
  constructor(message: string, options: StorageErrorOptions = {}) {
    super('SX_STORAGE_KEY', message, options);
    this.name = 'StorageKeyError';
  }
}
export class StorageValidationError extends StorageError {
  constructor(message: string, options: StorageErrorOptions = {}) {
    super('SX_STORAGE_VALIDATION', message, options);
    this.name = 'StorageValidationError';
  }
}
export class StorageLimitError extends StorageError {
  constructor(message: string, options: StorageErrorOptions = {}) {
    super('SX_STORAGE_LIMIT', message, options);
    this.name = 'StorageLimitError';
  }
}
export class StorageClosedError extends StorageError {
  constructor(message: string, options: StorageErrorOptions = {}) {
    super('SX_STORAGE_CLOSED', message, options);
    this.name = 'StorageClosedError';
  }
}
export class StorageIOError extends StorageError {
  constructor(message: string, options: StorageErrorOptions = {}) {
    super('SX_STORAGE_IO', message, options);
    this.name = 'StorageIOError';
  }
}

const KEY_SEGMENT = /^[A-Za-z0-9._~@+-]+$/;
const CONTENT_TYPE = /^[A-Za-z0-9.!#$&^_*+-]+\/[A-Za-z0-9.!#$&^_*+-]+(?:\s*;\s*[A-Za-z0-9.!#$&^_*+-]+="?[A-Za-z0-9.!#$&^_*+ /=-]+"?)?$/;
const CUSTOM_KEY = /^[A-Za-z0-9._-]{1,64}$/;

/** Validate an object key. Rejects traversal, absolute paths, control chars and Windows separators. */
export function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
    throw new StorageKeyError('Key must be a non-empty string of at most 512 characters.');
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new StorageKeyError('Key must not contain control characters.');
  if (key.startsWith('/')) throw new StorageKeyError('Key must not be an absolute path.');
  if (key.includes('\\')) throw new StorageKeyError('Key must not contain backslashes.');
  if (key.includes('//')) throw new StorageKeyError('Key must not contain empty path segments.');
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new StorageKeyError('Key must not contain "." or ".." path segments.');
    if (segment.length > 255) throw new StorageKeyError('Key segments must not exceed 255 characters.');
    if (!KEY_SEGMENT.test(segment)) throw new StorageKeyError('Key segments may only contain URL-safe characters.');
  }
}

export function validatePrefix(prefix: string): void {
  if (typeof prefix !== 'string' || prefix.length > 512) throw new StorageKeyError('Prefix must be a string of at most 512 characters.');
  if (prefix.length === 0) return;
  if (/[\u0000-\u001f\u007f]/.test(prefix) || prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('..')) {
    throw new StorageKeyError('Prefix must be a relative, traversal-free path.');
  }
  if (!/^[A-Za-z0-9._~@+/\-]+$/.test(prefix)) throw new StorageKeyError('Prefix contains unsupported characters.');
}

/** Normalize and validate a MIME type. CRLF/control characters are rejected (header injection). */
export function normalizeContentType(value: string | undefined): string {
  if (value === undefined) return 'application/octet-stream';
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new StorageValidationError('contentType must be a non-empty string of at most 256 characters.');
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) throw new StorageValidationError('contentType must not contain control characters.');
  if (!CONTENT_TYPE.test(value)) throw new StorageValidationError('contentType is not a valid MIME type.');
  return value;
}

/** Copy, validate and freeze custom metadata. Bounds key count, key/value length and total size. */
export function normalizeCustom(
  value: Readonly<Record<string, string>> | undefined,
  maxBytes: number,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StorageValidationError('custom metadata must be a plain object of string values.');
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new StorageValidationError('custom metadata must not exceed 32 entries.');
  let total = 0;
  const copy: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!CUSTOM_KEY.test(k)) throw new StorageValidationError('Invalid custom metadata key.');
    if (typeof v !== 'string') throw new StorageValidationError('custom metadata values must be strings.');
    if (/[\r\n\u0000-\u001f\u007f]/.test(v)) throw new StorageValidationError('custom metadata values must not contain control characters.');
    if (v.length > 1024) throw new StorageValidationError('custom metadata values must not exceed 1024 characters.');
    total += k.length + v.length;
    if (total > maxBytes) throw new StorageLimitError('custom metadata exceeds the configured byte budget.');
    copy[k] = v;
  }
  return Object.freeze(copy);
}

/** Convert any accepted body into a single async chunk stream. */
export async function* toChunks(body: ObjectBody): AsyncGenerator<Uint8Array> {
  if (typeof body === 'string') {
    yield new TextEncoder().encode(body);
    return;
  }
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  if (isReadableStream(body)) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  const iterable = body as AsyncIterable<Uint8Array>;
  if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
    for await (const chunk of iterable) {
      if (!(chunk instanceof Uint8Array)) throw new StorageValidationError('Body chunks must be Uint8Array.');
      yield chunk;
    }
    return;
  }
  throw new StorageValidationError('Unsupported object body.');
}

function isReadableStream(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { getReader?: unknown }).getReader === 'function';
}

async function* limited(source: AsyncIterable<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new StorageLimitError('Object exceeds the configured maximum size.');
    yield chunk;
  }
}

/** Read a Web stream fully into a single Uint8Array (helper for consumers and tests). */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export interface StorageOptions {
  readonly driver: StorageDriver;
  readonly maxObjectSizeBytes?: number;
  readonly maxCustomMetadataBytes?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_METADATA_BYTES = 4 * 1024;

/** Driver-neutral storage facade: validates keys, MIME types, metadata and size before I/O. */
export class Storage {
  readonly #driver: StorageDriver;
  readonly #maxObjectSizeBytes: number;
  readonly #maxCustomMetadataBytes: number;
  readonly #now: () => number;
  #closed = false;

  constructor(options: StorageOptions) {
    if (!options || !options.driver) throw new StorageValidationError('A storage driver is required.');
    const maxObject = options.maxObjectSizeBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    const maxMeta = options.maxCustomMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
    if (!Number.isSafeInteger(maxObject) || maxObject < 1) throw new StorageValidationError('maxObjectSizeBytes must be a positive integer.');
    if (!Number.isSafeInteger(maxMeta) || maxMeta < 1) throw new StorageValidationError('maxCustomMetadataBytes must be a positive integer.');
    this.#driver = options.driver;
    this.#maxObjectSizeBytes = maxObject;
    this.#maxCustomMetadataBytes = maxMeta;
    this.#now = options.now ?? Date.now;
  }

  get isClosed(): boolean { return this.#closed || this.#driver.isClosed; }

  async put(key: string, body: ObjectBody, options: PutOptions = {}): Promise<ObjectMetadata> {
    this.#assertOpen();
    validateKey(key);
    const contentType = normalizeContentType(options.contentType);
    const custom = normalizeCustom(options.custom, this.#maxCustomMetadataBytes);
    const chunks = limited(toChunks(body), this.#maxObjectSizeBytes);
    return this.#call(() => this.#driver.put({ key, body: chunks, contentType, custom, now: this.#now() }));
  }

  async get(key: string): Promise<StoredObject | undefined> {
    this.#assertOpen();
    validateKey(key);
    return this.#call(() => this.#driver.get(key));
  }

  async head(key: string): Promise<ObjectMetadata | undefined> {
    this.#assertOpen();
    validateKey(key);
    return this.#call(() => this.#driver.head(key));
  }

  async delete(key: string): Promise<boolean> {
    this.#assertOpen();
    validateKey(key);
    return this.#call(() => this.#driver.delete(key));
  }

  async list(prefix = ''): Promise<readonly ObjectMetadata[]> {
    this.#assertOpen();
    validatePrefix(prefix);
    return this.#call(() => this.#driver.list(prefix));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#driver.close();
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageIOError('Storage operation failed.', { cause: toError(error) });
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#driver.isClosed) throw new StorageClosedError('Storage is closed.');
  }
}

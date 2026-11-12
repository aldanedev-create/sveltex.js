import {
  Storage,
  validateKey,
  validatePrefix,
  normalizeContentType,
  normalizeCustom,
  collectStream,
  StorageError,
  StorageKeyError,
  StorageValidationError,
  StorageLimitError,
  StorageClosedError,
  StorageIOError,
  StorageUnsupportedError,
  resolvePresignOptions,
  MIN_PRESIGN_TTL_SECONDS,
  MAX_PRESIGN_TTL_SECONDS,
  DEFAULT_PRESIGN_TTL_SECONDS,
} from '../../dist/index.js';
import type {
  ObjectBody,
  ObjectMetadata,
  StoredObject,
  PutOptions,
  PutCommand,
  StorageDriver,
  StorageOptions,
  PresignOptions,
  ResolvedPresignOptions,
  PresignedRequest,
  PresigningStorageDriver,
} from '../../dist/index.js';
import { LocalStorageDriver } from '../../dist/local.js';
import type { LocalStorageDriverOptions } from '../../dist/local.js';
import { S3StorageDriver } from '../../dist/s3.js';
import type { S3StorageDriverOptions, S3StorageCredentials } from '../../dist/s3.js';

const driverOptions: LocalStorageDriverOptions = { root: '/tmp/sveltex-storage-types' };
const driver: StorageDriver = new LocalStorageDriver(driverOptions);
const options: StorageOptions = { driver, maxObjectSizeBytes: 1024, now: () => 0 };
const storage: Storage = new Storage(options);

const body: ObjectBody = new Uint8Array([1, 2, 3]);
const putOpts: PutOptions = { contentType: 'application/json', custom: { a: 'b' } };
const put: Promise<ObjectMetadata> = storage.put('a/b.json', body, putOpts);
const got: Promise<StoredObject | undefined> = storage.get('a/b.json');
const head: Promise<ObjectMetadata | undefined> = storage.head('a/b.json');
const del: Promise<boolean> = storage.delete('a/b.json');
const list: Promise<readonly ObjectMetadata[]> = storage.list('a/');
const closed: Promise<void> = storage.close();
const isClosed: boolean = storage.isClosed;
void [put, got, head, del, list, closed, isClosed, putOpts, options, driverOptions];

const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
const allBytes: Promise<Uint8Array> = collectStream(stream);
void allBytes;

validateKey('a/b');
validatePrefix('a/');
const ct: string = normalizeContentType('text/plain');
const custom: Readonly<Record<string, string>> = normalizeCustom({ a: 'b' }, 100);
void [ct, custom];

const cmd: PutCommand = {
  key: 'x',
  body: (async function* () { yield new Uint8Array([1]); })(),
  contentType: 'application/octet-stream',
  custom: {},
  now: 0,
};
void cmd;

const err: StorageError = new StorageKeyError('bad');
const code: string = err.code;
void code;
void [StorageValidationError, StorageLimitError, StorageClosedError, StorageIOError, StorageUnsupportedError];

const s3Credentials: S3StorageCredentials = { accessKeyId: 'a', secretAccessKey: 'b' };
const s3Options: S3StorageDriverOptions = {
  bucket: 'sveltex-types',
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  forcePathStyle: true,
  credentials: s3Credentials,
  keyPrefix: 'app/',
  maxUploadBytes: 1024,
};
const s3Driver: S3StorageDriver = new S3StorageDriver(s3Options);
const presigning: PresigningStorageDriver = s3Driver;
const s3Storage: Storage = new Storage({ driver: s3Driver });
const presignOpts: PresignOptions = { expiresInSeconds: 120, contentType: 'text/plain', custom: { a: 'b' } };
const getReq: Promise<PresignedRequest> = s3Storage.presignGet('a.txt', presignOpts);
const putReq: Promise<PresignedRequest> = s3Storage.presignPut('a.txt', presignOpts);
const resolved: ResolvedPresignOptions = resolvePresignOptions(presignOpts, 4096);
const ttl: number = resolved.expiresInSeconds;
const resolvedContentType: string = resolved.contentType ?? 'application/octet-stream';
const customEntries: number = Object.keys(resolved.custom).length;
const bucket: string = s3Driver.bucket;
const prefix: string = s3Driver.keyPrefix;
const s3Closed: boolean = s3Driver.isClosed;
void [getReq, putReq, ttl, resolvedContentType, customEntries, bucket, prefix, s3Closed, presigning, s3Options];
void [MIN_PRESIGN_TTL_SECONDS, MAX_PRESIGN_TTL_SECONDS, DEFAULT_PRESIGN_TTL_SECONDS];

// @ts-expect-error a driver is required
void new Storage({});

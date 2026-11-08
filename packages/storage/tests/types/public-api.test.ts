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
} from '../../dist/index.js';
import type {
  ObjectBody,
  ObjectMetadata,
  StoredObject,
  PutOptions,
  PutCommand,
  StorageDriver,
  StorageOptions,
} from '../../dist/index.js';
import { LocalStorageDriver } from '../../dist/local.js';
import type { LocalStorageDriverOptions } from '../../dist/local.js';

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
void [StorageValidationError, StorageLimitError, StorageClosedError, StorageIOError];

// @ts-expect-error a driver is required
void new Storage({});

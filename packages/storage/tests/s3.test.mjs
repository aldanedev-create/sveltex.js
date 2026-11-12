import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Storage,
  StorageUnsupportedError,
  StorageValidationError,
  StorageKeyError,
  StorageClosedError,
  resolvePresignOptions,
  MIN_PRESIGN_TTL_SECONDS,
  MAX_PRESIGN_TTL_SECONDS,
  DEFAULT_PRESIGN_TTL_SECONDS,
} from '../dist/index.js';
import { LocalStorageDriver } from '../dist/local.js';
import { S3StorageDriver } from '../dist/s3.js';

const SECRET = 'unit-test-secret-key';
const OPTIONS = {
  bucket: 'sveltex-unit-test',
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  credentials: { accessKeyId: 'AKIAUNITTEST123', secretAccessKey: SECRET },
};

function makeStorage(options = {}) {
  const driver = new S3StorageDriver({ ...OPTIONS, ...options });
  const storage = new Storage({ driver, now: () => 1700000000000, ...options.storage });
  return { driver, storage };
}

test('S3StorageDriver validates bucket, region, endpoint, credentials and client', () => {
  for (const bad of ['', 'a', '../x', 'has space', 'x'.repeat(64), 42, null]) {
    assert.throws(() => new S3StorageDriver({ ...OPTIONS, bucket: bad }), { name: 'StorageValidationError' });
  }
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, region: 'US EAST' }), { name: 'StorageValidationError' });
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, endpoint: 'ftp://x' }), { name: 'StorageValidationError' });
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, endpoint: 'http://u:p@127.0.0.1:9000' }), { name: 'StorageValidationError' });
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, endpoint: 'http://x/?q=1' }), { name: 'StorageValidationError' });
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, credentials: { accessKeyId: '', secretAccessKey: 'x' } }), { name: 'StorageValidationError' });
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, maxUploadBytes: 0 }), { name: 'StorageValidationError' });
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, client: { send: 'nope' } }), { name: 'StorageValidationError' });
  assert.throws(() => new S3StorageDriver({ ...OPTIONS, keyPrefix: '../escape' }), { name: 'StorageKeyError' });
});

test('keyPrefix is normalized to a trailing slash', () => {
  const a = new S3StorageDriver({ ...OPTIONS, keyPrefix: 'tenant-a' });
  assert.equal(a.keyPrefix, 'tenant-a/');
  const b = new S3StorageDriver({ ...OPTIONS, keyPrefix: 'tenant-b/' });
  assert.equal(b.keyPrefix, 'tenant-b/');
  const c = new S3StorageDriver(OPTIONS);
  assert.equal(c.keyPrefix, '');
  assert.equal(c.bucket, 'sveltex-unit-test');
  assert.equal(a.isClosed, false);
});

test('presignGet produces a locally SigV4-signed URL without leaking the secret', async () => {
  const { storage } = makeStorage();
  const req = await storage.presignGet('docs/readme.txt', { expiresInSeconds: 120 });
  assert.equal(req.method, 'GET');
  assert.equal(req.expiresAt, 1700000000000 + 120000);
  assert.deepEqual({ ...req.headers }, {});
  const url = new URL(req.url);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.pathname, '/sveltex-unit-test/docs/readme.txt');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
  assert.ok(url.searchParams.has('X-Amz-Signature'));
  assert.ok(url.searchParams.has('X-Amz-Credential'));
  assert.ok(!req.url.includes(SECRET));
  await storage.close();
});

test('presignPut signs content-type and carries custom metadata in the URL', async () => {
  const { storage } = makeStorage();
  const req = await storage.presignPut('avatars/u.png', {
    expiresInSeconds: 300,
    contentType: 'image/png',
    custom: { owner: 'alice' },
  });
  assert.equal(req.method, 'PUT');
  assert.equal(req.expiresAt, 1700000000000 + 300000);
  assert.equal(req.headers['content-type'], 'image/png');
  const url = new URL(req.url);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.ok(url.searchParams.get('X-Amz-SignedHeaders')?.includes('content-type'));
  assert.ok(url.searchParams.get('x-amz-meta-owner') === 'alice' || req.url.includes('owner=alice'));
  assert.ok(!req.url.includes(SECRET));
  await storage.close();
});

test('presignPut defaults to application/octet-stream when no content type is given', async () => {
  const { storage } = makeStorage();
  const req = await storage.presignPut('blob.bin');
  assert.equal(req.headers['content-type'], 'application/octet-stream');
  assert.equal(new URL(req.url).searchParams.get('X-Amz-Expires'), String(DEFAULT_PRESIGN_TTL_SECONDS));
  await storage.close();
});

test('resolvePresignOptions bounds TTL and normalizes content type / metadata', () => {
  const ok = resolvePresignOptions({}, 4096);
  assert.equal(ok.expiresInSeconds, DEFAULT_PRESIGN_TTL_SECONDS);
  assert.equal(ok.contentType, undefined);
  assert.ok(Object.isFrozen(ok));
  assert.equal(resolvePresignOptions({ expiresInSeconds: MIN_PRESIGN_TTL_SECONDS }, 4096).expiresInSeconds, 1);
  assert.equal(resolvePresignOptions({ expiresInSeconds: MAX_PRESIGN_TTL_SECONDS }, 4096).expiresInSeconds, 604800);
  for (const bad of [0, -1, 604801, 1.5, Number.NaN, '120', null]) {
    assert.throws(() => resolvePresignOptions({ expiresInSeconds: bad }, 4096), { name: 'StorageValidationError' });
  }
  assert.throws(() => resolvePresignOptions({ contentType: 'text/plain\r\nX: 1' }, 4096), { name: 'StorageValidationError' });
  assert.throws(() => resolvePresignOptions({ custom: { a: 1 } }, 4096), { name: 'StorageValidationError' });
});

test('facade rejects out-of-range TTL before touching the driver', async () => {
  const { storage } = makeStorage();
  await assert.rejects(() => storage.presignGet('x.txt', { expiresInSeconds: 0 }), { name: 'StorageValidationError' });
  await assert.rejects(() => storage.presignPut('x.txt', { expiresInSeconds: 999999 }), { name: 'StorageValidationError' });
  await storage.close();
});

test('facade reports unsupported presigning for drivers without the capability', async () => {
  const storage = new Storage({ driver: new LocalStorageDriver({ root: '/tmp/sveltex-storage-presign-unused' }) });
  await assert.rejects(() => storage.presignGet('a.txt'), { name: 'StorageUnsupportedError' });
  await assert.rejects(() => storage.presignPut('a.txt'), { name: 'StorageUnsupportedError' });
  await storage.close();
  assert.ok(StorageUnsupportedError);
});

test('reserved sveltex- metadata prefix and prototype-polluting keys are rejected', async () => {
  const { storage } = makeStorage();
  await assert.rejects(
    () => storage.presignPut('x.txt', { custom: { 'sveltex-sha256': 'forged' } }),
    { name: 'StorageValidationError' },
  );
  const polluted = Object.create(null);
  Object.defineProperty(polluted, '__proto__', { value: 'polluted', enumerable: true });
  await assert.rejects(
    () => storage.presignPut('x.txt', { custom: polluted }),
    { name: 'StorageValidationError' },
  );
  await storage.close();
});

test('key traversal is rejected by the S3 driver before signing', async () => {
  const { storage } = makeStorage();
  for (const bad of ['../secret', '/abs', 'a//b', 'a\u0000b']) {
    await assert.rejects(() => storage.presignGet(bad), { name: 'StorageKeyError' });
    await assert.rejects(() => storage.presignPut(bad), { name: 'StorageKeyError' });
  }
  await storage.close();
});

test('close() is idempotent and rejects all later operations', async () => {
  const { driver, storage } = makeStorage();
  await storage.close();
  await storage.close();
  assert.equal(driver.isClosed, true);
  assert.equal(storage.isClosed, true);
  await assert.rejects(() => storage.presignGet('x'), { name: 'StorageClosedError' });
  await assert.rejects(() => storage.presignPut('x'), { name: 'StorageClosedError' });
  await assert.rejects(() => storage.get('x'), { name: 'StorageClosedError' });
  assert.ok(StorageClosedError);
});

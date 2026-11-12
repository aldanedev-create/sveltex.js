import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Storage,
  StorageValidationError,
  StorageKeyError,
  StorageClosedError,
  StorageUnsupportedError,
  normalizeCustom,
  resolvePresignOptions,
} from '../../dist/index.js';
import { LocalStorageDriver } from '../../dist/local.js';
import { S3StorageDriver } from '../../dist/s3.js';

const SECRET = 'super-secret-access-key-value';
const OPTIONS = {
  bucket: 'sveltex-security',
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  credentials: { accessKeyId: 'AKIASECURITY123', secretAccessKey: SECRET },
};

function signedStorage() {
  const driver = new S3StorageDriver(OPTIONS);
  return { driver, storage: new Storage({ driver, now: () => 1700000000000 }) };
}

test('SEC-7-1: presigned URLs never expose the secret access key', async () => {
  const { storage } = signedStorage();
  for (const req of [
    await storage.presignGet('a.txt', { expiresInSeconds: 60 }),
    await storage.presignPut('b.txt', { expiresInSeconds: 60, contentType: 'text/plain' }),
  ]) {
    assert.ok(!req.url.includes(SECRET));
    assert.ok(!req.url.includes(encodeURIComponent(SECRET)));
    const url = new URL(req.url);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.ok(url.searchParams.has('X-Amz-Signature'));
    // Only the public access-key id may appear, inside X-Amz-Credential.
    assert.ok(url.searchParams.get('X-Amz-Credential')?.includes('AKIASECURITY123'));
  }
  await storage.close();
});

test('SEC-7-2: presign TTL is bounded (1..604800 seconds) and rejects non-integers', async () => {
  const { storage } = signedStorage();
  for (const bad of [0, -1, 604801, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '60', null, {}]) {
    await assert.rejects(() => storage.presignGet('a.txt', { expiresInSeconds: bad }), { name: 'StorageValidationError' });
    await assert.rejects(() => storage.presignPut('a.txt', { expiresInSeconds: bad }), { name: 'StorageValidationError' });
  }
  assert.throws(() => resolvePresignOptions({ expiresInSeconds: 0 }, 4096), { name: 'StorageValidationError' });
  await storage.close();
});

test('SEC-7-3: object keys cannot traverse or inject into signed URLs', async () => {
  const { storage } = signedStorage();
  for (const bad of ['../secret', 'a/../../b', '/etc/passwd', 'a//b', 'a\\b', 'a\u0000b', '.', '..']) {
    await assert.rejects(() => storage.presignGet(bad), { name: 'StorageKeyError' });
    await assert.rejects(() => storage.presignPut(bad), { name: 'StorageKeyError' });
  }
  assert.ok(StorageKeyError);
  await storage.close();
});

test('SEC-7-4: content-type header injection is rejected in presign options', async () => {
  const { storage } = signedStorage();
  for (const bad of ['text/plain\r\nX-Injected: 1', 'text/plain\n', 'text/plain\u0000', 'not-a-mime']) {
    await assert.rejects(
      () => storage.presignPut('a.txt', { contentType: bad }),
      { name: 'StorageValidationError' },
    );
  }
  const ok = resolvePresignOptions({ contentType: 'text/plain; charset=utf-8' }, 4096);
  assert.equal(ok.contentType, 'text/plain; charset=utf-8');
  await storage.close();
});

test('SEC-7-5: prototype-polluting custom metadata keys are rejected at the facade boundary', async () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const custom = Object.create(null);
    Object.defineProperty(custom, key, { value: 'polluted', enumerable: true });
    assert.throws(() => normalizeCustom(custom, 4096), { name: 'StorageValidationError' });
  }
  const { storage } = signedStorage();
  const injected = Object.create(null);
  Object.defineProperty(injected, '__proto__', { value: 'polluted', enumerable: true });
  await assert.rejects(
    () => storage.presignPut('a.txt', { custom: injected }),
    { name: 'StorageValidationError' },
  );
  assert.equal(({}).polluted, undefined);
  await storage.close();
});

test('SEC-7-6: endpoints must not embed credentials, query strings or fragments', () => {
  for (const bad of [
    'http://user:pass@127.0.0.1:9000',
    'http://127.0.0.1:9000/?token=abc',
    'http://127.0.0.1:9000/#frag',
    'ftp://127.0.0.1:9000',
    'not a url',
  ]) {
    assert.throws(() => new S3StorageDriver({ ...OPTIONS, endpoint: bad }), { name: 'StorageValidationError' });
  }
});

test('SEC-7-7: reserved sveltex-* metadata cannot be forged through custom metadata', async () => {
  const { storage } = signedStorage();
  for (const key of ['sveltex-sha256', 'Sveltex-Sha256', 'sveltex-created-at']) {
    await assert.rejects(
      () => storage.presignPut('a.txt', { custom: { [key]: 'forged' } }),
      { name: 'StorageValidationError' },
    );
  }
  await storage.close();
});

test('SEC-7-8: a closed driver never issues a signed URL or accepts a write', async () => {
  const { driver, storage } = signedStorage();
  await storage.close();
  assert.equal(driver.isClosed, true);
  await assert.rejects(() => storage.presignGet('a.txt'), { name: 'StorageClosedError' });
  await assert.rejects(() => storage.presignPut('a.txt'), { name: 'StorageClosedError' });
  await assert.rejects(() => storage.put('a.txt', 'x'), { name: 'StorageClosedError' });
  assert.ok(StorageClosedError);
});

test('SEC-7-9: presigning is an explicit capability, never silently ignored', async () => {
  const storage = new Storage({ driver: new LocalStorageDriver({ root: '/tmp/sveltex-storage-security-unused' }) });
  await assert.rejects(() => storage.presignGet('a.txt'), { name: 'StorageUnsupportedError' });
  assert.ok(StorageUnsupportedError);
  assert.ok(StorageValidationError);
  await storage.close();
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  Storage,
  StorageIOError,
  StorageKeyError,
  StorageLimitError,
  collectStream,
} from '../../dist/index.js';
import { S3StorageDriver } from '../../dist/s3.js';

const ENDPOINT = process.env.SVELTEX_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const REGION = process.env.SVELTEX_TEST_S3_REGION ?? 'us-east-1';
const ACCESS_KEY = process.env.SVELTEX_TEST_S3_ACCESS_KEY ?? 'sveltex';
const SECRET_KEY = process.env.SVELTEX_TEST_S3_SECRET_KEY ?? 'sveltex_test_pw';

const CREDENTIALS = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };
let admin;
let bucket;
let counter = 0;

before(async () => {
  admin = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
  });
  bucket = `sveltex-it-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: '__probe__' })).catch((error) => {
    // A 404 is expected here; any other failure means the service is not actually usable.
    if (error.$metadata?.httpStatusCode !== 404) throw error;
  });
});

after(async () => {
  if (!admin || !bucket) return;
  const listed = await admin.send(new ListObjectsV2Command({ Bucket: bucket }));
  for (const item of listed.Contents ?? []) {
    if (typeof item.Key === 'string') await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
  }
  await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
  admin.destroy();
});

function harness(t, options = {}) {
  counter += 1;
  const keyPrefix = `case-${counter}/`;
  const driver = new S3StorageDriver({
    bucket,
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
    keyPrefix,
    ...options.driver,
  });
  const storage = new Storage({ driver, now: () => 1700000000000, ...options.storage });
  t.after(async () => { await storage.close(); });
  return { driver, storage, keyPrefix };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = (s) => new TextEncoder().encode(s);

test('INT-7-1: put/get/head round-trip against real MinIO with SHA-256 integrity metadata', async (t) => {
  const { storage, keyPrefix } = harness(t);
  const content = bytes('sveltex s3 round trip');
  const meta = await storage.put('docs/readme.txt', content, {
    contentType: 'text/plain',
    custom: { owner: 'alice', team: 'core' },
  });
  assert.equal(meta.key, 'docs/readme.txt');
  assert.equal(meta.size, content.byteLength);
  assert.equal(meta.contentType, 'text/plain');
  assert.equal(meta.etag, sha256(content));
  assert.equal(meta.createdAt, 1700000000000);
  assert.deepEqual({ ...meta.custom }, { owner: 'alice', team: 'core' });
  assert.ok(Object.isFrozen(meta));

  // Independent SDK client proves the bytes really live in the object store.
  const raw = await admin.send(new GetObjectCommand({
    Bucket: bucket, Key: `${keyPrefix}docs/readme.txt`,
  }));
  const rawChunks = [];
  for await (const chunk of raw.Body) rawChunks.push(chunk);
  assert.deepEqual(Buffer.concat(rawChunks.map((c) => Buffer.from(c))), Buffer.from(content));
  assert.equal(raw.Metadata?.['sveltex-sha256'], sha256(content));
  assert.equal(raw.Metadata?.['owner'], 'alice');

  const head = await storage.head('docs/readme.txt');
  assert.equal(head.etag, meta.etag);
  assert.equal(head.createdAt, meta.createdAt);
  assert.equal(head.contentType, 'text/plain');
  assert.deepEqual({ ...head.custom }, { owner: 'alice', team: 'core' });

  const object = await storage.get('docs/readme.txt');
  assert.ok(object);
  assert.deepEqual(await collectStream(object.body), content);
});

test('INT-7-2: downloads stream large multi-chunk objects without buffering in the facade', async (t) => {
  const { storage } = harness(t);
  const chunks = [];
  for (let i = 0; i < 48; i += 1) chunks.push(new Uint8Array(32768).fill(i));
  const total = 48 * 32768;
  const stream = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  });
  const meta = await storage.put('media/large.bin', stream);
  assert.equal(meta.size, total);
  const object = await storage.get('media/large.bin');
  assert.ok(object);
  const out = await collectStream(object.body);
  assert.equal(out.byteLength, total);
  assert.equal(out[0], 0);
  assert.equal(out[47 * 32768], 47);
});

test('INT-7-3: list filters by prefix, resolves metadata and stays sorted', async (t) => {
  const { storage } = harness(t);
  await storage.put('users/b.txt', 'b');
  await storage.put('users/a.txt', 'a');
  await storage.put('other/c.txt', 'c');
  const all = await storage.list();
  assert.deepEqual(all.map((m) => m.key), ['other/c.txt', 'users/a.txt', 'users/b.txt']);
  const users = await storage.list('users/');
  assert.deepEqual(users.map((m) => m.key), ['users/a.txt', 'users/b.txt']);
  assert.equal(users[0].etag, sha256(bytes('a')));
  assert.ok(Object.isFrozen(all));
});

test('INT-7-4: delete reports existence and really removes the object from S3', async (t) => {
  const { storage, keyPrefix } = harness(t);
  await storage.put('temp.txt', 'x');
  assert.equal(await storage.delete('temp.txt'), true);
  assert.equal(await storage.delete('temp.txt'), false);
  assert.equal(await storage.get('temp.txt'), undefined);
  await assert.rejects(
    () => admin.send(new HeadObjectCommand({ Bucket: bucket, Key: `${keyPrefix}temp.txt` })),
    (error) => error.$metadata?.httpStatusCode === 404,
  );
});

test('INT-7-5: presigned GET downloads without credentials, rejects tampering and expiry', async (t) => {
  const { storage } = harness(t);
  const content = bytes('direct download');
  await storage.put('public.txt', content, { contentType: 'text/plain' });

  const req = await storage.presignGet('public.txt', { expiresInSeconds: 120 });
  assert.equal(req.method, 'GET');
  assert.ok(!req.url.includes(SECRET_KEY));
  const response = await fetch(req.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'direct download');

  const tampered = new URL(req.url);
  const signature = tampered.searchParams.get('X-Amz-Signature') ?? '';
  tampered.searchParams.set('X-Amz-Signature', (signature.startsWith('a') ? 'b' : 'a') + signature.slice(1));
  const bad = await fetch(tampered.toString());
  assert.equal(bad.status, 403);

  const short = await storage.presignGet('public.txt', { expiresInSeconds: 1 });
  await new Promise((resolve) => { setTimeout(resolve, 1600); });
  const expired = await fetch(short.url);
  assert.equal(expired.status, 403);
});

test('INT-7-6: presigned PUT uploads without credentials and is readable through the facade', async (t) => {
  const { storage, keyPrefix } = harness(t);
  const req = await storage.presignPut('uploads/avatar.png', {
    expiresInSeconds: 300,
    contentType: 'image/png',
    custom: { owner: 'bob' },
  });
  assert.equal(req.method, 'PUT');
  assert.equal(req.headers['content-type'], 'image/png');
  assert.ok(!req.url.includes(SECRET_KEY));

  const payload = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const response = await fetch(req.url, { method: 'PUT', headers: { ...req.headers }, body: payload });
  const putBody = await response.text();
  assert.equal(response.status, 200, putBody);

  // Objects written outside Storage.put expose the service ETag, not a SvelteX SHA-256.
  const meta = await storage.head('uploads/avatar.png');
  assert.ok(meta);
  assert.equal(meta.size, payload.byteLength);
  assert.equal(meta.contentType, 'image/png');
  assert.deepEqual({ ...meta.custom }, { owner: 'bob' });
  assert.ok(!/^[a-f0-9]{64}$/.test(meta.etag), 'external uploads must not claim a computed SHA-256');
  assert.ok(meta.etag.length > 0);

  const raw = await admin.send(new GetObjectCommand({ Bucket: bucket, Key: `${keyPrefix}uploads/avatar.png` }));
  const chunks = [];
  for await (const chunk of raw.Body) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks.map((c) => Buffer.from(c))), Buffer.from(payload));

  const wrongType = await fetch(req.url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: payload });
  assert.equal(wrongType.status, 403, 'a signed content-type must not be changeable');
});

test('INT-7-7: key traversal, size limits and reserved metadata are enforced against the real service', async (t) => {
  const { storage } = harness(t);
  for (const bad of ['../secret', '/etc/passwd', 'a//b', 'a\u0000b']) {
    await assert.rejects(() => storage.put(bad, 'x'), { name: 'StorageKeyError' });
    await assert.rejects(() => storage.presignGet(bad), { name: 'StorageKeyError' });
  }
  assert.ok(StorageKeyError);
  await assert.rejects(
    () => storage.put('safe.txt', 'x', { custom: { 'sveltex-sha256': 'forged' } }),
    { name: 'StorageValidationError' },
  );
  const limited = harness(t, { storage: { maxObjectSizeBytes: 8 } });
  await assert.rejects(() => limited.storage.put('big.txt', 'x'.repeat(9)), { name: 'StorageLimitError' });
  assert.ok(StorageLimitError);
});

test('INT-7-8: a missing bucket is reported as a diagnostic StorageIOError', async (t) => {
  const driver = new S3StorageDriver({
    bucket: `sveltex-missing-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
  });
  const storage = new Storage({ driver });
  t.after(async () => { await storage.close(); });
  await assert.rejects(
    () => storage.get('x.txt'),
    (error) => {
      assert.ok(error instanceof StorageIOError);
      assert.equal(error.name, 'StorageIOError');
      assert.equal(error.details.backend, 's3');
      assert.equal(error.details.operation, 'get');
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});

test('INT-7-9: objects persist across independent driver instances and key prefixes stay isolated', async (t) => {
  const first = harness(t);
  await first.storage.put('shared.txt', 'persisted', { contentType: 'text/plain' });
  const second = new S3StorageDriver({
    bucket,
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
    keyPrefix: first.keyPrefix,
  });
  const storage2 = new Storage({ driver: second });
  t.after(async () => { await storage2.close(); });
  const object = await storage2.get('shared.txt');
  assert.ok(object);
  assert.deepEqual(await collectStream(object.body), bytes('persisted'));

  const other = harness(t);
  assert.equal(await other.storage.get('shared.txt'), undefined);
  assert.ok(StorageIOError);
});

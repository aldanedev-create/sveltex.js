import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Storage,
  collectStream,
  validateKey,
  validatePrefix,
  normalizeContentType,
  normalizeCustom,
  StorageKeyError,
  StorageValidationError,
  StorageLimitError,
  StorageClosedError,
} from '../dist/index.js';
import { LocalStorageDriver } from '../dist/local.js';

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sveltex-storage-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const driver = new LocalStorageDriver({ root: dir });
  const storage = new Storage({ driver, ...options });
  return { dir, driver, storage };
}

const text = (s) => new TextEncoder().encode(s);

test('put/get/head round-trips bytes, size, contentType, etag and custom metadata', async (t) => {
  const { storage } = await harness(t);
  const meta = await storage.put('docs/readme.txt', 'hello world', {
    contentType: 'text/plain; charset=utf-8',
    custom: { author: 'alice', team: 'core' },
  });
  assert.equal(meta.key, 'docs/readme.txt');
  assert.equal(meta.size, 11);
  assert.equal(meta.contentType, 'text/plain; charset=utf-8');
  assert.match(meta.etag, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...meta.custom }, { author: 'alice', team: 'core' });
  assert.ok(Object.isFrozen(meta));
  assert.ok(Object.isFrozen(meta.custom));

  const head = await storage.head('docs/readme.txt');
  assert.deepEqual(head.etag, meta.etag);

  const obj = await storage.get('docs/readme.txt');
  assert.ok(obj);
  const bytes = await collectStream(obj.body);
  assert.equal(new TextDecoder().decode(bytes), 'hello world');
  await storage.close();
});

test('etag equals SHA-256 of the stored content', async (t) => {
  const { createHash } = await import('node:crypto');
  const { storage } = await harness(t);
  const body = text('integrity');
  const meta = await storage.put('a/b.bin', body);
  assert.equal(meta.etag, createHash('sha256').update(body).digest('hex'));
  await storage.close();
});

test('streaming put accepts a Web ReadableStream and a large multi-chunk body', async (t) => {
  const { storage } = await harness(t);
  const chunks = [];
  for (let i = 0; i < 64; i += 1) chunks.push(new Uint8Array(4096).fill(i));
  const stream = new ReadableStream({
    start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
  });
  const meta = await storage.put('large/blob', stream);
  assert.equal(meta.size, 64 * 4096);
  const obj = await storage.get('large/blob');
  const out = await collectStream(obj.body);
  assert.equal(out.length, 64 * 4096);
  assert.equal(out[0], 0);
  assert.equal(out[63 * 4096], 63);
  await storage.close();
});

test('overwriting a key atomically replaces content and etag', async (t) => {
  const { storage } = await harness(t);
  const first = await storage.put('file.txt', 'one');
  const second = await storage.put('file.txt', 'two-three');
  assert.notEqual(second.etag, first.etag);
  assert.equal(second.size, 9);
  const obj = await storage.get('file.txt');
  assert.equal(new TextDecoder().decode(await collectStream(obj.body)), 'two-three');
  await storage.close();
});

test('delete removes the object and reports whether it existed', async (t) => {
  const { storage } = await harness(t);
  await storage.put('x.txt', 'x');
  assert.equal(await storage.delete('x.txt'), true);
  assert.equal(await storage.delete('x.txt'), false);
  assert.equal(await storage.get('x.txt'), undefined);
  assert.equal(await storage.head('x.txt'), undefined);
  await storage.close();
});

test('list filters by prefix and returns sorted metadata', async (t) => {
  const { storage } = await harness(t);
  await storage.put('users/b.txt', 'b');
  await storage.put('users/a.txt', 'a');
  await storage.put('other/c.txt', 'c');
  const all = await storage.list();
  assert.deepEqual(all.map((m) => m.key), ['other/c.txt', 'users/a.txt', 'users/b.txt']);
  const users = await storage.list('users/');
  assert.deepEqual(users.map((m) => m.key), ['users/a.txt', 'users/b.txt']);
  await storage.close();
});

test('content is really persisted to disk (integration, not a fake)', async (t) => {
  const { dir, storage } = await harness(t);
  await storage.put('persist.txt', 'on-disk');
  const entries = await (await import('node:fs/promises')).readdir(join(dir, 'objects'));
  assert.ok(entries.some((e) => e.endsWith('.json')), 'metadata sidecar written');
  const jsonFiles = entries.filter((e) => e.endsWith('.json'));
  assert.equal(jsonFiles.length, 1);
  const meta = JSON.parse(await readFile(join(dir, 'objects', jsonFiles[0]), 'utf8'));
  assert.equal(meta.key, 'persist.txt');
  assert.equal(meta.size, 7);
  await storage.close();
});

test('validateKey rejects traversal, absolute paths and unsafe characters', () => {
  for (const bad of ['', '../secret', 'a/../b', '/etc/passwd', 'a//b', 'a\\b', 'a\u0000b', 'a/b/..', '.', 'x'.repeat(513)]) {
    assert.throws(() => validateKey(bad), { name: 'StorageKeyError' }, `must reject ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => validateKey('docs/2024/report_v2.pdf'));
  assert.doesNotThrow(() => validateKey('user@ex.com/avatar.png'));
});

test('validatePrefix rejects traversal but allows empty prefix', () => {
  assert.doesNotThrow(() => validatePrefix(''));
  assert.doesNotThrow(() => validatePrefix('users/'));
  assert.throws(() => validatePrefix('../'), { name: 'StorageKeyError' });
  assert.throws(() => validatePrefix('/abs'), { name: 'StorageKeyError' });
});

test('normalizeContentType defaults and rejects header injection', () => {
  assert.equal(normalizeContentType(undefined), 'application/octet-stream');
  assert.equal(normalizeContentType('application/json'), 'application/json');
  assert.throws(() => normalizeContentType('text/plain\r\nX-Injected: 1'), { name: 'StorageValidationError' });
  assert.throws(() => normalizeContentType('not-a-mime'), { name: 'StorageValidationError' });
  assert.throws(() => normalizeContentType(''.padEnd(300, 'a')), { name: 'StorageValidationError' });
});

test('normalizeCustom validates keys, values and byte budget', () => {
  assert.deepEqual({ ...normalizeCustom(undefined, 100) }, {});
  const frozen = normalizeCustom({ a: '1' }, 100);
  assert.ok(Object.isFrozen(frozen));
  assert.throws(() => normalizeCustom({ 'bad key': '1' }, 100), { name: 'StorageValidationError' });
  assert.throws(() => normalizeCustom({ a: 1 }, 100), { name: 'StorageValidationError' });
  assert.throws(() => normalizeCustom({ a: 'x\r\n' }, 100), { name: 'StorageValidationError' });
  assert.throws(() => normalizeCustom({ a: 'x'.repeat(10) }, 4), { name: 'StorageLimitError' });
  assert.throws(() => normalizeCustom(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])), 10000), { name: 'StorageValidationError' });
});

test('maxObjectSizeBytes rejects oversized streaming bodies', async (t) => {
  const { storage } = await harness(t, { maxObjectSizeBytes: 8 });
  await assert.rejects(
    () => storage.put('big', 'x'.repeat(9)),
    { name: 'StorageLimitError' },
  );
  // Facade remains usable after a rejected put.
  const meta = await storage.put('ok', '12345678');
  assert.equal(meta.size, 8);
  await storage.close();
});

test('close() is idempotent and rejects later operations', async (t) => {
  const { storage, driver } = await harness(t);
  await storage.close();
  await storage.close();
  assert.equal(storage.isClosed, true);
  assert.equal(driver.isClosed, true);
  await assert.rejects(() => storage.put('x', 'y'), { name: 'StorageClosedError' });
  await assert.rejects(() => storage.get('x'), { name: 'StorageClosedError' });
});

test('constructor validates driver and size limits', () => {
  assert.throws(() => new Storage({}), { name: 'StorageValidationError' });
  const driver = new LocalStorageDriver({ root: '/tmp/sveltex-never-used' });
  assert.throws(() => new Storage({ driver, maxObjectSizeBytes: 0 }), { name: 'StorageValidationError' });
  assert.throws(() => new Storage({ driver, maxCustomMetadataBytes: -1 }), { name: 'StorageValidationError' });
  assert.ok(StorageKeyError && StorageValidationError && StorageLimitError && StorageClosedError);
});

test('get on a missing key returns undefined', async (t) => {
  const { storage } = await harness(t);
  await storage.put('present', '1'); // ensure initialization
  assert.equal(await storage.get('missing'), undefined);
  assert.equal(await storage.head('missing'), undefined);
  await storage.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage, StorageKeyError, StorageIOError, collectStream } from '../../dist/index.js';
import { LocalStorageDriver } from '../../dist/local.js';

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sveltex-storage-sec-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const driver = new LocalStorageDriver({ root: dir });
  const storage = new Storage({ driver, ...options });
  return { dir, driver, storage };
}

test('SEC: path traversal keys never escape the root (no files written outside)', async (t) => {
  const { dir, storage } = await harness(t);
  await storage.put('safe.txt', 'ok');
  for (const evil of ['../escape.txt', 'a/../../escape.txt', '/absolute.txt', '..', 'a/./b']) {
    await assert.rejects(() => storage.put(evil, 'evil'), { name: 'StorageKeyError' });
  }
  // The parent temp dir must contain nothing from the traversal attempts.
  const { readdir } = await import('node:fs/promises');
  const parent = await readdir(dir);
  assert.deepEqual(parent, ['objects'], 'only the objects/ dir exists inside root');
  await storage.close();
});

test('SEC: keys are hashed to fixed filenames (no user-controlled path on disk)', async (t) => {
  const { dir, storage } = await harness(t);
  await assert.rejects(() => storage.put('docs/sub/../style.css', 'x'), { name: 'StorageKeyError' });
  await storage.put('docs/style.css', 'body{}');
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(dir, 'objects'));
  for (const f of files) assert.match(f, /^[a-f0-9]{64}(\.json)?$/, `unexpected on-disk name ${f}`);
  await storage.close();
});

test('SEC: symlinked objects directory is rejected to prevent writes escaping root', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sveltex-storage-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'sveltex-storage-outside-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(dir, 'objects'), { recursive: true }).catch(() => undefined);
  await rm(join(dir, 'objects'), { recursive: true, force: true });
  await symlink(outside, join(dir, 'objects'));
  const driver = new LocalStorageDriver({ root: dir });
  const storage = new Storage({ driver });
  await assert.rejects(() => storage.put('x', 'y'), { name: 'StorageIOError' });
});

test('SEC: MIME/contentType cannot inject headers or newlines', async (t) => {
  const { storage } = await harness(t);
  await assert.rejects(
    () => storage.put('x', 'y', { contentType: 'text/plain\r\nSet-Cookie: admin=1' }),
    { name: 'StorageValidationError' },
  );
  await storage.close();
});

test('SEC: custom metadata is bounded and cannot carry control characters', async (t) => {
  const { storage } = await harness(t);
  await assert.rejects(
    () => storage.put('x', 'y', { custom: { k: 'value\r\nX-Injected: 1' } }),
    { name: 'StorageValidationError' },
  );
  await storage.close();
});

test('SEC: max size is enforced even for streaming bodies (disk-exhaustion guard)', async (t) => {
  const { storage } = await harness(t, { maxObjectSizeBytes: 16 });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
      controller.enqueue(new Uint8Array(10));
      controller.close();
    },
  });
  await assert.rejects(() => storage.put('big', stream), { name: 'StorageLimitError' });
  await storage.close();
});

test('SEC: tampered metadata sidecar size mismatch is detected as an integrity error', async (t) => {
  const { dir, storage } = await harness(t);
  const meta = await storage.put('integrity.bin', '123456');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update('integrity.bin').digest('hex');
  const metaPath = join(dir, 'objects', `${hash}.json`);
  const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(metaPath, 'utf8'));
  parsed.size = 999; // simulate tampering/corruption
  await writeFile(metaPath, JSON.stringify(parsed));
  await assert.rejects(() => storage.head('integrity.bin'), { name: 'StorageIOError' });
  assert.equal(meta.size, 6);
  await storage.close();
});

test('SEC: a corrupt/orphaned sidecar does not fabricate an object', async (t) => {
  const { dir, storage } = await harness(t);
  await storage.put('present', 'p'); // init
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update('ghost').digest('hex');
  await writeFile(join(dir, 'objects', `${hash}.json`), '{not valid json');
  assert.equal(await storage.get('ghost'), undefined);
  await storage.close();
});

test('SEC: content read is streamed, not buffered into a giant array in the driver', async (t) => {
  const { storage } = await harness(t);
  await storage.put('s.bin', new Uint8Array(2048).fill(7));
  const obj = await storage.get('s.bin');
  assert.equal(typeof obj.body.getReader, 'function');
  const bytes = await collectStream(obj.body);
  assert.equal(bytes.length, 2048);
  await storage.close();
});

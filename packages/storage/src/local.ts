import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile, lstat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { StorageIOError, StorageKeyError, validateKey } from './index.js';
import type { ObjectMetadata, PutCommand, StorageDriver, StoredObject } from './index.js';

export interface LocalStorageDriverOptions {
  /** Directory that will contain the object store. Created if missing. */
  readonly root: string;
}

/** Convert a Node readable stream into a Web ReadableStream without buffering the whole file. */
function streamFromPath(path: string): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(path);
  const iterator = nodeStream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value as Uint8Array);
      } catch (error) {
        nodeStream.destroy();
        controller.error(error);
      }
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

/**
 * A real local-filesystem storage driver. Object content and metadata are written atomically
 * (temp file + rename). Keys are mapped to SHA-256 hex filenames so no user-controlled path is
 * ever used on disk. Metadata sidecars carry the original key, MIME type, size and SHA-256 etag.
 *
 * This is a single-process, local-disk driver. It is NOT an object store and provides no
 * cross-machine replication, no multi-writer locking guarantees, and no encryption at rest.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly #root: string;
  #objectsDir: string | undefined;
  #ready: Promise<string> | undefined;
  #closed = false;

  constructor(options: LocalStorageDriverOptions) {
    if (!options || typeof options.root !== 'string' || options.root.trim().length === 0) {
      throw new StorageKeyError('A non-empty root directory is required.');
    }
    this.#root = options.root;
  }

  get isClosed(): boolean { return this.#closed; }

  async #ensureReady(): Promise<string> {
    if (this.#closed) throw new StorageIOError('The storage driver is closed.');
    if (this.#objectsDir) return this.#objectsDir;
    if (!this.#ready) this.#ready = this.#init();
    return this.#ready;
  }

  async #init(): Promise<string> {
    await mkdir(this.#root, { recursive: true });
    const realRoot = await realpath(this.#root);
    const candidate = join(realRoot, 'objects');
    // Reject a pre-created symlink at the objects directory to prevent writes escaping the root.
    let linkCheck = true;
    try {
      const info = await lstat(candidate);
      linkCheck = !info.isSymbolicLink();
    } catch {
      linkCheck = true; // does not exist yet; we will create a real directory
    }
    if (!linkCheck) throw new StorageIOError('The objects directory must not be a symbolic link.');
    await mkdir(candidate, { recursive: true });
    const realObjects = await realpath(candidate);
    if (realObjects !== candidate && !realObjects.startsWith(candidate + sep)) {
      throw new StorageIOError('Resolved objects directory escapes the configured root.');
    }
    this.#objectsDir = realObjects;
    return realObjects;
  }

  #pathsFor(key: string): { readonly dir: string; readonly content: string; readonly meta: string } {
    const dir = this.#objectsDir;
    if (!dir) throw new StorageIOError('The storage driver is not initialized.');
    const hash = createHash('sha256').update(key).digest('hex');
    return { dir, content: join(dir, hash), meta: join(dir, `${hash}.json`) };
  }

  async put(command: PutCommand): Promise<ObjectMetadata> {
    // Defense in depth even though the facade already validates.
    validateKey(command.key);
    const dir = await this.#ensureReady();
    const { content, meta } = this.#pathsFor(command.key);
    const hash = createHash('sha256');
    let size = 0;
    const tmp = join(dir, `${createHash('sha256').update(command.key).digest('hex')}.${randomUUID()}.tmp`);
    const metaTmp = `${meta}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx');
    try {
      for await (const chunk of command.body) {
        hash.update(chunk);
        size += chunk.byteLength;
        await handle.write(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const etag = hash.digest('hex');
    const metadata: ObjectMetadata = Object.freeze({
      key: command.key,
      size,
      contentType: command.contentType,
      etag,
      createdAt: command.now,
      custom: Object.freeze({ ...command.custom }),
    });
    try {
      await writeFile(metaTmp, JSON.stringify(metadata), { flag: 'wx' });
      await rename(tmp, content); // atomic content swap
      await rename(metaTmp, meta); // publish metadata last
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      await rm(metaTmp, { force: true }).catch(() => undefined);
      throw new StorageIOError('Failed to commit the stored object.', { cause: error instanceof Error ? error : new Error(String(error)) });
    }
    return metadata;
  }

  async #readMeta(meta: string, content: string): Promise<ObjectMetadata | undefined> {
    let raw: string;
    try {
      raw = await readFile(meta, 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const m = parsed as Record<string, unknown>;
    if (
      typeof m['key'] !== 'string' || typeof m['size'] !== 'number' ||
      typeof m['contentType'] !== 'string' || typeof m['etag'] !== 'string' ||
      typeof m['createdAt'] !== 'number' || typeof m['custom'] !== 'object' || m['custom'] === null
    ) return undefined;
    // Integrity: verify the content file still matches the recorded size.
    let info;
    try {
      info = await stat(content);
    } catch {
      return undefined;
    }
    if (info.size !== m['size']) throw new StorageIOError('Stored object size does not match its metadata.');
    return Object.freeze({
      key: m['key'],
      size: m['size'],
      contentType: m['contentType'],
      etag: m['etag'],
      createdAt: m['createdAt'],
      custom: Object.freeze({ ...(m['custom'] as Record<string, string>) }),
    });
  }

  async head(key: string): Promise<ObjectMetadata | undefined> {
    validateKey(key);
    await this.#ensureReady();
    const { content, meta } = this.#pathsFor(key);
    return this.#readMeta(meta, content);
  }

  async get(key: string): Promise<StoredObject | undefined> {
    validateKey(key);
    await this.#ensureReady();
    const { content, meta } = this.#pathsFor(key);
    const metadata = await this.#readMeta(meta, content);
    if (!metadata) return undefined;
    return Object.freeze({ metadata, body: streamFromPath(content) });
  }

  async delete(key: string): Promise<boolean> {
    validateKey(key);
    await this.#ensureReady();
    const { content, meta } = this.#pathsFor(key);
    const existed = await this.#readMeta(meta, content).then((m) => m !== undefined).catch(() => false);
    await rm(meta, { force: true });
    await rm(content, { force: true });
    return existed;
  }

  async list(prefix = ''): Promise<readonly ObjectMetadata[]> {
    const dir = await this.#ensureReady();
    const entries = await readdir(dir);
    const result: ObjectMetadata[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const metaPath = join(dir, entry);
      const contentPath = metaPath.slice(0, -'.json'.length);
      const metadata = await this.#readMeta(metaPath, contentPath);
      if (metadata && metadata.key.startsWith(prefix)) result.push(metadata);
    }
    result.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return Object.freeze(result);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
  }
}

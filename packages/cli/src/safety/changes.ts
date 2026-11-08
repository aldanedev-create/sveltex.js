import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { ChangeReport, PlannedChange } from '../types/index.js';
import { CliError, usageError } from '../terminal/errors.js';
import { isInside } from './paths.js';

interface ChangeEntry {
  readonly content: string | null;
  previous: string | null;
  existed: boolean;
  applied: boolean;
}

/**
 * Tracks every CLI-owned file mutation so a multi-step command can preview,
 * apply atomically per file, and roll back if a later step fails.
 */
export class ChangeSet {
  readonly #root: string;
  readonly #entries = new Map<string, ChangeEntry>();
  #counter = 0;
  #applied = false;

  constructor(root: string) {
    this.#root = root;
  }

  get size(): number {
    return this.#entries.size;
  }

  #assertInside(absolutePath: string): void {
    if (!isInside(this.#root, absolutePath)) {
      throw usageError('Change target escapes the project root.', 'SX_CLI_PATH_TRAVERSAL');
    }
  }

  add(absolutePath: string, content: string): void {
    this.#assertInside(absolutePath);
    this.#entries.set(absolutePath, { content, previous: null, existed: false, applied: false });
  }

  remove(absolutePath: string): void {
    this.#assertInside(absolutePath);
    this.#entries.set(absolutePath, { content: null, previous: null, existed: false, applied: false });
  }

  plan(): readonly PlannedChange[] {
    const changes: PlannedChange[] = [];
    for (const [absolutePath, entry] of this.#entries) {
      const existed = existsSync(absolutePath);
      changes.push(Object.freeze({
        path: relative(this.#root, absolutePath).split('\\').join('/'),
        action: entry.content === null ? 'delete' : existed ? 'update' : 'create',
        bytes: entry.content === null ? 0 : Buffer.byteLength(entry.content, 'utf8'),
      }));
    }
    return Object.freeze(changes.sort((a, b) => a.path.localeCompare(b.path)));
  }

  async apply(): Promise<ChangeReport> {
    const plan = this.plan();
    const touched: string[] = [];
    try {
      for (const [absolutePath, entry] of this.#entries) {
        await this.#snapshot(absolutePath, entry);
        if (entry.content === null) {
          if (entry.existed) await unlink(absolutePath);
        } else {
          await mkdir(dirname(absolutePath), { recursive: true });
          this.#counter += 1;
          const tmp = `${absolutePath}.sveltex-tmp-${String(process.pid)}-${String(this.#counter)}`;
          await writeFile(tmp, entry.content, 'utf8');
          await rename(tmp, absolutePath);
        }
        entry.applied = true;
        touched.push(absolutePath);
      }
      this.#applied = true;
      return Object.freeze({ applied: true, changes: plan, rolledBack: false });
    } catch (cause) {
      await this.#restore(touched);
      throw new CliError('Failed to apply file changes; already-applied changes were rolled back.', {
        code: 'SX_CLI_APPLY_FAILED',
        cause,
        details: { applied: touched.length, total: this.#entries.size },
      });
    }
  }

  async #snapshot(absolutePath: string, entry: ChangeEntry): Promise<void> {
    try {
      entry.previous = await readFile(absolutePath, 'utf8');
      entry.existed = true;
    } catch {
      entry.previous = null;
      entry.existed = false;
    }
  }

  async rollback(): Promise<ChangeReport> {
    const plan = this.plan();
    if (!this.#applied) return Object.freeze({ applied: false, changes: plan, rolledBack: false });
    const touched = [...this.#entries.entries()]
      .filter(([, entry]) => entry.applied)
      .map(([absolutePath]) => absolutePath);
    await this.#restore(touched);
    this.#applied = false;
    return Object.freeze({ applied: false, changes: plan, rolledBack: true });
  }

  async #restore(paths: readonly string[]): Promise<void> {
    const failures: string[] = [];
    for (const absolutePath of [...paths].reverse()) {
      const entry = this.#entries.get(absolutePath);
      if (entry === undefined || !entry.applied) continue;
      try {
        if (!entry.existed || entry.previous === null) {
          if (existsSync(absolutePath)) await unlink(absolutePath);
        } else {
          await mkdir(dirname(absolutePath), { recursive: true });
          const tmp = `${absolutePath}.sveltex-rollback-${String(process.pid)}-${String(this.#counter += 1)}`;
          await writeFile(tmp, entry.previous, 'utf8');
          await rename(tmp, absolutePath);
        }
        entry.applied = false;
      } catch {
        failures.push(absolutePath);
      }
    }
    if (failures.length > 0) {
      throw new CliError(`Rollback could not restore ${String(failures.length)} file(s).`, {
        code: 'SX_CLI_ROLLBACK_INCOMPLETE',
        details: { paths: failures },
      });
    }
  }
}

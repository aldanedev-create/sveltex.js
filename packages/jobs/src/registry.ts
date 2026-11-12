import { JobsConfigurationError, JobsError } from './index.js';
import type { Job, JobContext, JobHandler } from './index.js';
import { validateJobName } from './validation.js';

/**
 * Registers named job handlers and produces a routing {@link JobHandler} for
 * `Worker`. An unregistered job name throws a typed `JobsError`, so the worker's
 * normal retry / dead-letter path applies instead of silently dropping work.
 */
export class JobRegistry {
  readonly #handlers = new Map<string, JobHandler>();

  register(name: string, handler: JobHandler): this {
    validateJobName(name);
    if (typeof handler !== 'function') throw new JobsConfigurationError('A handler function is required.');
    if (this.#handlers.has(name)) throw new JobsConfigurationError(`Job "${name}" is already registered.`);
    this.#handlers.set(name, handler);
    return this;
  }

  registerAll(handlers: Readonly<Record<string, JobHandler>>): this {
    if (!handlers || typeof handlers !== 'object') throw new JobsConfigurationError('A handler record is required.');
    for (const [name, handler] of Object.entries(handlers)) this.register(name, handler);
    return this;
  }

  has(name: string): boolean { return this.#handlers.has(name); }
  get(name: string): JobHandler | undefined { return this.#handlers.get(name); }
  names(): readonly string[] { return Object.freeze([...this.#handlers.keys()]); }
  get size(): number { return this.#handlers.size; }

  /** A single handler that dispatches by `job.name`. Safe to share across workers. */
  createHandler(): JobHandler {
    return async (job: Job, context: JobContext): Promise<void> => {
      const handler = this.#handlers.get(job.name);
      if (handler === undefined) {
        throw new JobsError('SX_JOBS_UNREGISTERED', `No handler is registered for job "${job.name}".`);
      }
      await handler(job, context);
    };
  }
}

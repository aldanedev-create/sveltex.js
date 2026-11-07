import type { ModuleDefinition, ModuleContext } from '../modules/module.types.js';
import type { SvelteXConfig } from '../config/config.types.js';
import type { Container } from '../container/container.js';
import { SvelteXAggregateError } from '../errors/aggregate-error.js';
import { asError } from '../errors/framework-error.js';

export class LifecycleManager {
  readonly #config: SvelteXConfig;
  readonly #container: Container;
  readonly #started: ModuleDefinition[] = [];
  constructor(config: SvelteXConfig, container: Container) { this.#config = config; this.#container = container; }
  get startedModules(): readonly ModuleDefinition[] { return Object.freeze([...this.#started]); }

  async start(modules: readonly ModuleDefinition[]): Promise<void> {
    try {
      for (const module of modules) {
        // Include the current module before invoking onStart so its onStop can undo partial setup.
        this.#started.push(module);
        await module.onStart?.(this.#context(module));
      }
    } catch (startupError) {
      const rollbackErrors = await this.#stopModules();
      try { await this.#container.dispose(); } catch (error) { rollbackErrors.push(asError(error)); }
      if (rollbackErrors.length) {
        throw new SvelteXAggregateError('Application startup failed and rollback reported additional errors.', [startupError, ...rollbackErrors]);
      }
      throw startupError;
    }
  }

  async stop(): Promise<void> {
    const errors = await this.#stopModules();
    try { await this.#container.dispose(); } catch (error) { errors.push(asError(error)); }
    if (errors.length) throw new SvelteXAggregateError('Application shutdown completed with cleanup errors.', errors);
  }

  async #stopModules(): Promise<Error[]> {
    const errors: Error[] = [];
    for (const module of [...this.#started].reverse()) {
      try { await module.onStop?.(this.#context(module)); } catch (error) { errors.push(asError(error)); }
    }
    this.#started.length = 0;
    return errors;
  }

  #context(module: ModuleDefinition): ModuleContext {
    return Object.freeze({ config: this.#config, container: this.#container, moduleName: module.name });
  }
}

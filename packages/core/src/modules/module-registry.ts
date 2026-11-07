import { SvelteXError } from '../errors/framework-error.js';
import type { ModuleDefinition } from './module.types.js';
import { defineModule } from './define-module.js';
import { orderModules } from './dependency-graph.js';

export class ModuleRegistry {
  readonly #modules = new Map<string, ModuleDefinition>();
  #locked = false;
  register(module: ModuleDefinition): this {
    if (this.#locked) throw new SvelteXError('SX_APP_INVALID_STATE', 'Modules cannot be registered after application startup begins.');
    const normalized = defineModule(module);
    if (this.#modules.has(normalized.name)) throw new SvelteXError('SX_MODULE_DUPLICATE', `Module "${normalized.name}" is already registered.`);
    this.#modules.set(normalized.name, normalized);
    return this;
  }
  lock(): void { this.#locked = true; }
  all(): readonly ModuleDefinition[] { return Object.freeze([...this.#modules.values()]); }
  ordered(): readonly ModuleDefinition[] { return orderModules(this.all()); }
  get(name: string): ModuleDefinition | undefined { return this.#modules.get(name); }
}

import {
  DatabaseAdapterError,
  validateAdapterDefinition,
  type DatabaseAdapter,
  type DatabaseAdapterCapabilities,
} from '../contracts/adapter.js';

/**
 * Registry of named database adapters. Supports multiple connections and
 * capability-based discovery. Registration validates each adapter definition
 * up front so a broken adapter is rejected before any connection is opened.
 *
 * @public
 */
export class AdapterRegistry {
  readonly #adapters = new Map<string, DatabaseAdapter<unknown>>();

  register<Client>(adapter: DatabaseAdapter<Client>): this {
    validateAdapterDefinition(adapter);
    if (this.#adapters.has(adapter.name)) {
      throw new DatabaseAdapterError(`An adapter named "${adapter.name}" is already registered.`, 'DATABASE_ADAPTER_DUPLICATE');
    }
    this.#adapters.set(adapter.name, adapter as unknown as DatabaseAdapter<unknown>);
    return this;
  }

  registerMany(adapters: readonly DatabaseAdapter<unknown>[]): this {
    for (const adapter of adapters) this.register(adapter);
    return this;
  }

  get<Client = unknown>(name: string): DatabaseAdapter<Client> | undefined {
    return this.#adapters.get(name) as DatabaseAdapter<Client> | undefined;
  }

  require<Client = unknown>(name: string): DatabaseAdapter<Client> {
    const adapter = this.#adapters.get(name);
    if (adapter === undefined) {
      throw new DatabaseAdapterError(`No adapter named "${name}" is registered.`, 'DATABASE_ADAPTER_NOT_FOUND');
    }
    return adapter as unknown as DatabaseAdapter<Client>;
  }

  has(name: string): boolean { return this.#adapters.has(name); }

  /** Adapters declaring a given capability. */
  matching(capability: keyof DatabaseAdapterCapabilities): readonly DatabaseAdapter<unknown>[] {
    const out: DatabaseAdapter<unknown>[] = [];
    for (const adapter of this.#adapters.values()) {
      if (adapter.capabilities[capability]) out.push(adapter);
    }
    return Object.freeze(out);
  }

  names(): readonly string[] { return Object.freeze([...this.#adapters.keys()]); }
  get size(): number { return this.#adapters.size; }
  unregister(name: string): boolean { return this.#adapters.delete(name); }
  clear(): void { this.#adapters.clear(); }
}

/** Create an isolated adapter registry. @public */
export function createAdapterRegistry(): AdapterRegistry { return new AdapterRegistry(); }

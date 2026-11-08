/**
 * Bring-Your-Own-ORM adapter contract for `@sveltex/database`.
 *
 * This layer is deliberately separate from the raw-SQL `DatabaseDriver` layer.
 * SvelteX provides integrations, not a replacement ORM: the `client` held in a
 * `DatabaseAdapterContext` is the *native* ORM/query-builder object and is never
 * wrapped or hidden. ORM-specific behaviour (queries, migrations, dialect
 * quirks) stays with the ORM; common lifecycle behaviour stays with SvelteX.
 *
 * @public
 */

/** Error raised for adapter definition, lifecycle, and capability violations. */
export class DatabaseAdapterError extends Error {
  readonly code: string;
  constructor(message: string, code = 'DATABASE_ADAPTER', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DatabaseAdapterError';
    this.code = code;
  }
}

/**
 * Free-form, immutable configuration passed to `connect()`. SvelteX does not
 * reinterpret it: adapter authors decide which keys they support. This keeps
 * native ORM configuration intact.
 */
export type DatabaseAdapterConfig = Readonly<Record<string, unknown>>;

/** A connected, adapter-owned context. `client` is the native ORM object. */
export interface DatabaseAdapterContext<Client = unknown> {
  readonly client: Client;
  readonly config: DatabaseAdapterConfig;
  readonly adapter: string;
}

/** Optional capabilities an adapter may declare. Absent = not supported. */
export interface DatabaseAdapterCapabilities {
  readonly transactions: boolean;
  readonly savepoints: boolean;
  readonly healthCheck: boolean;
  readonly migrations: boolean;
}

export const DEFAULT_ADAPTER_CAPABILITIES: DatabaseAdapterCapabilities = Object.freeze({
  transactions: false,
  savepoints: false,
  healthCheck: false,
  migrations: false,
});

/** Direction/status request for the ORM's own migration system. */
export type MigrationAction = 'status' | 'up' | 'down';
export interface MigrationRequest {
  readonly action: MigrationAction;
  readonly target?: string;
}
/**
 * Adapter-supplied migration result. SvelteX never runs a competing migration
 * engine: `migrate()` must delegate to the ORM's authoritative migrator.
 */
export interface MigrationStatus {
  readonly action: MigrationAction;
  readonly applied: number;
  readonly pending: number;
  readonly detail?: string;
}

export interface DatabaseAdapterDefinition<Client = unknown> {
  readonly name: string;
  readonly capabilities?: Partial<DatabaseAdapterCapabilities>;
  connect(config: DatabaseAdapterConfig): Promise<DatabaseAdapterContext<Client>>;
  disconnect(context: DatabaseAdapterContext<Client>): Promise<void>;
  healthCheck?(context: DatabaseAdapterContext<Client>): Promise<boolean>;
  transaction?<T>(
    context: DatabaseAdapterContext<Client>,
    callback: (tx: DatabaseAdapterContext<Client>) => Promise<T>,
  ): Promise<T>;
  /** Optional hook that delegates to the ORM's native migration tooling. */
  migrate?(context: DatabaseAdapterContext<Client>, request?: MigrationRequest): Promise<MigrationStatus>;
}

/** A validated, frozen adapter with fully resolved capabilities. */
export interface DatabaseAdapter<Client = unknown> extends DatabaseAdapterDefinition<Client> {
  readonly capabilities: DatabaseAdapterCapabilities;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAPABILITY_KEYS: readonly (keyof DatabaseAdapterCapabilities)[] = Object.freeze([
  'transactions',
  'savepoints',
  'healthCheck',
  'migrations',
]);

/** Validate an adapter definition. Throws `TypeError` for malformed input. */
export function validateAdapterDefinition(definition: DatabaseAdapterDefinition<unknown>): void {
  if (definition === null || typeof definition !== 'object') throw new TypeError('An adapter definition object is required.');
  if (typeof definition.name !== 'string' || !NAME_PATTERN.test(definition.name)) {
    throw new TypeError('Adapter name must match /^[a-z0-9][a-z0-9._-]{0,63}$/.');
  }
  if (typeof definition.connect !== 'function') throw new TypeError('Adapter connect(config) must be a function.');
  if (typeof definition.disconnect !== 'function') throw new TypeError('Adapter disconnect(context) must be a function.');
  if (definition.healthCheck !== undefined && typeof definition.healthCheck !== 'function') throw new TypeError('Adapter healthCheck must be a function.');
  if (definition.transaction !== undefined && typeof definition.transaction !== 'function') throw new TypeError('Adapter transaction must be a function.');
  if (definition.migrate !== undefined && typeof definition.migrate !== 'function') throw new TypeError('Adapter migrate must be a function.');

  const caps = definition.capabilities ?? {};
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) throw new TypeError('Adapter capabilities must be an object.');
  for (const [key, value] of Object.entries(caps)) {
    if (!CAPABILITY_KEYS.includes(key as keyof DatabaseAdapterCapabilities)) throw new TypeError(`Unknown adapter capability: ${key}`);
    if (typeof value !== 'boolean') throw new TypeError(`Adapter capability "${key}" must be a boolean.`);
  }
  if (caps.transactions === true && typeof definition.transaction !== 'function') {
    throw new TypeError('Adapter declares the transactions capability but has no transaction() implementation.');
  }
  if (caps.healthCheck === true && typeof definition.healthCheck !== 'function') {
    throw new TypeError('Adapter declares the healthCheck capability but has no healthCheck() implementation.');
  }
  if (caps.migrations === true && typeof definition.migrate !== 'function') {
    throw new TypeError('Adapter declares the migrations capability but has no migrate() implementation.');
  }
  if (caps.savepoints === true) {
    if (caps.transactions === false) throw new TypeError('Adapter declares savepoints without transactions.');
    if (typeof definition.transaction !== 'function') throw new TypeError('Adapter declares savepoints but has no transaction() implementation.');
  }
}

function resolveCapabilities(definition: DatabaseAdapterDefinition<unknown>): DatabaseAdapterCapabilities {
  const c = definition.capabilities ?? {};
  return Object.freeze({
    transactions: c.transactions ?? (typeof definition.transaction === 'function'),
    savepoints: c.savepoints ?? false,
    healthCheck: c.healthCheck ?? (typeof definition.healthCheck === 'function'),
    migrations: c.migrations ?? (typeof definition.migrate === 'function'),
  });
}

/** Define a validated, frozen database adapter (BYO ORM entry point). */
export function defineDatabaseAdapter<Client = unknown>(
  definition: DatabaseAdapterDefinition<Client>,
): DatabaseAdapter<Client> {
  validateAdapterDefinition(definition as DatabaseAdapterDefinition<unknown>);
  const capabilities = resolveCapabilities(definition as DatabaseAdapterDefinition<unknown>);
  return Object.freeze({
    name: definition.name,
    capabilities,
    connect: definition.connect,
    disconnect: definition.disconnect,
    ...(definition.healthCheck === undefined ? {} : { healthCheck: definition.healthCheck }),
    ...(definition.transaction === undefined ? {} : { transaction: definition.transaction }),
    ...(definition.migrate === undefined ? {} : { migrate: definition.migrate }),
  }) as DatabaseAdapter<Client>;
}

/** Helper for adapter authors: build a frozen, well-formed context. */
export function defineAdapterContext<Client>(
  adapter: string,
  client: Client,
  config: DatabaseAdapterConfig,
): DatabaseAdapterContext<Client> {
  if (typeof adapter !== 'string' || adapter === '') throw new TypeError('An adapter name is required.');
  if (client === undefined || client === null) throw new TypeError('A native client is required.');
  return Object.freeze({ adapter, client, config: Object.freeze({ ...config }) });
}

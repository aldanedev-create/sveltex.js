import type { DatabaseAdapterConfig } from '../contracts/adapter.js';

/** Default prefix for environment-derived database configuration. */
export const DEFAULT_ENV_PREFIX = 'SVELTEX_DB_';

const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|credential|private|connection[-_]?string|url|uri|dsn)/i;

export interface DatabaseEnvironmentOptions {
  /** Environment variable prefix (default: `SVELTEX_DB_`). */
  readonly prefix?: string;
  /** Environment source (default: `process.env`). Injectable for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Explicit keys to read, without the prefix. When omitted, every variable
   * starting with the prefix is collected. Keys are normalised to
   * lowerCamelCase from `UPPER_SNAKE_CASE`.
   */
  readonly keys?: readonly string[];
}

function normaliseKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/([a-z0-9])_([a-z0-9])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

/**
 * Build an immutable config from environment variables. Values stay strings;
 * adapters decide how to interpret them. Nothing here connects to a database.
 */
export function configFromEnv(options: DatabaseEnvironmentOptions = {}): DatabaseAdapterConfig {
  const prefix = options.prefix ?? DEFAULT_ENV_PREFIX;
  if (typeof prefix !== 'string' || prefix.trim() === '') throw new TypeError('An environment prefix must be a non-empty string.');
  const env = options.env ?? process.env;
  const result: Record<string, unknown> = {};

  if (options.keys !== undefined) {
    for (const key of options.keys) {
      if (typeof key !== 'string' || key === '') throw new TypeError('Environment keys must be non-empty strings.');
      const envKey = prefix + key;
      const value = env[envKey];
      if (value !== undefined) result[normaliseKey(key)] = value;
    }
  } else {
    for (const [envKey, value] of Object.entries(env)) {
      if (!envKey.startsWith(prefix) || value === undefined) continue;
      const short = envKey.slice(prefix.length);
      if (short === '') continue;
      result[normaliseKey(short)] = value;
    }
  }
  return Object.freeze(result);
}

/** Read a single connection string from the environment. */
export function connectionStringFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  keys: readonly string[] = ['SVELTEX_DATABASE_URL', 'DATABASE_URL'],
): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** Produce a redacted, log-safe view of a config. Never returns secret values. */
export function redactConfig(config: DatabaseAdapterConfig): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : String(value);
  }
  return Object.freeze(out);
}

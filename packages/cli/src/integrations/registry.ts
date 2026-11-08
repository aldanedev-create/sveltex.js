/** Version of every official package in this release. A test verifies this matches the workspace manifests. */
export const SVELTEX_PACKAGE_VERSION = '0.1.0';

export interface IntegrationSpec {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  readonly adapters: readonly string[];
  readonly envNames: readonly string[];
  readonly configHint: string;
  readonly processLocalOnly: boolean;
  readonly developmentOnly: boolean;
}

function spec(entry: IntegrationSpec): IntegrationSpec {
  return Object.freeze({
    ...entry,
    adapters: Object.freeze(entry.adapters),
    envNames: Object.freeze(entry.envNames),
  });
}

/**
 * Only packages that actually exist in this monorepo are listed. Providers that
 * are not shipped (SMTP, S3, WebSocket, hosted Redis, ...) are never advertised.
 */
export const INTEGRATIONS: readonly IntegrationSpec[] = Object.freeze([
  spec({
    id: 'core', packageName: '@sveltex/core', version: SVELTEX_PACKAGE_VERSION,
    description: 'Application, container, DI tokens, modules, and lifecycle',
    adapters: [], envNames: [],
    configHint: 'Create the application in src/lib/server/sveltex.ts and register modules in sveltex.config.ts.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'shared', packageName: '@sveltex/shared', version: SVELTEX_PACKAGE_VERSION,
    description: 'Shared errors, guards, cloning and freezing helpers',
    adapters: [], envNames: [], configHint: 'No application wiring required.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'config', packageName: '@sveltex/config', version: SVELTEX_PACKAGE_VERSION,
    description: 'Immutable configuration composition and validation',
    adapters: [], envNames: [], configHint: 'Use defineConfig in sveltex.config.ts.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'sveltekit', packageName: '@sveltex/sveltekit', version: SVELTEX_PACKAGE_VERSION,
    description: 'SvelteKit Handle adapter for SvelteX applications',
    adapters: [], envNames: [],
    configHint: 'Compose createSvelteXHandler with SvelteKit sequence() in src/hooks.server.ts.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'validation', packageName: '@sveltex/validation', version: SVELTEX_PACKAGE_VERSION,
    description: 'Standard Schema v1 validation contracts',
    adapters: [], envNames: [], configHint: 'Wire schemas into request handlers; no global config needed.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'database', packageName: '@sveltex/database', version: SVELTEX_PACKAGE_VERSION,
    description: 'Database contracts plus a real node:sqlite adapter',
    adapters: ['@sveltex/database/sqlite'], envNames: [],
    configHint: 'Instantiate SqliteAdapter explicitly; requires Node >= 22.5 for node:sqlite.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'auth', packageName: '@sveltex/auth', version: SVELTEX_PACKAGE_VERSION,
    description: 'Authentication service plus a real Argon2id hasher',
    adapters: ['@sveltex/auth/argon2'], envNames: [],
    configHint: 'Provide a PasswordHasher and a user store; roles are never accepted from user input.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'cache', packageName: '@sveltex/cache', version: SVELTEX_PACKAGE_VERSION,
    description: 'Cache contracts, in-memory cache, and a real Redis adapter',
    adapters: ['@sveltex/cache/redis'], envNames: ['REDIS_URL'],
    configHint: 'The Redis adapter needs REDIS_URL. The default in-memory cache is process-local only.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'session', packageName: '@sveltex/session', version: SVELTEX_PACKAGE_VERSION,
    description: 'Session manager plus a real Redis-backed session store',
    adapters: ['@sveltex/session/redis'], envNames: ['REDIS_URL'],
    configHint: 'The Redis store needs REDIS_URL. The default in-memory store is process-local only.',
    processLocalOnly: false, developmentOnly: false,
  }),
  spec({
    id: 'realtime', packageName: '@sveltex/realtime', version: SVELTEX_PACKAGE_VERSION,
    description: 'Typed channels, authorization hooks, and an in-process transport',
    adapters: ['@sveltex/realtime/in-process'], envNames: [],
    configHint: 'InProcessTransport is process-local; no WebSocket/SSE provider is shipped.',
    processLocalOnly: true, developmentOnly: false,
  }),
  spec({
    id: 'jobs', packageName: '@sveltex/jobs', version: SVELTEX_PACKAGE_VERSION,
    description: 'Job queue contracts, retries, backoff, and an in-memory queue',
    adapters: ['@sveltex/jobs/in-memory'], envNames: [],
    configHint: 'InMemoryJobQueue is not durable or distributed; use a durable adapter for production.',
    processLocalOnly: true, developmentOnly: false,
  }),
  spec({
    id: 'storage', packageName: '@sveltex/storage', version: SVELTEX_PACKAGE_VERSION,
    description: 'Storage contracts with a real local-filesystem driver',
    adapters: ['@sveltex/storage/local'], envNames: [],
    configHint: 'LocalStorageDriver writes to local disk; no S3/object-store provider is shipped.',
    processLocalOnly: true, developmentOnly: false,
  }),
  spec({
    id: 'mail', packageName: '@sveltex/mail', version: SVELTEX_PACKAGE_VERSION,
    description: 'Mail contracts, safe templates, retries, and a deterministic test transport',
    adapters: ['@sveltex/mail/test-transport'], envNames: [],
    configHint: 'No SMTP/HTTP provider is shipped. Supply a MailTransport implementation.',
    processLocalOnly: true, developmentOnly: false,
  }),
  spec({
    id: 'testing', packageName: '@sveltex/testing', version: SVELTEX_PACKAGE_VERSION,
    description: 'Test builders over the real core DI container, fakes, and fixtures',
    adapters: [], envNames: [], configHint: 'Install as a dev dependency for tests.',
    processLocalOnly: false, developmentOnly: true,
  }),
]);

export function integrationIds(): readonly string[] {
  return Object.freeze(INTEGRATIONS.map((entry) => entry.id));
}

export function getIntegration(id: string): IntegrationSpec | undefined {
  return INTEGRATIONS.find((entry) => entry.id === id || entry.packageName === id);
}

export function dependencySpec(entry: IntegrationSpec): string {
  return `${entry.packageName}@^${entry.version}`;
}

export function resolveIntegrations(ids: readonly string[]): { readonly found: readonly IntegrationSpec[]; readonly unknown: readonly string[] } {
  const found: IntegrationSpec[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const entry = getIntegration(id);
    if (entry === undefined) unknown.push(id);
    else if (!found.includes(entry)) found.push(entry);
  }
  return Object.freeze({ found: Object.freeze(found), unknown: Object.freeze(unknown) });
}

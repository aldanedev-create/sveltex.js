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
 * Only packages that actually exist in this monorepo are listed, and `adapters`
 * lists only their real in-package subpath exports (checked against each package's
 * `exports` map). Hosted providers and integrations that do not exist are never
 * invented or advertised; the shipped adapters are self-hosted clients configured
 * by the application (SMTP server, S3 endpoint, Redis URL, ...), not hosted services.
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
    description: 'Typed channels, authorization hooks, real WebSocket/SSE gateways, and an in-process transport',
    adapters: ['@sveltex/realtime/in-process', '@sveltex/realtime/websocket', '@sveltex/realtime/sse', '@sveltex/realtime/protocol', '@sveltex/realtime/connection'], envNames: [],
    configHint: 'WebSocket (@sveltex/realtime/websocket) and SSE (@sveltex/realtime/sse) gateways are real but single-process fan-out; no cross-instance broker is shipped. InProcessTransport is in-memory.',
    processLocalOnly: true, developmentOnly: false,
  }),
  spec({
    id: 'jobs', packageName: '@sveltex/jobs', version: SVELTEX_PACKAGE_VERSION,
    description: 'Job queue contracts, retries, backoff, in-memory and real Redis/SQL durable queues',
    adapters: ['@sveltex/jobs/in-memory', '@sveltex/jobs/redis', '@sveltex/jobs/sql', '@sveltex/jobs/registry', '@sveltex/jobs/scheduler'], envNames: [],
    configHint: 'InMemoryJobQueue is process-local; RedisJobQueue (@sveltex/jobs/redis) and SqlJobQueue (@sveltex/jobs/sql) are real durable queues verified against Redis 7 / PostgreSQL 16.',
    processLocalOnly: true, developmentOnly: false,
  }),
  spec({
    id: 'storage', packageName: '@sveltex/storage', version: SVELTEX_PACKAGE_VERSION,
    description: 'Storage facade with real local-filesystem and S3-compatible drivers plus SigV4 presigned URLs',
    adapters: ['@sveltex/storage/local', '@sveltex/storage/s3'], envNames: [],
    configHint: 'LocalStorageDriver writes to local disk; S3StorageDriver (@sveltex/storage/s3) targets AWS S3 or S3-compatible services with real SigV4 presigned GET/PUT.',
    processLocalOnly: true, developmentOnly: false,
  }),
  spec({
    id: 'mail', packageName: '@sveltex/mail', version: SVELTEX_PACKAGE_VERSION,
    description: 'Mail contracts, attachments, MIME serialization, real SMTP/HTTP adapters, templates, retries, and a deterministic test transport',
    adapters: ['@sveltex/mail/test-transport', '@sveltex/mail/smtp', '@sveltex/mail/http', '@sveltex/mail/mime', '@sveltex/mail/auth'], envNames: [],
    configHint: 'SmtpTransport (@sveltex/mail/smtp) and HttpTransport (@sveltex/mail/http) are real providers; @sveltex/mail/auth wires auth workflows. TestTransport is in-memory for tests only.',
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

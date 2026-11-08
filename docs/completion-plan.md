# SvelteX — Existing Package Completion Plan

## Objective

Complete and production-harden the existing SvelteX packages before introducing additional framework packages or expanding the CLI ecosystem.

The priority is to finish what SvelteX already promises, ensure packages work together reliably, and establish a consistent developer experience.

**Core rule:** Do not add new packages until the existing packages have completed their required implementations, tests, documentation, and release audits.

---

# Phase 0 — Audit Existing Packages

Before implementation, inspect every existing package.

### Tasks

- [ ] Review every package's current implementation.
- [ ] Identify missing functionality.
- [ ] Identify incomplete or placeholder implementations.
- [ ] Review public APIs and package exports.
- [ ] Review dependencies and optional peer dependencies.
- [ ] Review TypeScript types and compatibility.
- [ ] Identify duplicated functionality across packages.
- [ ] Review existing tests and identify missing coverage.
- [ ] Review documentation against actual implementation.
- [ ] Verify package builds and exports.
- [ ] Identify integration problems between packages.

### Deliverable

A package-by-package implementation checklist based on the actual repository state.

Do not assume a feature is complete merely because it appears in the documentation.

---

# Phase 1 — Database

Package: `@sveltex/database`

## Objective

Build a unified database integration layer that provides built-in ORM integrations while allowing developers to bring their own ORM.

SvelteX should not become another ORM. It should make database integration consistent across the framework without restricting developers to one ORM or query builder.

## 1.1 Database foundation

- [ ] Database configuration.
- [ ] Connection lifecycle management.
- [ ] Connection initialization and shutdown.
- [ ] Health checks.
- [ ] Connection error handling.
- [ ] Environment-based configuration.
- [ ] Multiple database connections.
- [ ] Graceful shutdown.
- [ ] Resource cleanup.
- [ ] Consistent TypeScript contracts.

## 1.2 Built-in ORM integrations

Provide official integrations through optional dependencies.

Initial integration priorities:

| ORM | Priority |
|---|---|
| Drizzle ORM | First |
| Prisma | Second |
| MikroORM | Subsequent |
| TypeORM | Subsequent |

Also consider Kysely as a supported integration. It is a type-safe SQL query builder rather than a traditional ORM.

Requirements:

- [ ] Each integration has its own adapter.
- [ ] Each integration preserves its native API.
- [ ] Each integration supports its own configuration.
- [ ] Each integration handles connection initialization and cleanup.
- [ ] Each integration exposes transaction capabilities where supported.
- [ ] Each integration handles errors consistently.
- [ ] Each integration has appropriate TypeScript types.
- [ ] Each integration has integration tests.
- [ ] Each integration has documentation and working examples.

Do not require developers to install every ORM when installing `@sveltex/database`.

## 1.3 Bring Your Own ORM (BYO ORM)

Developers must be able to integrate an ORM that SvelteX does not officially support.

Provide a public adapter contract and registration mechanism.

The adapter contract should define the common capabilities SvelteX needs, including:

- Connection initialization.
- Connection shutdown.
- Health checks.
- Transaction support where available.
- Configuration and lifecycle handling.
- Optional capabilities and feature detection.
- Error handling.

Example API concept:

```ts
import { defineDatabaseAdapter } from "@sveltex/database";

export const myOrmAdapter = defineDatabaseAdapter({
  name: "my-orm",

  async connect(config) {
    // Initialize the ORM.
  },

  async disconnect(context) {
    // Close ORM connections.
  },

  async healthCheck(context) {
    // Check database availability.
    return true;
  },

  async transaction(context, callback) {
    // Execute a transaction.
  },
});
```

This is an illustrative API shape; finalize the actual contract after reviewing the existing package architecture.

Requirements:

- [ ] Public adapter definition API.
- [ ] Adapter registration.
- [ ] Adapter configuration validation.
- [ ] Adapter lifecycle management.
- [ ] Optional capability declarations.
- [ ] Transaction capability support.
- [ ] Adapter error handling.
- [ ] Adapter conformance test utilities.
- [ ] Documentation for creating custom adapters.
- [ ] A working custom ORM integration example.

Do not assume every ORM has identical transaction, connection, or migration behavior.

## 1.4 Migrations

- [ ] Migration integration.
- [ ] Migration status.
- [ ] Migration execution.
- [ ] Rollback support where the ORM supports it.
- [ ] Migration error reporting.
- [ ] Migration documentation.

The ORM's migration system should remain authoritative. SvelteX may provide unified CLI integration later, but should not introduce a competing migration engine unnecessarily.

## 1.5 Database providers

Support common database providers through the selected ORM integrations.

Prioritize:

- SQLite.
- PostgreSQL.
- MySQL.

Avoid duplicating database-driver functionality already provided by the selected ORM.

## 1.6 Transactions and reliability

- [ ] Transaction support.
- [ ] Nested transactions or savepoints where supported.
- [ ] Transaction rollback.
- [ ] Connection failure handling.
- [ ] Concurrent request safety.
- [ ] Connection cleanup after errors.
- [ ] Correct behavior during application shutdown.

## 1.7 Database testing

- [ ] Shared adapter conformance tests.
- [ ] Built-in adapter tests.
- [ ] Custom adapter tests.
- [ ] Connection lifecycle tests.
- [ ] Transaction tests.
- [ ] Failure and recovery tests.
- [ ] Integration tests with supported databases.
- [ ] TypeScript declaration tests.
- [ ] Package export tests.

### Database architecture rules

1. SvelteX provides integrations, not a replacement ORM.
2. Native ORM APIs remain accessible.
3. ORM integrations are optional dependencies.
4. Custom ORM adapters are first-class.
5. Common lifecycle behavior belongs to SvelteX.
6. ORM-specific behavior remains with the ORM.
7. Migrations remain compatible with the ORM's own migration system.
8. Every official adapter must pass shared conformance tests.

### Suggested package structure

```text
packages/database/
├── src/
│   ├── adapters/
│   │   ├── drizzle/
│   │   ├── prisma/
│   │   ├── mikro-orm/
│   │   └── typeorm/
│   ├── contracts/
│   │   ├── adapter.ts
│   │   ├── connection.ts
│   │   └── transaction.ts
│   ├── core/
│   │   ├── database.ts
│   │   ├── lifecycle.ts
│   │   └── registry.ts
│   ├── testing/
│   └── index.ts
├── tests/
│   ├── adapters/
│   ├── contracts/
│   ├── integration/
│   └── lifecycle/
└── package.json
```

Use subpath exports for built-in adapters initially. Do not split them into separate packages without a demonstrated need for independent releases.

---

# Phase 2 — Authentication

Package: `@sveltex/auth`

## Objective

Provide a secure and extensible authentication foundation.

### Tasks

- [ ] User authentication.
- [ ] Password hashing and verification.
- [ ] Registration.
- [ ] Login and logout.
- [ ] Password reset workflows.
- [ ] Email verification.
- [ ] Account security.
- [ ] Session integration.
- [ ] Authentication hooks.
- [ ] Role-based access control.
- [ ] Permission checks.
- [ ] OAuth2 integration.
- [ ] OpenID Connect integration.
- [ ] Token expiration and revocation.
- [ ] Rate-limiting integration.
- [ ] Secure error handling.
- [ ] Authentication provider interfaces.

### Security tests

- [ ] Password storage security.
- [ ] Timing and user-enumeration protections.
- [ ] Token expiration.
- [ ] Token replay protections where applicable.
- [ ] Session fixation protections.
- [ ] Permission enforcement.
- [ ] Authentication bypass tests.
- [ ] Invalid and expired credential tests.

---

# Phase 3 — Sessions

Package: `@sveltex/session`

## Objective

Provide secure session management integrated with SvelteKit.

### Tasks

- [ ] Session creation.
- [ ] Session retrieval.
- [ ] Session destruction.
- [ ] Session rotation.
- [ ] Expiration.
- [ ] Revocation.
- [ ] Cookie configuration.
- [ ] Secure cookie defaults.
- [ ] CSRF protection integration.
- [ ] Persistent session stores.
- [ ] Concurrent request safety.
- [ ] Session storage adapters.
- [ ] Authentication integration.

### Tests

- [ ] Cookie security.
- [ ] Expiration.
- [ ] Rotation.
- [ ] Revocation.
- [ ] Concurrent session updates.
- [ ] CSRF protections.
- [ ] Store failures.
- [ ] Application shutdown.

---

# Phase 4 — Cache

Package: `@sveltex/cache`

## Objective

Provide consistent caching with local and distributed storage options.

### Tasks

- [ ] In-memory cache.
- [ ] Redis adapter.
- [ ] TTL support.
- [ ] Cache expiration.
- [ ] Atomic operations where supported.
- [ ] Cache namespaces.
- [ ] Cache invalidation.
- [ ] Tag-based invalidation.
- [ ] Serialization safety.
- [ ] Error handling.
- [ ] Connection lifecycle.
- [ ] Graceful fallback behavior.

### Tests

- [ ] TTL behavior.
- [ ] Expiration.
- [ ] Concurrent access.
- [ ] Atomic operations.
- [ ] Serialization.
- [ ] Redis integration.
- [ ] Connection failures.
- [ ] Cache invalidation.

---

# Phase 5 — Realtime

Package: `@sveltex/realtime`

## Objective

Provide reliable realtime communication.

### Tasks

- [ ] WebSocket transport.
- [ ] Server-Sent Events transport.
- [ ] Connection lifecycle.
- [ ] Authentication integration.
- [ ] Channel management.
- [ ] Message validation.
- [ ] Heartbeats.
- [ ] Reconnection support.
- [ ] Backpressure handling.
- [ ] Error handling.
- [ ] Graceful shutdown.
- [ ] In-memory development and testing transport.

### Tests

- [ ] Connection lifecycle.
- [ ] Disconnections.
- [ ] Authentication.
- [ ] Channel authorization.
- [ ] Message validation.
- [ ] Backpressure.
- [ ] Reconnection.
- [ ] Concurrent clients.
- [ ] Shutdown behavior.

---

# Phase 6 — Jobs

Package: `@sveltex/jobs`

## Objective

Provide background job processing with development and production storage options.

### Tasks

- [ ] Job registration.
- [ ] Job execution.
- [ ] Job scheduling.
- [ ] Delayed jobs.
- [ ] Retries.
- [ ] Exponential backoff.
- [ ] Job cancellation.
- [ ] Failure handling.
- [ ] Concurrency limits.
- [ ] Job deduplication.
- [ ] Idempotency.
- [ ] Redis-backed queue.
- [ ] Database-backed queue.
- [ ] Graceful worker shutdown.
- [ ] In-memory development and testing queue.

### Tests

- [ ] Job execution.
- [ ] Retry behavior.
- [ ] Delayed execution.
- [ ] Cancellation.
- [ ] Failure handling.
- [ ] Concurrency.
- [ ] Idempotency.
- [ ] Queue persistence.
- [ ] Worker shutdown.

---

# Phase 7 — Storage

Package: `@sveltex/storage`

## Objective

Provide a consistent file storage API with local and cloud storage adapters.

### Tasks

- [ ] Local filesystem storage.
- [ ] S3-compatible storage adapter.
- [ ] File uploads.
- [ ] File downloads.
- [ ] Streaming.
- [ ] File metadata.
- [ ] Presigned URLs.
- [ ] Content-type validation.
- [ ] File-size limits.
- [ ] Safe path handling.
- [ ] Storage lifecycle.
- [ ] Error handling.

### Tests

- [ ] Uploads.
- [ ] Downloads.
- [ ] Streaming.
- [ ] Metadata.
- [ ] Presigned URLs.
- [ ] File-size restrictions.
- [ ] Path traversal protections.
- [ ] Adapter behavior.
- [ ] Storage failures.

---

# Phase 8 — Mail

Package: `@sveltex/mail`

## Objective

Provide a unified email interface with test and production transports.

### Tasks

- [ ] SMTP integration.
- [ ] Provider adapter interface.
- [ ] HTML email support.
- [ ] Plain-text email support.
- [ ] Templates.
- [ ] Attachments.
- [ ] Retry behavior.
- [ ] Delivery metadata.
- [ ] Error handling.
- [ ] Authentication workflow integration.
- [ ] Test transport.

### Tests

- [ ] Message construction.
- [ ] HTML and text rendering.
- [ ] Attachments.
- [ ] Provider adapters.
- [ ] Retry behavior.
- [ ] Failure handling.
- [ ] Test transport.

---

# Phase 9 — Validation and Testing

Packages: `@sveltex/validation`, `@sveltex/testing`

## Validation

- [ ] Nested schemas.
- [ ] Array validation.
- [ ] Type inference.
- [ ] Custom validation rules.
- [ ] Consistent validation errors.
- [ ] SvelteKit integration.
- [ ] Request and endpoint validation.
- [ ] Edge-case handling.

## Testing

- [ ] SvelteKit-aware request testing.
- [ ] Page and endpoint test helpers.
- [ ] Database test utilities.
- [ ] Session and authentication helpers.
- [ ] Job testing utilities.
- [ ] Realtime testing utilities.
- [ ] Storage test helpers.
- [ ] Mail test helpers.
- [ ] Fixtures.
- [ ] Factories.
- [ ] Test database cleanup.
- [ ] Integration test lifecycle management.

### Tests

- [ ] Validation correctness.
- [ ] Type inference.
- [ ] SvelteKit integration.
- [ ] Request testing.
- [ ] Endpoint testing.
- [ ] Database isolation.
- [ ] Fixture cleanup.
- [ ] Cross-package test utilities.

---

# Phase 10 — Cross-Package Integration

Once the individual packages are complete, verify that they work together.

### Required integration scenarios

- [ ] Authentication + Sessions + Database.
- [ ] Authentication + Validation.
- [ ] Authentication + Mail.
- [ ] Database + Jobs.
- [ ] Database + Cache.
- [ ] Storage + Authentication.
- [ ] Realtime + Authentication.
- [ ] Testing + Database.
- [ ] Testing + Sessions.
- [ ] Testing + Jobs.
- [ ] Testing + Realtime.
- [ ] Testing + Storage.
- [ ] Testing + Mail.

### Important

Do not consider a package production-ready merely because its unit tests pass.

Cross-package integration must be tested using realistic SvelteKit applications.

---

# Phase 11 — Production and Release Audit

Perform a complete production-readiness review of every existing package.

### Code quality

- [ ] No unfinished implementations.
- [ ] No placeholder functionality.
- [ ] No unnecessary dependencies.
- [ ] No duplicated responsibilities.
- [ ] Consistent error handling.
- [ ] Stable public APIs.
- [ ] Correct TypeScript declarations.
- [ ] Correct package exports.

### Testing

- [ ] Unit tests.
- [ ] Integration tests.
- [ ] Security tests.
- [ ] Type tests.
- [ ] Build tests.
- [ ] Adapter conformance tests.
- [ ] Regression tests.

### Compatibility

- [ ] Supported Node.js versions.
- [ ] Supported SvelteKit versions.
- [ ] Package-manager compatibility.
- [ ] Optional dependency behavior.
- [ ] ESM exports.
- [ ] Clean installation testing.

### Release verification

- [ ] Build every package.
- [ ] Run every package's tests.
- [ ] Run TypeScript checks.
- [ ] Run linting.
- [ ] Run package export checks.
- [ ] Run package packing checks.
- [ ] Verify published package contents.
- [ ] Test installation outside the monorepo.
- [ ] Verify peer dependencies.
- [ ] Verify documentation.
- [ ] Review changelogs and versions.

### Generated application verification

- [ ] Generate applications using existing templates.
- [ ] Install dependencies using supported package managers.
- [ ] Run Svelte checks.
- [ ] Run production builds.
- [ ] Run generated application tests.
- [ ] Verify package versions.
- [ ] Verify imports and exports.
- [ ] Test on supported operating systems.

Do not claim production readiness until these checks pass.

---

# Phase 12 — CLI and Blueprint Ecosystem

Package: `@sveltex/cli`

**This phase comes last.** The CLI is a major part of SvelteX's identity, but it should build on stable packages rather than incomplete functionality.

## Objective

Make SvelteX's CLI a major reason developers choose the framework.

Take inspiration from the strengths of Ember CLI: generators, blueprints, addon extensibility, multi-file generation, and a consistent project workflow.

### Blueprint engine

- [ ] Multi-file blueprints.
- [ ] Project blueprints.
- [ ] Package-provided blueprints.
- [ ] Built-in blueprints.
- [ ] Custom project blueprints.
- [ ] Blueprint configuration.
- [ ] Template variables.
- [ ] File transformations.
- [ ] Dependency installation hooks.
- [ ] Install and post-install hooks.
- [ ] Conflict detection.
- [ ] Dry-run support.
- [ ] Safe rollback.
- [ ] Blueprint versioning.
- [ ] Compatibility checks.

### Generators

Expand generators after the existing package APIs are stable.

Potential generators:

- Module.
- Service.
- Middleware.
- Route.
- Component.
- Test.
- Page.
- Layout.
- Endpoint.
- Resource.
- Schema.
- Guard.
- Policy.
- Job.
- Channel.
- Mail.
- Migration.
- Seed.
- Factory.
- Fixture.

Generators should create complete, consistent files and tests where appropriate, rather than only empty placeholder files.

### Official templates

Review and improve the existing templates:

- Minimal.
- Fullstack.
- API.
- Dashboard.
- SaaS.
- Documentation.

Templates must demonstrate real package capabilities and must build successfully.

Examples:

**Fullstack**
- Database integration.
- Authentication.
- Sessions.
- Validation.
- Testing.

**API**
- Request validation.
- Database CRUD.
- Authentication and authorization.
- Pagination and filtering.
- Consistent errors.
- Endpoint tests.

**Dashboard**
- Protected routes.
- Database-backed data.
- Authentication.
- Tests.

**SaaS**
- User accounts.
- Sessions.
- Persistent data.
- Jobs and mail where appropriate.
- Clearly documented billing integration boundaries.

**Documentation**
- Nested documentation sections.
- Navigation.
- Search.
- Table of contents.
- Previous and next links.
- SEO and sitemap support.

**Minimal**
- Keep it genuinely minimal.
- Avoid unnecessary dependencies.

---

# Execution Order

| Order | Work |
|---|---|
| 0 | Audit existing packages |
| 1 | Database, including ORM integrations and BYO ORM |
| 2 | Authentication |
| 3 | Sessions |
| 4 | Cache |
| 5 | Realtime |
| 6 | Jobs |
| 7 | Storage |
| 8 | Mail |
| 9 | Validation and Testing |
| 10 | Cross-package integration |
| 11 | Production and release audit |
| 12 | CLI and blueprint ecosystem |

# Architecture Rules

1. Finish existing packages before creating new framework packages.
2. Keep package responsibilities clear.
3. Prefer optional integrations over mandatory dependencies.
4. Preserve native APIs of third-party tools.
5. Provide adapter interfaces when external implementations need to be supported.
6. Avoid building abstractions that remove useful capabilities.
7. Test actual integrations, not only mocked behavior.
8. Keep documentation aligned with the implementation.
9. Do not advertise features that are not implemented and tested.
10. Verify generated applications against published package artifacts.

# Completion Criteria

The existing-package completion phase is finished only when:

- All existing packages have been audited.
- Required functionality is implemented.
- Database supports built-in ORM integrations and custom ORM adapters.
- Public APIs and TypeScript types are stable.
- Unit, integration, security, and type tests pass.
- Packages build and install independently.
- Cross-package scenarios work.
- Documentation matches implementation.
- Generated applications build and run.
- Production-readiness checks pass.

Only after these requirements are satisfied should SvelteX move into additional packages or expand its CLI ecosystem.

**Finish what SvelteX already promises before making SvelteX promise more.**
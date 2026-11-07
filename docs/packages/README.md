# SvelteX packages

SvelteX is split into independently installable packages. Build the application engine and SvelteKit integration first, then the backend package contracts, then advanced infrastructure. Implement the CLI last.

| Stage | Package | Status |
| --- | --- | --- |
| 1 | `@sveltex/core` | Existing — preserved; 72 Core tests pass locally |
| 1 | `@sveltex/shared` | Implemented — data utilities, errors, strict input tests |
| 1 | `@sveltex/config` | Implemented — immutable config, safe merge, validation |
| 2 | `@sveltex/sveltekit` | Existing — 30 adapter tests pass locally; real fixture build still needs CI |
| 3 | `@sveltex/database` | Initial driver-neutral implementation and transaction tests |
| 3 | `@sveltex/validation` | Implemented — Standard Schema v1 adapter and issue normalization |
| 3 | `@sveltex/auth` | Initial credential orchestration; external hasher/store/session adapters required |
| 3 | `@sveltex/cache` | Implemented — bounded in-memory LRU/TTL store; distributed driver required for multi-instance use |
| 3 | `@sveltex/session` | Initial revisioned lifecycle; atomic persistent store required for production |
| 4 | `@sveltex/realtime` | Not started |
| 4 | `@sveltex/jobs` | Not started |
| 4 | `@sveltex/storage` | Not started |
| 4 | `@sveltex/mail` | Not started |
| 4 | `@sveltex/testing` | Not started |
| 5 | `sveltex` CLI | Intentionally deferred until last |

Do not add placeholder packages for future stages. Each package must have a useful implementation, stable public contracts, strict type checks, public API type tests, unit/integration/security tests, package export checks, and documentation before it is considered complete.

See [`../specification.md`](../specification.md) for package responsibilities, API rules, acceptance criteria, and the complete CLI specification.

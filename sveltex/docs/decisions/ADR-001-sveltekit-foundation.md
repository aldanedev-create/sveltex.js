# ADR-001: SvelteKit Is the Web Application Foundation

- **Status:** Accepted
- **Decision:** SvelteX builds on SvelteKit and does not replace its web platform responsibilities.

## Context

SvelteKit already provides routing, SSR, load functions, form actions, endpoints, hooks, and deployment adapters. Reimplementing these would duplicate mature functionality and fragment compatibility.

## Consequences

- Native SvelteKit conventions remain valid.
- SvelteX integrates through supported public APIs.
- No SvelteX router, SSR engine, compiler, hydration system, or adapter system is created.
- SvelteKit upgrades are compatibility work for the integration package.

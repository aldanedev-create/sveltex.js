# Contributing

## Requirements

- Node.js 20.11+
- pnpm 10+

## Setup

```bash
corepack enable
pnpm install
```

Commit the generated `pnpm-lock.yaml` whenever dependency manifests change.

## Verification

```bash
pnpm check
pnpm test:unit
pnpm test:security
pnpm test:stress
```

`pnpm check` builds all workspace packages (including the real SvelteKit fixture), runs TypeScript checks, executes the Core and adapter test suites, and checks the Core public API types.

## Package boundaries

- Keep `@sveltex/core` independent of SvelteKit, Vite, browser globals, and Node process lifecycle assumptions.
- Put SvelteKit-specific behavior in `@sveltex/sveltekit`.
- Never store request-specific data in singleton providers.
- Do not wrap or rewrite SvelteKit redirect and HTTP error values.
- Add tests for failure cleanup and concurrent requests when changing request lifecycle code.

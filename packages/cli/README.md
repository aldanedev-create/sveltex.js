# sveltex

Official development CLI for SvelteX — project creation, safe integration into
existing SvelteKit apps, generators, and diagnostics.

The CLI is a **development tool**. Generated applications depend on the
`@sveltex/*` framework packages at runtime, never on the CLI itself.

## Install / zero-global-install

```sh
pnpm dlx sveltex create my-app
```

No global install is required. Node.js `>=20.11` is required; the CLI checks the
active runtime before running commands that manage a project.

## Commands

| Command | Purpose |
| --- | --- |
| `sveltex create <name>` | Create a project from an official template. |
| `sveltex init` | Add SvelteX to an existing SvelteKit project safely. |
| `sveltex add <integration...>` | Install and configure selected official packages. |
| `sveltex remove <integration...>` | Remove selected integrations without deleting unrelated user code. |
| `sveltex generate <kind> <name>` | Generate a module, service, middleware, route, component, or test file. |
| `sveltex dev` / `build` / `preview` / `check` / `test` | Delegate to the project's own scripts; the CLI does not reimplement build tooling. |
| `sveltex doctor` | Report diagnostics with stable codes, severities, paths, and safe fixes. |
| `sveltex info` | Print Node, package-manager, and installed SvelteX/SvelteKit versions (secrets redacted). |
| `sveltex routes` | Derive routes from the `src/routes` filesystem convention. |
| `sveltex modules` | List module files discovered in the project. |
| `sveltex config` | Statically inspect `sveltex.config.ts` and redact secret values. |
| `sveltex upgrade` | Report CLI-owned compatibility metadata (no registry lookup, no guessing). |
| `sveltex migrate` | Preview named migrations; `--apply` applies them. |

Add `--json` to any command for a single machine-readable JSON object,
`--dry-run` to preview file changes without writing them, and `--no-install`
(`create` / `init`) to write files without invoking the package manager — the
CLI reports `installed: false` and lists the manual install steps instead.

## Official templates

`minimal`, `fullstack`, `api`, `dashboard`, `saas`, `documentation`.

Each template generates real, editable SvelteKit source files and a canonical
`sveltex.config.ts`. Welcome pages (`welcome`, `blank`, `dashboard`, `docs`) are
selectable with `--welcome`.

The `saas` template is a **layout/structure starter only**: it explicitly does
not ship or imply authentication, user accounts, sessions, durable persistence,
billing, subscriptions, or payments. No fake providers are advertised.

## Safety model

- **Never overwrite without consent.** Existing files are detected; use `--force`
  to overwrite, `--dry-run` to preview, `--yes` for non-interactive confirmation.
- **Hooks are composed, not replaced.** `init` preserves an existing
  `src/hooks.server.ts` handle as `userHandle` and composes it with
  `createSvelteXHandler` via SvelteKit `sequence()`. Comments are preserved.
- **No shell interpretation.** All child processes run with `shell: false` and
  argument arrays only; package specifiers, script names, and project names are
  validated against option injection and path traversal (including encoded
  sequences and NUL).
- **Config is never executed.** Diagnostics inspect `sveltex.config.ts` as text
  and delegate shape validation to `@sveltex/config`; secrets are redacted and
  only missing environment variable **names** are reported, never values.
- **Rollback on failure.** CLI-owned file mutations go through a `ChangeSet`; a
  failed install rolls back every generated/edited file.
- **One package manager.** Conflicting lockfiles stop the command; nothing is
  deleted silently. `packageManager` declarations are respected and checked for
  consistency.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Command failed |
| `2` | Invalid usage or arguments |
| `3` | Project / configuration / compatibility problem |
| `4` | Operation cancelled |

`doctor` returns `3` when error-severity diagnostics are present.

## Programmatic API

The package also exports its building blocks for tests and embedding:
`runCli`, the command registry, `parseArgs`, `ChangeSet`, `runDoctor`,
`collectRoutes`, template and integration registries, and the generator helpers.
`runCli()` returns a stable `CliResult` and never calls `process.exit()` itself.

## Limitations

- The CLI installs dependencies only through the **detected** package manager;
  it does not implement its own resolver or fetch a registry to guess versions.
- `upgrade` reports CLI-owned compatibility metadata only. It does not query a
  registry or silently rewrite project dependencies.
- No SMTP, S3, WebSocket, hosted-Redis, or other external provider adapters are
  shipped or advertised by the CLI or its integration registry.
- In-memory/process-local adapters are flagged by `doctor` as unsuitable for
  multi-instance or production deployments; the CLI does not claim distributed
  durability for them.

## Status

Verified with 56 runtime, security, generator, command, and public-API type
tests. Six official templates are exercised end-to-end in dry-run and real-file
modes.

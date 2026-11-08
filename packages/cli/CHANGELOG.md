# Changelog

All notable changes to the `sveltex` CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-07

### Added

- Stage 5 CLI, built last after Stages 1–4 of the SvelteX ecosystem were complete and verified.
- `create` with six official starter templates: `minimal`, `fullstack`, `api`, `dashboard`, `saas`, `documentation`.
- Welcome-page choices (`welcome`, `blank`, `dashboard`, `docs`) with a real, editable SvelteKit `+page.svelte` for the fullstack starter.
- `init`, `add`, `remove`, and `generate` commands with preview, dry-run, and rollback of CLI-owned changes.
- Delegating `dev`, `build`, `preview`, `check`, and `test` commands that invoke the project's own package-manager scripts.
- `doctor`, `info`, `routes`, `modules`, `config`, `upgrade`, and `migrate` commands.
- Package-manager detection for pnpm, npm, Yarn, and Bun, including conflicting-lockfile detection.
- Path-traversal protection, project-name validation, no-shell-interpolation process spawning, and secret redaction.
- Stable `--json` output and exit codes `0`/`1`/`2`/`3`/`4`.
- Unit, command, generator, package-manager, diagnostic, security, end-to-end, and public-API type tests.

### Fixed

- `init --no-install` now actually skips dependency installation and the automatic project check. It reports `installed: false`, preserves the composed hooks, and lists the manual install/check steps instead of silently invoking the package manager (which previously failed in offline environments and rolled back the CLI-owned changes). A regression test covers the no-shell/no-install path.

### Notes

- The CLI is a development tool. Generated applications do not depend on it at runtime.
- Configuration validation is delegated to `@sveltex/config`; the CLI does not execute project configuration for diagnostics.
- Provider adapters are not shipped by the CLI. It only wires official packages that already exist.

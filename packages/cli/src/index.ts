/** Programmatic API for the sveltex CLI. The executable entrypoint is ./cli.js. */
export * from './types/index.js';
export { runCli } from './router.js';
export type { RunCliOptions } from './router.js';

export { parseArgs, globalOptions, flagString, flagBoolean } from './terminal/args.js';
export { CliError, usageError, projectError, cancelled, asCliError } from './terminal/errors.js';
export type { CliErrorOptions } from './terminal/errors.js';
export { DefaultReporter, buildResult, renderResult } from './terminal/output.js';
export type { WriteLine, BuildResultOptions } from './terminal/output.js';

export * from './safety/paths.js';
export { ChangeSet } from './safety/changes.js';

export * from './package-manager/detect.js';
export * from './package-manager/run.js';

export { discoverProject, readInstalledVersion } from './project/discovery.js';
export { insertDependencies, removeDependencies } from './project/manifest.js';
export type { DependencyEntry } from './project/manifest.js';

export * from './configuration/redact.js';
export * from './configuration/inspect.js';

export * from './integrations/registry.js';
export { composeHooks } from './integrations/hooks.js';
export type { HooksComposition } from './integrations/hooks.js';

export * from './templates/registry.js';
export * from './generators/create.js';
export * from './generators/files.js';
export * from './generators/types.js';

export * from './diagnostics/doctor.js';
export * from './diagnostics/routes.js';
export * from './migrations/registry.js';

export { COMMANDS, getCommandSpec } from './commands/index.js';
export { DELEGATED_SCRIPTS, makeDelegateCommand } from './commands/delegate.js';
export { cliVersion } from './commands/inspect.js';

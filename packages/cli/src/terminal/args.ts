import type { GlobalOptions, ParsedArgs } from '../types/index.js';
import { usageError } from './errors.js';

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'help', 'h', 'json', 'dry-run', 'yes', 'y', 'force', 'no-install', 'no-git', 'apply', 'all',
]);

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'template', 'package-manager', 'pm', 'welcome', 'cwd', 'migration', 'format', 'kind', 'from', 'docs-url',
]);

/** Strict, dependency-free argument parser. Unknown flags are usage errors (exit 2). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (optionsEnded) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }

    const raw = token.startsWith('--') ? token.slice(2) : token.slice(1);
    const equals = raw.indexOf('=');
    const key = equals === -1 ? raw : raw.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);

    if (key === '') throw usageError('Empty flag name.');

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue !== undefined) throw usageError(`Flag --${key} does not accept a value.`);
      flags[key] = true;
      if (key === 'h') flags['help'] = true;
      if (key === 'y') flags['yes'] = true;
      continue;
    }

    if (VALUE_FLAGS.has(key)) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('-')) throw usageError(`Flag --${key} requires a value.`);
        value = next;
        index += 1;
      }
      if (value === '') throw usageError(`Flag --${key} requires a non-empty value.`);
      flags[key] = value;
      continue;
    }

    throw usageError(`Unknown flag --${key}.`, 'SX_CLI_UNKNOWN_FLAG');
  }

  const command = positional[0];
  return Object.freeze({
    command,
    positionals: Object.freeze(positional.slice(1)),
    flags: Object.freeze(flags),
  });
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === 'string' ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true;
}

export function globalOptions(args: ParsedArgs, cwd: string): GlobalOptions {
  return Object.freeze({
    json: flagBoolean(args, 'json'),
    dryRun: flagBoolean(args, 'dry-run'),
    yes: flagBoolean(args, 'yes'),
    force: flagBoolean(args, 'force'),
    help: flagBoolean(args, 'help'),
    cwd: flagString(args, 'cwd') ?? cwd,
  });
}

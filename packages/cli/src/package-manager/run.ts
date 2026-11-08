import { spawn } from 'node:child_process';
import type { PackageManagerId, ProcessResult, ProcessRunOptions, ProcessRunner } from '../types/index.js';
import { usageError } from '../terminal/errors.js';

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

function assertPackages(packages: readonly string[]): void {
  if (packages.length === 0) throw usageError('At least one package name is required.');
  for (const name of packages) {
    // Reject leading dashes too: a specifier must never become a package-manager option.
    if (name === '' || name.startsWith('-') || /[\s;$`|&<>()"'\\]/.test(name)) {
      throw usageError(`Unsafe package specifier: ${name}`, 'SX_CLI_UNSAFE_ARGUMENT');
    }
  }
}

export function buildAddCommand(pm: PackageManagerId, packages: readonly string[], options: { readonly dev?: boolean } = {}): Invocation {
  assertPackages(packages);
  const dev = options.dev === true;
  switch (pm) {
    case 'pnpm': return Object.freeze({ command: 'pnpm', args: Object.freeze(['add', ...(dev ? ['-D'] : []), ...packages]) });
    case 'npm': return Object.freeze({ command: 'npm', args: Object.freeze(['install', ...(dev ? ['--save-dev'] : []), ...packages]) });
    case 'yarn': return Object.freeze({ command: 'yarn', args: Object.freeze(['add', ...(dev ? ['-D'] : []), ...packages]) });
    case 'bun': return Object.freeze({ command: 'bun', args: Object.freeze(['add', ...(dev ? ['-d'] : []), ...packages]) });
  }
}

export function buildRemoveCommand(pm: PackageManagerId, packages: readonly string[]): Invocation {
  assertPackages(packages);
  const verb: Record<PackageManagerId, string> = { pnpm: 'remove', npm: 'uninstall', yarn: 'remove', bun: 'remove' };
  return Object.freeze({ command: pm, args: Object.freeze([verb[pm], ...packages]) });
}

export function buildRunCommand(pm: PackageManagerId, script: string, extraArgs: readonly string[] = []): Invocation {
  if (script === '' || /[\s;$`|&<>()"'\\]/.test(script)) {
    throw usageError(`Unsafe script name: ${script}`, 'SX_CLI_UNSAFE_ARGUMENT');
  }
  return Object.freeze({
    command: pm,
    args: Object.freeze(['run', script, ...(extraArgs.length > 0 ? ['--', ...extraArgs] : [])]),
  });
}

export function buildVersionCommand(pm: PackageManagerId): Invocation {
  return Object.freeze({ command: pm, args: Object.freeze(['--version']) });
}

export function buildInstallCommand(pm: PackageManagerId): Invocation {
  return Object.freeze({ command: pm, args: Object.freeze(['install']) });
}

export function devCommand(pm: PackageManagerId): string {
  return pm === 'npm' ? 'npm run dev' : `${pm} dev`;
}

/** Real process runner. Arguments are passed as an array; `shell` is always false. */
export const defaultRunner: ProcessRunner = (command, args, options: ProcessRunOptions): Promise<ProcessResult> =>
  new Promise<ProcessResult>((settle) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      settle(Object.freeze(result));
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: Error) => {
      finish({ exitCode: 127, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on('close', (code: number | null) => {
      finish({ exitCode: code ?? 1, stdout, stderr });
    });
  });

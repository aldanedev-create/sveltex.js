import type { Diagnostic, DiagnosticSeverity, PackageManagerId, ProjectInfo } from '../types/index.js';
import { inspectConfigText } from '../configuration/inspect.js';
import { INTEGRATIONS, SVELTEX_PACKAGE_VERSION } from '../integrations/registry.js';
import { resolvePackageManager } from '../package-manager/detect.js';

export const NODE_MINIMUM = '20.11.0';

function versionParts(version: string): readonly number[] {
  return version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function isSupportedNode(version: string, minimum = NODE_MINIMUM): boolean {
  const actual = versionParts(version);
  const required = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    const a = actual[index] ?? 0;
    const r = required[index] ?? 0;
    if (a > r) return true;
    if (a < r) return false;
  }
  return true;
}

export interface DoctorInput {
  readonly project: ProjectInfo | undefined;
  readonly nodeVersion: string;
  readonly configSource: string | undefined;
  readonly hooksSource: string | undefined;
  readonly packageManager: PackageManagerId | undefined;
  readonly pmVersionExitCode: number | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface DoctorReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly counts: Readonly<Record<DiagnosticSeverity, number>>;
  readonly healthy: boolean;
}

export function runDoctor(input: DoctorInput): DoctorReport {
  const diagnostics: Diagnostic[] = [];
  const push = (code: string, severity: DiagnosticSeverity, message: string, extra: { readonly path?: string; readonly fix?: string } = {}): void => {
    diagnostics.push(Object.freeze({
      code,
      severity,
      message,
      ...(extra.path !== undefined ? { path: extra.path } : {}),
      ...(extra.fix !== undefined ? { fix: extra.fix } : {}),
    }));
  };

  if (!isSupportedNode(input.nodeVersion)) {
    push('SX_NODE_UNSUPPORTED', 'error', `Node.js ${input.nodeVersion} is below the required ${NODE_MINIMUM}.`, { fix: 'Upgrade Node.js to a supported LTS release.' });
  } else {
    push('SX_NODE_OK', 'info', `Node.js ${input.nodeVersion} satisfies the minimum ${NODE_MINIMUM}.`);
  }

  if (input.project === undefined) {
    push('SX_PROJECT_MISSING', 'error', 'No package.json was found while walking up from the current directory.', { fix: 'Run this command inside a project, or pass --cwd.' });
  } else {
    const declared: Record<string, string> = { ...input.project.dependencies, ...input.project.devDependencies };
    const sveltexDeps = Object.entries(declared).filter(([name]) => name.startsWith('@sveltex/'));

    try {
      resolvePackageManager({ lockfiles: input.project.lockfiles, ...(input.project.declaredPackageManager !== undefined ? { declared: input.project.declaredPackageManager } : {}) });
      if (input.pmVersionExitCode !== undefined && input.pmVersionExitCode !== 0) {
        push('SX_PM_UNAVAILABLE', 'error', `The detected package manager exited with code ${String(input.pmVersionExitCode)}.`, { fix: 'Install the package manager declared by the project.' });
      }
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? String((cause as { code: unknown }).code) : 'SX_PM_UNKNOWN';
      push(code, 'error', cause instanceof Error ? cause.message : String(cause), { fix: 'Choose a single package manager with --package-manager.' });
    }

    if (sveltexDeps.length === 0) {
      push('SX_NO_SVELTEX_DEPS', 'info', 'No @sveltex/* dependencies are declared in this project.');
    }
    for (const [name, range] of sveltexDeps) {
      if (!range.includes(SVELTEX_PACKAGE_VERSION)) {
        push('SX_PEER_MISMATCH', 'warning', `${name} declares "${range}" but this CLI targets ${SVELTEX_PACKAGE_VERSION}.`, { path: input.project.manifestPath, fix: 'Run sveltex upgrade --apply to align declared versions.' });
      }
    }

    const localOnly = INTEGRATIONS.filter((entry) => entry.processLocalOnly).map((entry) => entry.packageName);
    const installedLocal = localOnly.filter((name) => Object.hasOwn(declared, name));
    const instances = Number(input.env['SVELTEX_INSTANCES'] ?? '1');
    if (installedLocal.length > 0 && ((Number.isFinite(instances) && instances > 1) || input.env['NODE_ENV'] === 'production')) {
      push('SX_IN_MEMORY_MULTI_INSTANCE', 'warning', `Process-local adapters (${installedLocal.join(', ')}) are declared for a multi-instance/production setup.`, { fix: 'Use durable adapters or restrict the deployment to a single instance.' });
    }

    if (!Object.hasOwn(declared, 'typescript')) {
      push('SX_TYPESCRIPT_MISSING', 'info', 'TypeScript is not declared; generated type checks will be unavailable.', { fix: 'Add typescript as a dev dependency.' });
    }
  }

  if (input.configSource === undefined) {
    push('SX_CONFIG_MISSING', 'error', 'sveltex.config.ts was not found.', { fix: 'Run sveltex init to create a canonical configuration file.' });
  } else {
    const inspection = inspectConfigText(input.configSource);
    if (!inspection.hasDefaultExport) push('SX_CONFIG_NO_DEFAULT_EXPORT', 'error', 'sveltex.config.ts has no default export.', { path: 'sveltex.config.ts' });
    if (inspection.unsafeExecDetected) push('SX_CONFIG_UNSAFE_EXEC', 'warning', 'sveltex.config.ts references dynamic execution; the CLI never evaluates it.', { path: 'sveltex.config.ts' });
    for (const name of inspection.referencedEnvNames) {
      if (input.env[name] === undefined) {
        push('SX_ENV_MISSING', 'warning', `Environment variable ${name} is referenced by the config but is not set (value not read).`, { fix: `Set ${name} in your environment; the CLI never invents a value.` });
      }
    }
  }

  if (input.hooksSource === undefined) {
    push('SX_SVELTEKIT_HOOKS_MISSING', 'warning', 'src/hooks.server.ts was not found; SvelteX is not attached to SvelteKit requests.', { fix: 'Run sveltex init, or compose createSvelteXHandler with sequence().' });
  } else if (!input.hooksSource.includes('createSvelteXHandler')) {
    push('SX_SVELTEKIT_HOOKS_NOT_COMPOSED', 'warning', 'src/hooks.server.ts does not reference createSvelteXHandler.', { path: 'src/hooks.server.ts' });
  } else if (!input.hooksSource.includes('sequence')) {
    push('SX_SVELTEKIT_HOOKS_NOT_SEQUENCED', 'info', 'SvelteX is used directly rather than via SvelteKit sequence(); additional handles cannot be composed.', { path: 'src/hooks.server.ts' });
  } else {
    push('SX_SVELTEKIT_HOOKS_OK', 'info', 'SvelteX is composed with SvelteKit sequence().');
  }

  const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    counts: Object.freeze(counts),
    healthy: counts.error === 0,
  });
}

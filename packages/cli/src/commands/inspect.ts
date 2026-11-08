import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import type { CommandHandler, PackageManagerId } from '../types/index.js';
import { EXIT } from '../types/index.js';
import { flagBoolean, flagString } from '../terminal/args.js';
import { CliError, projectError } from '../terminal/errors.js';
import { ChangeSet } from '../safety/changes.js';
import { resolveInside } from '../safety/paths.js';
import { redactValue } from '../configuration/redact.js';
import { inspectConfigText } from '../configuration/inspect.js';
import { resolvePackageManager } from '../package-manager/detect.js';
import { buildAddCommand, buildVersionCommand } from '../package-manager/run.js';
import { discoverProject, readInstalledVersion } from '../project/discovery.js';
import { SVELTEX_PACKAGE_VERSION, INTEGRATIONS } from '../integrations/registry.js';
import { runDoctor } from '../diagnostics/doctor.js';
import { collectRoutes } from '../diagnostics/routes.js';
import { MIGRATION_NAMES, planMigration } from '../migrations/registry.js';
import { readOptional, requirePackageManager, requireProject } from './shared.js';

const OWN_MANIFEST = fileURLToPath(new URL('../../package.json', import.meta.url));

export async function cliVersion(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(OWN_MANIFEST, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof (parsed as { version: unknown }).version === 'string') {
    return (parsed as { version: string }).version;
  }
  throw new CliError('The CLI package.json has no version string.', { code: 'SX_CLI_MANIFEST_INVALID' });
}

function declaredPackages(dependencies: Readonly<Record<string, string>>, devDependencies: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze({ ...dependencies, ...devDependencies });
}

export const doctorCommand: CommandHandler = async (args, deps) => {
  const project = await discoverProject(deps.cwd);
  const root = project?.root ?? deps.cwd;
  const configSource = await readOptional(join(root, 'sveltex.config.ts'));
  const hooksSource = await readOptional(join(root, 'src/hooks.server.ts'));

  let packageManager: PackageManagerId | undefined;
  if (project !== undefined) {
    try {
      packageManager = resolvePackageManager({
        lockfiles: project.lockfiles,
        ...(project.declaredPackageManager !== undefined ? { declared: project.declaredPackageManager } : {}),
      });
    } catch {
      packageManager = undefined;
    }
  }
  let pmVersionExitCode: number | undefined;
  if (packageManager !== undefined && !flagBoolean(args, 'dry-run')) {
    const invocation = buildVersionCommand(packageManager);
    const result = await deps.runner(invocation.command, invocation.args, { cwd: root });
    pmVersionExitCode = result.exitCode;
  }

  const report = runDoctor({
    project,
    nodeVersion: deps.nodeVersion,
    configSource,
    hooksSource,
    packageManager,
    pmVersionExitCode,
    env: deps.env,
  });

  for (const diagnostic of report.diagnostics) {
    const line = `[${diagnostic.code}] ${diagnostic.message}${diagnostic.fix === undefined ? '' : ` Fix: ${diagnostic.fix}`}`;
    if (diagnostic.severity === 'error') deps.reporter.error(line);
    else if (diagnostic.severity === 'warning') deps.reporter.warn(line);
    else deps.reporter.info(line);
  }

  const data = Object.freeze({
    projectRoot: project?.root ?? null,
    healthy: report.healthy,
    counts: report.counts,
    diagnostics: report.diagnostics,
  });
  deps.reporter.result(data);
  return Object.freeze({
    data,
    exitCode: report.healthy ? EXIT.OK : EXIT.PROJECT,
    summary: `${String(report.counts.error)} error(s), ${String(report.counts.warning)} warning(s).`,
  });
};

export const infoCommand: CommandHandler = async (_args, deps) => {
  const project = await discoverProject(deps.cwd);
  const declared = project === undefined ? {} : declaredPackages(project.dependencies, project.devDependencies);
  const names = Object.keys(declared).filter((name) => name.startsWith('@sveltex/')).sort();
  const packages = [];
  for (const name of names) {
    packages.push(Object.freeze({
      name,
      declared: declared[name] ?? null,
      installed: project === undefined ? null : (await readInstalledVersion(project.root, name)) ?? null,
    }));
  }
  let packageManager: PackageManagerId | undefined;
  if (project !== undefined) {
    try {
      packageManager = resolvePackageManager({ lockfiles: project.lockfiles, ...(project.declaredPackageManager !== undefined ? { declared: project.declaredPackageManager } : {}) });
    } catch { packageManager = undefined; }
  }

  const data = Object.freeze({
    cli: await cliVersion(),
    node: deps.nodeVersion,
    packageManager: packageManager ?? null,
    project: project?.name ?? null,
    projectRoot: project?.root ?? null,
    targetSvelteXVersion: SVELTEX_PACKAGE_VERSION,
    packages: Object.freeze(packages),
    knownOfficialPackages: Object.freeze(INTEGRATIONS.map((entry) => entry.packageName)),
    secrets: 'never printed',
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: 'Version information collected.' });
};

export const routesCommand: CommandHandler = async (_args, deps) => {
  const project = await requireProject(deps.cwd);
  const routes = await collectRoutes(project.root);
  const data = Object.freeze({
    projectRoot: project.root,
    derivedFrom: 'SvelteKit filesystem convention (src/routes)',
    buildMetadataUsed: false,
    projectCodeExecuted: false,
    routes,
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: `${String(routes.length)} route(s) derived.` });
};

export const modulesCommand: CommandHandler = async (_args, deps) => {
  const project = await requireProject(deps.cwd);
  const configSource = await readOptional(join(project.root, 'sveltex.config.ts'));
  const inspection = inspectConfigText(configSource ?? '');

  const configModules: string[] = [];
  if (configSource !== undefined) {
    const block = /modules\s*:\s*\[([\s\S]*?)\]/.exec(configSource);
    const inner = block?.[1];
    if (inner !== undefined) {
      for (const match of inner.matchAll(/['"]([^'"]+)['"]/g)) {
        const value = match[1];
        if (value !== undefined) configModules.push(value);
      }
    }
  }

  const sourceModules: string[] = [];
  const modulesDir = join(project.root, 'src', 'lib', 'server', 'modules');
  let files: readonly string[] = [];
  try { files = await readdir(modulesDir); } catch { files = []; }
  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    const source = await readOptional(join(modulesDir, file));
    if (source === undefined) continue;
    for (const match of source.matchAll(/defineModule\(\s*\{\s*name:\s*['"]([^'"]+)['"]/g)) {
      const value = match[1];
      if (value !== undefined) sourceModules.push(value);
    }
  }

  const data = Object.freeze({
    staticInspectionOnly: true,
    projectCodeExecuted: false,
    configModules: Object.freeze(configModules),
    sourceModules: Object.freeze([...new Set(sourceModules)].sort()),
    configIssues: inspection.issues,
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: `${String(configModules.length)} config reference(s), ${String(new Set(sourceModules).size)} module definition(s).` });
};

export const configCommand: CommandHandler = async (_args, deps) => {
  const project = await requireProject(deps.cwd);
  const configPath = project.configPath ?? join(project.root, 'sveltex.config.ts');
  const source = await readOptional(configPath);
  if (source === undefined) throw projectError('sveltex.config.ts was not found in this project.', 'SX_CONFIG_MISSING');
  const inspection = inspectConfigText(source);
  const safeView = redactValue({
    topLevelKeys: [...inspection.topLevelKeys],
    importNames: [...inspection.importNames],
    secretFieldNames: [...inspection.secretFieldNames],
    referencedEnvNames: [...inspection.referencedEnvNames],
  });
  const data = Object.freeze({
    path: relative(project.root, configPath).split('\\').join('/'),
    executed: false,
    redacted: true,
    validationOwner: '@sveltex/config#validateConfig',
    inspection,
    safeView,
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: 'Configuration inspected statically; it was never executed.' });
};

export const upgradeCommand: CommandHandler = async (args, deps) => {
  const project = await requireProject(deps.cwd);
  const pm = requirePackageManager(args, project);
  const declared = declaredPackages(project.dependencies, project.devDependencies);
  const targetRange = `^${SVELTEX_PACKAGE_VERSION}`;
  const items = Object.entries(declared)
    .filter(([name]) => name.startsWith('@sveltex/'))
    .map(([name, range]) => Object.freeze({
      name,
      declared: range,
      target: targetRange,
      needsUpgrade: !range.startsWith('workspace:') && range !== SVELTEX_PACKAGE_VERSION && range !== targetRange,
    }));
  const apply = flagBoolean(args, 'apply');
  let installResult: { readonly exitCode: number; readonly invocation: { readonly command: string; readonly args: readonly string[] } } | null = null;
  if (apply && items.length > 0) {
    const invocation = buildAddCommand(pm, items.map((item) => `${item.name}@${targetRange}`));
    const result = await deps.runner(invocation.command, invocation.args, { cwd: project.root });
    installResult = Object.freeze({ exitCode: result.exitCode, invocation });
    if (result.exitCode !== 0) {
      throw new CliError(`Upgrade installation failed with exit ${String(result.exitCode)}.`, { code: 'SX_UPGRADE_FAILED', details: { stderr: result.stderr.trim() } });
    }
  }
  const data = Object.freeze({
    versionSource: 'CLI compatibility metadata (no registry lookup, no guessed ranges)',
    targetVersion: SVELTEX_PACKAGE_VERSION,
    items: Object.freeze(items),
    applied: apply,
    installResult,
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: apply ? 'Upgrade applied.' : 'Upgrade report (preview).' });
};

export const migrateCommand: CommandHandler = async (args, deps) => {
  const name = args.positionals[0] ?? flagString(args, 'migration');
  if (name === undefined) {
    const data = Object.freeze({ available: MIGRATION_NAMES, note: 'Migrations are preview-only until --apply is passed.' });
    deps.reporter.result(data);
    return Object.freeze({ data, summary: 'Available migrations listed.' });
  }
  const project = await requireProject(deps.cwd);
  const root = project.root;
  const plan = await planMigration(name, {
    root,
    read: (rel) => readOptional(resolveInside(root, rel)),
  });
  const changeSet = new ChangeSet(root);
  for (const change of plan.changes) changeSet.add(resolveInside(root, change.relativePath), change.content);
  const preview = changeSet.plan();
  const apply = flagBoolean(args, 'apply') && !flagBoolean(args, 'dry-run');
  const report = apply
    ? await changeSet.apply()
    : Object.freeze({ applied: false, changes: preview, rolledBack: false });

  for (const change of report.changes) deps.reporter.info(`${change.action} ${change.path}`);
  const data = Object.freeze({
    name: plan.name,
    description: plan.description,
    applied: report.applied,
    rolledBack: report.rolledBack,
    files: report.changes,
    skipped: plan.skipped,
    previewOnly: !apply,
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: apply ? 'Migration applied.' : 'Migration preview (use --apply to write).' });
};

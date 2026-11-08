import { readFile } from 'node:fs/promises';
import type { CommandHandler, CommandOutcome } from '../types/index.js';
import { flagBoolean } from '../terminal/args.js';
import { cancelled, CliError, projectError, usageError } from '../terminal/errors.js';
import { ChangeSet } from '../safety/changes.js';
import { resolveInside } from '../safety/paths.js';
import { insertDependencies, removeDependencies } from '../project/manifest.js';
import { composeHooks } from '../integrations/hooks.js';
import { buildAddCommand, buildRemoveCommand, buildRunCommand } from '../package-manager/run.js';
import { dependencySpec, resolveIntegrations, SVELTEX_PACKAGE_VERSION, type IntegrationSpec } from '../integrations/registry.js';
import { readInstalledVersion } from '../project/discovery.js';
import { readOptional, requirePackageManager, requireProject } from './shared.js';

function requestedIntegrations(positionals: readonly string[]): readonly IntegrationSpec[] {
  if (positionals.length === 0) throw usageError('Usage: sveltex add <integration...> | sveltex remove <integration...>');
  const { found, unknown } = resolveIntegrations(positionals);
  if (unknown.length > 0) {
    throw projectError(`Unknown integration(s): ${unknown.join(', ')}. Only shipped @sveltex/* packages are supported.`, 'SX_INTEGRATION_UNKNOWN');
  }
  return found;
}

function versionEntries(integrations: readonly IntegrationSpec[]): readonly { readonly name: string; readonly version: string }[] {
  return Object.freeze(integrations.map((entry) => Object.freeze({ name: entry.packageName, version: `^${entry.version}` })));
}

function checkCompatibility(dependencies: Readonly<Record<string, string>>, devDependencies: Readonly<Record<string, string>>): void {
  const declared = { ...dependencies, ...devDependencies };
  for (const [name, range] of Object.entries(declared)) {
    if (!name.startsWith('@sveltex/') || range.startsWith('workspace:')) continue;
    if (range !== SVELTEX_PACKAGE_VERSION && range !== `^${SVELTEX_PACKAGE_VERSION}`) {
      throw projectError(
        `${name} declares "${range}" but CLI compatibility metadata only supports ${SVELTEX_PACKAGE_VERSION}. Resolve the mismatch first; the CLI never guesses a range.`,
        'SX_COMPAT_MISMATCH',
      );
    }
  }
}

export const addCommand: CommandHandler = async (args, deps) => {
  const integrations = requestedIntegrations(args.positionals);
  const project = await requireProject(deps.cwd);
  checkCompatibility(project.dependencies, project.devDependencies);
  const pm = requirePackageManager(args, project);
  const dryRun = flagBoolean(args, 'dry-run');
  const confirmed = flagBoolean(args, 'force') || flagBoolean(args, 'yes');

  const installedVersions: Record<string, string | null> = {};
  for (const entry of integrations) {
    installedVersions[entry.packageName] = (await readInstalledVersion(project.root, entry.packageName)) ?? null;
  }

  const entries = versionEntries(integrations);
  const changeSet = new ChangeSet(project.root);
  const skipped: string[] = [];

  const manifestText = await readFile(project.manifestPath, 'utf8');
  const updatedManifest = insertDependencies(manifestText, entries);
  if (updatedManifest !== manifestText) changeSet.add(project.manifestPath, updatedManifest);

  const addsSvelteKit = integrations.some((entry) => entry.id === 'sveltekit');
  const hooksPath = resolveInside(project.root, 'src/hooks.server.ts');
  let hooksComposition: 'not-needed' | 'composed' | 'already-composed' | 'no-handle' | 'missing' = 'not-needed';
  if (addsSvelteKit) {
    const existing = await readOptional(hooksPath);
    const composition = composeHooks(existing);
    hooksComposition = composition.reason;
    if (composition.changed) changeSet.add(hooksPath, composition.content);
    else if (existing !== undefined) skipped.push(`src/hooks.server.ts (${composition.reason})`);
    if (existing !== undefined && composition.changed && !confirmed && !dryRun) {
      throw cancelled('Composing src/hooks.server.ts edits an existing file. Review with --dry-run, then re-run with --yes.');
    }
  }

  const plan = changeSet.plan();
  const envNames = [...new Set(integrations.flatMap((entry) => [...entry.envNames]))].sort();
  const manualSteps = [
    ...envNames.map((name) => `Set ${name} before enabling the matching adapter (value never supplied by the CLI).`),
    ...integrations.map((entry) => `${entry.packageName}: ${entry.configHint}`),
  ];

  if (dryRun) {
    for (const change of plan) deps.reporter.info(`${change.action} ${change.path}`);
    const data = Object.freeze({
      applied: false,
      integrations: Object.freeze(integrations.map((entry) => Object.freeze({ id: entry.id, packageName: entry.packageName, version: entry.version, spec: dependencySpec(entry) }))),
      resolvedVersions: Object.freeze(installedVersions),
      files: plan,
      packageManager: pm,
      installCommand: buildAddCommand(pm, entries.map((entry) => `${entry.name}@${entry.version}`), { dev: integrations.every((entry) => entry.developmentOnly) }),
      hooksComposition,
      manualSteps: Object.freeze(manualSteps),
    });
    deps.reporter.result(data);
    return Object.freeze({ data, summary: 'Dry run complete.' });
  }

  const report = await changeSet.apply();
  const runtime = integrations.filter((entry) => !entry.developmentOnly).map(dependencySpec);
  const development = integrations.filter((entry) => entry.developmentOnly).map(dependencySpec);
  try {
    for (const [packages, isDev] of [[runtime, false], [development, true]] as const) {
      if (packages.length === 0) continue;
      const install = buildAddCommand(pm, packages, { dev: isDev });
      const result = await deps.runner(install.command, install.args, { cwd: project.root });
      if (result.exitCode !== 0) throw new CliError(`${install.command} failed with exit ${String(result.exitCode)}.`, { details: { stderr: result.stderr.trim() } });
    }
  } catch (cause) {
    await changeSet.rollback();
    throw new CliError('sveltex add failed during installation; CLI-owned file changes were rolled back.', { code: 'SX_ADD_INSTALL_FAILED', cause });
  }

  let checked: { readonly ran: boolean; readonly exitCode: number | null } = { ran: false, exitCode: null };
  if (project.scripts['check'] !== undefined) {
    const validation = buildRunCommand(pm, 'check');
    const result = await deps.runner(validation.command, validation.args, { cwd: project.root });
    checked = { ran: true, exitCode: result.exitCode };
    if (result.exitCode !== 0) deps.reporter.warn(`Project check exited with ${String(result.exitCode)}; review the output before continuing.`);
  }

  for (const change of report.changes) deps.reporter.info(`${change.action} ${change.path}`);
  for (const step of manualSteps) deps.reporter.info(step);
  deps.reporter.success(`Added ${String(integrations.length)} integration(s).`);

  const data = Object.freeze({
    applied: true,
    integrations: Object.freeze(integrations.map((entry) => entry.packageName)),
    files: report.changes,
    skipped: Object.freeze(skipped),
    packageManager: pm,
    installed: true,
    validation: checked,
    hooksComposition,
    manualSteps: Object.freeze(manualSteps),
  });
  deps.reporter.result(data);
  const outcome: CommandOutcome = Object.freeze({ data, summary: 'Integrations added.' });
  return outcome;
};

export const removeCommand: CommandHandler = async (args, deps) => {
  const integrations = requestedIntegrations(args.positionals);
  const project = await requireProject(deps.cwd);
  const pm = requirePackageManager(args, project);
  const dryRun = flagBoolean(args, 'dry-run');
  const packageNames = integrations.map((entry) => entry.packageName);

  const manifestText = await readFile(project.manifestPath, 'utf8');
  const updatedManifest = removeDependencies(manifestText, packageNames);
  const changeSet = new ChangeSet(project.root);
  if (updatedManifest !== manifestText) changeSet.add(project.manifestPath, updatedManifest);
  const plan = changeSet.plan();

  const manualSteps = [
    'No user source files were deleted. Review imports and src/hooks.server.ts manually.',
    ...integrations.map((entry) => `${entry.packageName}: remove any application wiring you added for this package.`),
  ];

  if (dryRun) {
    const data = Object.freeze({ applied: false, integrations: Object.freeze(packageNames), files: plan, packageManager: pm, manualSteps: Object.freeze(manualSteps) });
    deps.reporter.result(data);
    return Object.freeze({ data, summary: 'Dry run complete.' });
  }

  const report = await changeSet.apply();
  const uninstall = buildRemoveCommand(pm, packageNames);
  try {
    const result = await deps.runner(uninstall.command, uninstall.args, { cwd: project.root });
    if (result.exitCode !== 0) throw new CliError(`${uninstall.command} failed with exit ${String(result.exitCode)}.`, { details: { stderr: result.stderr.trim() } });
  } catch (cause) {
    await changeSet.rollback();
    throw new CliError('sveltex remove failed during uninstall; CLI-owned file changes were rolled back.', { code: 'SX_REMOVE_FAILED', cause });
  }

  for (const change of report.changes) deps.reporter.info(`${change.action} ${change.path}`);
  deps.reporter.success(`Removed ${String(integrations.length)} integration(s) from the manifest.`);

  const data = Object.freeze({
    applied: true,
    integrations: Object.freeze(packageNames),
    files: report.changes,
    packageManager: pm,
    deletedUserFiles: Object.freeze([]),
    manualSteps: Object.freeze(manualSteps),
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: 'Integrations removed.' });
};

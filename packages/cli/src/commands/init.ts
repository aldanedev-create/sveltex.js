import { readFile } from 'node:fs/promises';
import type { CommandHandler } from '../types/index.js';
import { flagBoolean } from '../terminal/args.js';
import { cancelled, CliError, projectError } from '../terminal/errors.js';
import { ChangeSet } from '../safety/changes.js';
import { resolveInside } from '../safety/paths.js';
import { insertDependencies } from '../project/manifest.js';
import { composeHooks } from '../integrations/hooks.js';
import { buildAddCommand, buildRunCommand } from '../package-manager/run.js';
import { getIntegration, type IntegrationSpec } from '../integrations/registry.js';
import { isSvelteKitProject, readOptional, requirePackageManager, requireProject } from './shared.js';

function required(id: string): IntegrationSpec {
  const entry = getIntegration(id);
  if (entry === undefined) throw new CliError(`Missing integration metadata for "${id}".`, { code: 'SX_INTEGRATION_METADATA_MISSING' });
  return entry;
}

function initFiles(name: string): readonly { readonly relativePath: string; readonly content: string }[] {
  return Object.freeze([
    Object.freeze({
      relativePath: 'sveltex.config.ts',
      content: `import { defineConfig } from '@sveltex/config';

/** Canonical SvelteX configuration. Types and validation come from @sveltex/config. */
export default defineConfig({
  app: {
    name: ${JSON.stringify(name)},
    environment: 'development'
  },
  modules: ['./src/lib/server/modules/index']
});
`,
    }),
    Object.freeze({
      relativePath: 'src/lib/server/sveltex.ts',
      content: `import { createApplication } from '@sveltex/core';
import { modules } from './modules/index';

/** One SvelteX application instance for this process. */
export const app = createApplication({
  config: {
    name: ${JSON.stringify(name)},
    environment: 'development'
  },
  modules
});
`,
    }),
    Object.freeze({
      relativePath: 'src/lib/server/modules/index.ts',
      content: `import type { ModuleDefinition } from '@sveltex/core';

/** Add generated modules here: sveltex generate module <name> */
export const modules: readonly ModuleDefinition[] = Object.freeze([]);
`,
    }),
  ]);
}

export const initCommand: CommandHandler = async (args, deps) => {
  const project = await requireProject(deps.cwd);
  if (!isSvelteKitProject(project)) {
    throw projectError('This project does not declare @sveltejs/kit, so SvelteX cannot be initialized safely.', 'SX_NOT_SVELTEKIT');
  }
  const pm = requirePackageManager(args, project);
  const dryRun = flagBoolean(args, 'dry-run');
  const noInstall = flagBoolean(args, 'no-install');
  const confirmed = flagBoolean(args, 'force') || flagBoolean(args, 'yes');

  const changeSet = new ChangeSet(project.root);
  const skipped: string[] = [];

  for (const file of initFiles(project.name)) {
    const absolute = resolveInside(project.root, file.relativePath);
    const existing = await readOptional(absolute);
    if (existing !== undefined && !confirmed) {
      skipped.push(file.relativePath);
      continue;
    }
    changeSet.add(absolute, file.content);
  }

  const hooksPath = resolveInside(project.root, 'src/hooks.server.ts');
  const hooksExisting = await readOptional(hooksPath);
  const composition = composeHooks(hooksExisting);
  if (composition.changed) changeSet.add(hooksPath, composition.content);
  else if (hooksExisting !== undefined) skipped.push(`src/hooks.server.ts (${composition.reason})`);

  const editsExistingSource = hooksExisting !== undefined && composition.changed;
  if (editsExistingSource && !confirmed && !dryRun) {
    throw cancelled('Composing src/hooks.server.ts edits an existing file. Review with --dry-run, then re-run with --yes.');
  }

  const integrations = [required('core'), required('sveltekit'), required('config')];
  const entries = integrations.map((entry) => ({ name: entry.packageName, version: `^${entry.version}` }));
  const manifestText = await readFile(project.manifestPath, 'utf8');
  const updatedManifest = insertDependencies(manifestText, entries);
  if (updatedManifest !== manifestText) changeSet.add(project.manifestPath, updatedManifest);

  const plan = changeSet.plan();
  const envNames = [...new Set(integrations.flatMap((entry) => [...entry.envNames]))].sort();
  const manualSteps = [
    `Review src/hooks.server.ts: existing handles are preserved as userHandle (${composition.reason}).`,
    ...envNames.map((name) => `Set ${name} before enabling the matching adapter (value never supplied by the CLI).`),
  ];
  if (noInstall) {
    manualSteps.push(`Install dependencies with ${pm} install (skipped by --no-install).`);
    manualSteps.push('Run your project check script yourself after installing dependencies.');
  }

  if (dryRun) {
    for (const change of plan) deps.reporter.info(`${change.action} ${change.path}`);
    const data = Object.freeze({ applied: false, files: plan, skipped: Object.freeze(skipped), packageManager: pm, installed: false, manualSteps: Object.freeze(manualSteps) });
    deps.reporter.result(data);
    return Object.freeze({ data, summary: 'Dry run complete.' });
  }

  const report = await changeSet.apply();
  let installed = false;
  if (!noInstall) {
    const install = buildAddCommand(pm, entries.map((entry) => `${entry.name}@${entry.version}`));
    try {
      const result = await deps.runner(install.command, install.args, { cwd: project.root });
      if (result.exitCode !== 0) throw new CliError(`Dependency installation failed with exit ${String(result.exitCode)}.`, { details: { stderr: result.stderr.trim() } });
      installed = true;
    } catch (cause) {
      await changeSet.rollback();
      throw new CliError('sveltex init failed during installation; CLI-owned file changes were rolled back.', { code: 'SX_INIT_INSTALL_FAILED', cause });
    }
  }

  // Only run the project's check script after a real install; checking without
  // the newly added dependencies would produce a misleading failure.
  let checked: { readonly ran: boolean; readonly exitCode: number | null } = { ran: false, exitCode: null };
  if (installed && project.scripts['check'] !== undefined) {
    const validation = buildRunCommand(pm, 'check');
    const result = await deps.runner(validation.command, validation.args, { cwd: project.root });
    checked = { ran: true, exitCode: result.exitCode };
    if (result.exitCode !== 0) deps.reporter.warn(`Project check exited with ${String(result.exitCode)}; review the output before continuing.`);
  }

  for (const change of report.changes) deps.reporter.info(`${change.action} ${change.path}`);
  deps.reporter.success(`SvelteX initialized in ${project.root}.`);

  const data = Object.freeze({
    applied: true,
    files: report.changes,
    skipped: Object.freeze(skipped),
    packageManager: pm,
    installed,
    validation: checked,
    manualSteps: Object.freeze(manualSteps),
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: 'SvelteX initialized.' });
};

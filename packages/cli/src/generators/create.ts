import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { ChangeReport, CommandDeps, PackageManagerId, PlannedChange } from '../types/index.js';
import { CliError, projectError, usageError } from '../terminal/errors.js';
import { ChangeSet } from '../safety/changes.js';
import { resolveInside, toPackageName, validateProjectName } from '../safety/paths.js';
import { buildAddCommand, buildInstallCommand, devCommand } from '../package-manager/run.js';
import { dependencySpec, getIntegration, resolveIntegrations } from '../integrations/registry.js';
import { getTemplate, OFFICIAL_DOCS_URL, type TemplateId, type TemplateSpec, type WelcomeId } from '../templates/registry.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATES_ROOT = join(PACKAGE_ROOT, 'templates');

export const templatesRoot = (): string => TEMPLATES_ROOT;

export interface CreateOptions {
  readonly name: string;
  readonly template: TemplateId;
  readonly welcome: WelcomeId;
  readonly packageManager: PackageManagerId;
  readonly noInstall: boolean;
  readonly noGit: boolean;
  readonly dryRun: boolean;
  readonly cwd: string;
  readonly docsUrl: string;
}

export interface CreatePlan {
  readonly targetDir: string;
  readonly changeSet: ChangeSet;
  readonly spec: TemplateSpec;
  readonly files: readonly PlannedChange[];
  readonly dependencies: readonly string[];
  readonly packageManager: PackageManagerId;
  readonly welcome: WelcomeId;
}

export interface CreateResult {
  readonly applied: boolean;
  readonly report: ChangeReport;
  readonly targetDir: string;
  readonly template: TemplateId;
  readonly welcome: WelcomeId;
  readonly packageManager: PackageManagerId;
  readonly installed: boolean;
  readonly gitInitialized: boolean;
  readonly manualSteps: readonly string[];
}

async function collect(dir: string, prefix: string, out: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    throw new CliError(`Template directory is missing: ${dir}`, { code: 'SX_TEMPLATE_MISSING', cause });
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, `${prefix}${entry.name}/`, out);
      continue;
    }
    // Symlinks are deliberately not followed: template assets must stay local to the package.
    if (!entry.isFile() || !entry.name.endsWith('.tmpl')) continue;
    out.set(`${prefix}${entry.name.slice(0, -('.tmpl').length)}`, await readFile(full, 'utf8'));
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render(content: string, variables: Readonly<Record<string, string>>): string {
  return content.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => variables[key] ?? match);
}

/** Build a complete, previewable file plan without touching the filesystem. */
export async function planCreate(options: CreateOptions): Promise<CreatePlan> {
  const name = validateProjectName(options.name);
  const spec = getTemplate(options.template);
  if (!spec.welcomeChoices.includes(options.welcome)) {
    throw usageError(
      `Welcome page "${options.welcome}" is not available for template "${spec.id}". Choose: ${spec.welcomeChoices.join(', ')}.`,
      'SX_WELCOME_UNSUPPORTED',
    );
  }

  const targetDir = resolve(options.cwd, name);
  try {
    const existing = await readdir(targetDir);
    if (existing.length > 0) {
      throw projectError(`Directory "${name}" already exists and is not empty. Choose another name.`, 'SX_TARGET_NOT_EMPTY');
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
  }

  const sources = new Map<string, string>();
  await collect(join(TEMPLATES_ROOT, '_base'), '', sources);
  await collect(join(TEMPLATES_ROOT, spec.id), '', sources);
  await collect(join(TEMPLATES_ROOT, '_pages', options.welcome), 'src/routes/', sources);

  const { found, unknown } = resolveIntegrations(spec.sveltexPackages);
  if (unknown.length > 0) throw new CliError(`Template references unknown integrations: ${unknown.join(', ')}`, { code: 'SX_TEMPLATE_INVALID' });
  const dependencies = found.map(dependencySpec);
  const depLines = found.map((entry) => `    ${JSON.stringify(entry.packageName)}: ${JSON.stringify(`^${entry.version}`)}`).join(',\n');

  const exampleLinks = spec.exampleRoutes
    .map((route) => `          <li><a href="${escapeHtml(route)}">${escapeHtml(route === '/' ? 'Home' : route)}</a></li>`)
    .join('\n');
  const installedList = found
    .map((entry) => `          <li><code>${escapeHtml(entry.packageName)}</code> — ${escapeHtml(entry.description)}</li>`)
    .join('\n');

  const variables: Record<string, string> = {
    APP_NAME: name,
    PACKAGE_NAME: toPackageName(name),
    PM: options.packageManager,
    DEV_COMMAND: devCommand(options.packageManager),
    INSTALL_COMMAND: `${options.packageManager} install`,
    DOCS_URL: options.docsUrl === '' ? OFFICIAL_DOCS_URL : options.docsUrl,
    TEMPLATE_ID: spec.id,
    TEMPLATE_DESCRIPTION: spec.description,
    SVELTEX_DEPENDENCIES: depLines,
    EXAMPLE_LINKS: exampleLinks,
    INSTALLED_LIST: installedList,
  };

  const changeSet = new ChangeSet(targetDir);
  for (const [relativePath, content] of sources) {
    changeSet.add(resolveInside(targetDir, relativePath), render(content, variables));
  }

  return Object.freeze({
    targetDir,
    changeSet,
    spec,
    files: changeSet.plan(),
    dependencies: Object.freeze(dependencies),
    packageManager: options.packageManager,
    welcome: options.welcome,
  });
}

/** Apply a plan, install with the detected manager, and roll back CLI-owned files on failure. */
export async function executeCreate(options: CreateOptions, deps: CommandDeps, plan?: CreatePlan): Promise<CreateResult> {
  const resolved = plan ?? await planCreate(options);
  if (options.dryRun) {
    return Object.freeze({
      applied: false,
      report: Object.freeze({ applied: false, changes: resolved.files, rolledBack: false }),
      targetDir: resolved.targetDir,
      template: resolved.spec.id,
      welcome: resolved.welcome,
      packageManager: resolved.packageManager,
      installed: false,
      gitInitialized: false,
      manualSteps: Object.freeze([`Start development with ${devCommand(resolved.packageManager)}`]),
    });
  }

  const report = await resolved.changeSet.apply();
  let installed = false;
  let gitInitialized = false;

  if (!options.noInstall) {
    const { command, args } = buildInstallCommand(resolved.packageManager);
    const result = await deps.runner(command, args, { cwd: resolved.targetDir });
    if (result.exitCode !== 0) {
      await resolved.changeSet.rollback();
      throw new CliError(`Dependency installation failed (${command} ${args.join(' ')}, exit ${String(result.exitCode)}); generated files were rolled back.`, {
        code: 'SX_INSTALL_FAILED',
        details: { stderr: result.stderr.trim() },
      });
    }
    installed = true;
  }

  if (!options.noGit) {
    const result = await deps.runner('git', ['init'], { cwd: resolved.targetDir });
    gitInitialized = result.exitCode === 0;
    if (!gitInitialized) deps.reporter.warn('git init was unavailable; the project was still created.');
  }

  const envNames = new Set<string>();
  for (const id of resolved.spec.sveltexPackages) {
    const entry = getIntegration(id);
    if (entry !== undefined) for (const envName of entry.envNames) envNames.add(envName);
  }
  const manualSteps = [
    `Start development with ${devCommand(resolved.packageManager)}`,
    ...(!installed ? [`Install dependencies with ${resolved.packageManager} install`] : []),
    ...[...envNames].sort().map((envName) => `Set ${envName} before enabling the corresponding adapter (the CLI never invents values).`),
  ];

  return Object.freeze({
    applied: true,
    report,
    targetDir: resolved.targetDir,
    template: resolved.spec.id,
    welcome: resolved.welcome,
    packageManager: resolved.packageManager,
    installed,
    gitInitialized,
    manualSteps: Object.freeze(manualSteps),
  });
}

/** Exposed for command-layer reuse: build an add invocation for a template's packages. */
export function templateAddInvocation(pm: PackageManagerId, specId: TemplateId) {
  const spec = getTemplate(specId);
  const { found, unknown } = resolveIntegrations(spec.sveltexPackages);
  if (unknown.length > 0) throw new CliError(`Unknown integrations: ${unknown.join(', ')}`, { code: 'SX_TEMPLATE_INVALID' });
  return buildAddCommand(pm, found.map(dependencySpec));
}

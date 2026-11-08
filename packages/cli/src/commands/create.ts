import type { CommandHandler } from '../types/index.js';
import { flagBoolean, flagString } from '../terminal/args.js';
import { usageError } from '../terminal/errors.js';
import { isPackageManagerId } from '../package-manager/detect.js';
import { getTemplate, isTemplateId, isWelcomeId, OFFICIAL_DOCS_URL } from '../templates/registry.js';
import { executeCreate, planCreate, type CreateOptions } from '../generators/create.js';

export const createCommand: CommandHandler = async (args, deps) => {
  const name = args.positionals[0];
  if (name === undefined) throw usageError('Usage: sveltex create <name> [--template <id>] [--welcome <id>] [--package-manager <pm>] [--no-install] [--no-git] [--dry-run]');

  const templateRaw = flagString(args, 'template') ?? 'fullstack';
  if (!isTemplateId(templateRaw)) {
    throw usageError(`Unknown template "${templateRaw}". Available: minimal, fullstack, api, dashboard, saas, documentation.`, 'SX_TEMPLATE_UNKNOWN');
  }
  const spec = getTemplate(templateRaw);
  const welcomeRaw = flagString(args, 'welcome');
  if (welcomeRaw !== undefined && !isWelcomeId(welcomeRaw)) {
    throw usageError(`Unknown welcome page "${welcomeRaw}". Available: welcome, blank, dashboard, docs.`, 'SX_WELCOME_UNKNOWN');
  }
  const welcome = welcomeRaw ?? spec.defaultWelcome;

  const pmRaw = flagString(args, 'package-manager') ?? flagString(args, 'pm') ?? 'pnpm';
  if (!isPackageManagerId(pmRaw)) throw usageError(`Unsupported package manager "${pmRaw}".`, 'SX_PM_UNSUPPORTED');

  const options: CreateOptions = {
    name,
    template: templateRaw,
    welcome,
    packageManager: pmRaw,
    noInstall: flagBoolean(args, 'no-install'),
    noGit: flagBoolean(args, 'no-git'),
    dryRun: flagBoolean(args, 'dry-run'),
    cwd: deps.cwd,
    docsUrl: flagString(args, 'docs-url') ?? OFFICIAL_DOCS_URL,
  };

  const plan = await planCreate(options);
  const result = await executeCreate(options, deps, plan);

  for (const change of result.report.changes) deps.reporter.info(`${change.action} ${change.path}`);
  for (const step of result.manualSteps) deps.reporter.info(step);
  deps.reporter.success(result.applied
    ? `Created ${result.targetDir} from template ${result.template}.`
    : `Dry run: ${String(result.report.changes.length)} file(s) planned for ${result.targetDir}.`);

  const data = Object.freeze({
    template: result.template,
    welcome: result.welcome,
    packageManager: result.packageManager,
    targetDir: result.targetDir,
    applied: result.applied,
    installed: result.installed,
    gitInitialized: result.gitInitialized,
    rolledBack: result.report.rolledBack,
    files: result.report.changes,
    dependencies: plan.dependencies,
    manualSteps: result.manualSteps,
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: result.applied ? `Created ${result.targetDir}.` : 'Dry run complete.' });
};

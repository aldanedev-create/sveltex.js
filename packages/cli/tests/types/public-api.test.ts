import type {
  CliExitCode, CommandDeps, CommandOutcome, CommandSpec, ProcessRunner, ProcessResult,
  Diagnostic, DiagnosticSeverity, PackageManagerId, ParsedArgs, PlannedChange, ChangeReport,
  ProjectInfo, Reporter, CliResult,
} from '../../dist/index.js';
import type { TemplateId, WelcomeId, TemplateSpec } from '../../dist/index.js';
import type { IntegrationSpec } from '../../dist/index.js';
import type { GeneratorKind, CreateOptions, CreatePlan, MigrationPlan, RouteInfo } from '../../dist/index.js';
import {
  EXIT, runCli, parseArgs, globalOptions, flagString, flagBoolean,
  CliError, usageError, projectError, cancelled, asCliError,
  DefaultReporter, buildResult, renderResult,
  validateProjectName, toPackageName, safeRelativePath, resolveInside, isInside, ChangeSet,
  detectLockfiles, resolvePackageManager, parsePackageManagerField, buildAddCommand,
  buildRemoveCommand, buildRunCommand, defaultRunner,
  discoverProject, readInstalledVersion, insertDependencies, removeDependencies,
  redactValue, isSecretKey, inspectConfigText, validateSvelteXConfig,
  INTEGRATIONS, SVELTEX_PACKAGE_VERSION, getIntegration, dependencySpec, resolveIntegrations,
  composeHooks, TEMPLATES, TEMPLATE_IDS, getTemplate, isTemplateId, isWelcomeId, OFFICIAL_DOCS_URL,
  planCreate, executeCreate, templatesRoot, generateFile, GENERATOR_KINDS, validateArtifactName,
  runDoctor, isSupportedNode, NODE_MINIMUM, collectRoutes, planMigration, MIGRATION_NAMES,
  COMMANDS, getCommandSpec, DELEGATED_SCRIPTS, makeDelegateCommand, cliVersion,
} from '../../dist/index.js';

const ok: CliExitCode = EXIT.OK;
const usage: CliExitCode = EXIT.USAGE;
const project: CliExitCode = EXIT.PROJECT;
const cancel: CliExitCode = EXIT.CANCELLED;
void ok; void usage; void project; void cancel;

const pm: PackageManagerId = 'pnpm';
const template: TemplateId = 'fullstack';
const welcome: WelcomeId = 'welcome';
const kind: GeneratorKind = 'module';
const severity: DiagnosticSeverity = 'warning';
void pm; void template; void welcome; void kind; void severity;

// @ts-expect-error unsupported package manager
const badPm: PackageManagerId = 'deno';
// @ts-expect-error unsupported template
const badTemplate: TemplateId = 'billing';
// @ts-expect-error unsupported welcome page
const badWelcome: WelcomeId = 'pricing';
void badPm; void badTemplate; void badWelcome;

const parsed: ParsedArgs = parseArgs(['create', 'app', '--json']);
const json = flagBoolean(parsed, 'json');
const templateArg = flagString(parsed, 'template');
const globals = globalOptions(parsed, '/tmp');
void json; void templateArg; void globals;

const reporter: Reporter = new DefaultReporter(true, () => undefined, () => undefined);
const processResult: ProcessResult = { exitCode: 0, stdout: '', stderr: '' };
const runner: ProcessRunner = defaultRunner;
void processResult; void runner;

const deps: CommandDeps = {
  cwd: '/tmp',
  env: {},
  reporter,
  runner,
  now: () => 0,
  nodeVersion: '22.13.1',
};
void deps;

const outcome: CommandOutcome = { data: null, summary: 'ok', exitCode: EXIT.OK };
const spec: CommandSpec | undefined = getCommandSpec('create');
const result: CliResult = buildResult({ command: 'create', outcome, reporter, exitCode: EXIT.OK });
void spec; void outcome; void result;
const rendered: string = renderResult(result, true);
void rendered;

const errors: CliError[] = [usageError('x'), projectError('y'), cancelled(), asCliError(new Error('z'))];
void errors;

const specEntry: IntegrationSpec | undefined = getIntegration('core');
const resolved = resolveIntegrations(['cache', 'unknown']);
const version: string = SVELTEX_PACKAGE_VERSION;
const depSpec: string | undefined = specEntry === undefined ? undefined : dependencySpec(specEntry);
void version; void depSpec; void resolved; void INTEGRATIONS;

const configResult = validateSvelteXConfig({ app: { name: 'x' } });
if (configResult.success) {
  const appName: unknown = configResult.data.app['name'];
  void appName;
}
const inspection = inspectConfigText('export default {}');
const redacted: unknown = redactValue({ token: 'x' });
void inspection; void redacted; void isSecretKey;

const templateSpec: TemplateSpec = getTemplate('minimal');
void templateSpec; void TEMPLATES; void TEMPLATE_IDS; void OFFICIAL_DOCS_URL;
void isTemplateId; void isWelcomeId;
const hooks = composeHooks(undefined);
void hooks;

const createOptions: CreateOptions = {
  name: 'app', template: 'minimal', welcome: 'blank', packageManager: 'pnpm',
  noInstall: true, noGit: true, dryRun: true, cwd: '/tmp', docsUrl: OFFICIAL_DOCS_URL,
};
const createPlan: Promise<CreatePlan> = planCreate(createOptions);
void createPlan; void executeCreate; void templatesRoot;
const generated = generateFile({ kind: 'module', name: 'users' });
void generated; void GENERATOR_KINDS; void validateArtifactName;

const doctorReport = runDoctor({
  project: undefined, nodeVersion: '22.13.1', configSource: undefined, hooksSource: undefined,
  packageManager: undefined, pmVersionExitCode: undefined, env: {},
});
void doctorReport; void isSupportedNode; void NODE_MINIMUM;
const routes: Promise<readonly RouteInfo[]> = collectRoutes('/tmp');
void routes; void MIGRATION_NAMES; void planMigration;

const migration: Promise<MigrationPlan> = planMigration('gitignore-env', { root: '/tmp', read: async () => undefined });
void migration;

const diagnostic: Diagnostic = { code: 'SX_X', severity: 'info', message: 'm' };
const change: PlannedChange = { path: 'a', action: 'create', bytes: 1 };
const changeReport: ChangeReport = { applied: false, changes: [change], rolledBack: false };
void diagnostic; void changeReport;
const changes = new ChangeSet('/tmp');
void changes;

const projectInfo: Promise<ProjectInfo | undefined> = discoverProject('/tmp');
void projectInfo; void readInstalledVersion; void insertDependencies; void removeDependencies;
void detectLockfiles; void resolvePackageManager; void parsePackageManagerField;
void buildAddCommand; void buildRemoveCommand; void buildRunCommand;
void validateProjectName; void toPackageName; void safeRelativePath; void resolveInside; void isInside;

const cliResult: Promise<CliResult> = runCli({
  argv: ['--help'], cwd: '/tmp', env: {}, runner, nodeVersion: '22.13.1', now: () => 0,
});
void cliResult;
const commands: readonly CommandSpec[] = COMMANDS;
void commands; void DELEGATED_SCRIPTS; void makeDelegateCommand;
const versionPromise: Promise<string> = cliVersion();
void versionPromise;

/** Stable exit codes. See docs/specification.md §5.11. */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  PROJECT: 3,
  CANCELLED: 4,
} as const;

export type CliExitCode = (typeof EXIT)[keyof typeof EXIT];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PackageManagerId = 'pnpm' | 'npm' | 'yarn' | 'bun';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogMessage {
  readonly level: LogLevel;
  readonly message: string;
}

/** Output boundary. In JSON mode human lines are buffered instead of printed. */
export interface Reporter {
  readonly json: boolean;
  readonly messages: readonly LogMessage[];
  readonly data: unknown;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  result(data: unknown): void;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Injectable external-process boundary. Never spawns through a shell. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<ProcessResult>;

export interface CommandDeps {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly reporter: Reporter;
  readonly runner: ProcessRunner;
  readonly now: () => number;
  readonly nodeVersion: string;
}

export interface GlobalOptions {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly force: boolean;
  readonly help: boolean;
  readonly cwd: string;
}

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export interface CommandOutcome {
  readonly data: unknown;
  readonly summary?: string;
  /** Commands may override the success exit code (e.g. doctor with errors). */
  readonly exitCode?: CliExitCode;
}

export interface CliResult {
  readonly exitCode: CliExitCode;
  readonly command: string | undefined;
  readonly ok: boolean;
  readonly data: unknown;
  readonly messages: readonly LogMessage[];
  readonly error?: { readonly code: string; readonly message: string };
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
  readonly fix?: string;
}

export interface PlannedChange {
  readonly path: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly bytes: number;
}

export interface ChangeReport {
  readonly applied: boolean;
  readonly changes: readonly PlannedChange[];
  readonly rolledBack: boolean;
}

export interface LockfileDetection {
  readonly manager: PackageManagerId;
  readonly file: string;
}

export interface ProjectInfo {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly packageManager: PackageManagerId | undefined;
  readonly declaredPackageManager: string | undefined;
  readonly lockfiles: readonly LockfileDetection[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly configPath: string | undefined;
  readonly svelteConfigPath: string | undefined;
  readonly hooksPath: string | undefined;
}

export interface CommandHandler {
  (args: ParsedArgs, deps: CommandDeps): Promise<CommandOutcome>;
}

export interface CommandSpec {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly run: CommandHandler;
}

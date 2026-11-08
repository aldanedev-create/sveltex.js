import { EXIT, type CliResult, type CommandDeps, type ProcessRunner } from './types/index.js';
import { globalOptions, parseArgs } from './terminal/args.js';
import { asCliError, usageError } from './terminal/errors.js';
import { buildResult, DefaultReporter } from './terminal/output.js';
import { COMMANDS, getCommandSpec } from './commands/index.js';

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runner: ProcessRunner;
  readonly nodeVersion: string;
  readonly now: () => number;
}

/** Framework-agnostic dispatcher: commands never call process.exit directly. */
export async function runCli(options: RunCliOptions): Promise<CliResult> {
  let args;
  try {
    args = parseArgs(options.argv);
  } catch (cause) {
    const error = asCliError(cause);
    const reporter = new DefaultReporter(false);
    reporter.error(error.message);
    return buildResult({ command: undefined, outcome: undefined, reporter, exitCode: error.exitCode, error });
  }

  const globals = globalOptions(args, options.cwd);
  const reporter = new DefaultReporter(globals.json);

  if (globals.help || args.command === undefined) {
    for (const entry of COMMANDS) reporter.info(`${entry.usage}  ${entry.description}`);
    const data = Object.freeze({
      commands: Object.freeze(COMMANDS.map((entry) => Object.freeze({ name: entry.name, usage: entry.usage, description: entry.description }))),
    });
    if (args.command === undefined && !globals.help) {
      const error = usageError('Missing command. Run sveltex --help for usage.');
      reporter.error(error.message);
      return buildResult({ command: undefined, outcome: undefined, reporter, exitCode: EXIT.USAGE, error });
    }
    reporter.result(data);
    return buildResult({ command: args.command, outcome: Object.freeze({ data }), reporter, exitCode: EXIT.OK });
  }

  const commandSpec = getCommandSpec(args.command);
  if (commandSpec === undefined) {
    const error = usageError(`Unknown command "${args.command}". Run sveltex --help for usage.`, 'SX_CLI_UNKNOWN_COMMAND');
    reporter.error(error.message);
    return buildResult({ command: args.command, outcome: undefined, reporter, exitCode: EXIT.USAGE, error });
  }

  const deps: CommandDeps = Object.freeze({
    cwd: globals.cwd,
    env: options.env,
    reporter,
    runner: options.runner,
    now: options.now,
    nodeVersion: options.nodeVersion,
  });

  try {
    const outcome = await commandSpec.run(args, deps);
    return buildResult({ command: args.command, outcome, reporter, exitCode: outcome.exitCode ?? EXIT.OK });
  } catch (cause) {
    const error = asCliError(cause);
    reporter.error(error.message);
    return buildResult({ command: args.command, outcome: undefined, reporter, exitCode: error.exitCode, error });
  }
}

import type { CommandHandler } from '../types/index.js';
import { flagBoolean } from '../terminal/args.js';
import { CliError, projectError } from '../terminal/errors.js';
import { buildRunCommand } from '../package-manager/run.js';
import { requirePackageManager, requireProject } from './shared.js';

/** The CLI delegates to the project's own scripts; it never reimplements build tooling. */
export const DELEGATED_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  dev: 'dev',
  build: 'build',
  preview: 'preview',
  check: 'check',
  test: 'test',
});

export function makeDelegateCommand(command: string): CommandHandler {
  return async (args, deps) => {
    const script = DELEGATED_SCRIPTS[command];
    if (script === undefined) throw projectError(`No delegation mapping for "${command}".`, 'SX_DELEGATION_UNKNOWN');
    const project = await requireProject(deps.cwd);
    if (project.scripts[script] === undefined) {
      throw projectError(`This project has no "${script}" script. Add one to package.json before using sveltex ${command}.`, 'SX_SCRIPT_MISSING');
    }
    const pm = requirePackageManager(args, project);
    const invocation = buildRunCommand(pm, script, args.positionals);
    const dryRun = flagBoolean(args, 'dry-run');

    if (dryRun) {
      const data = Object.freeze({ applied: false, command, script, packageManager: pm, invocation });
      deps.reporter.result(data);
      return Object.freeze({ data, summary: 'Dry run complete.' });
    }

    const result = await deps.runner(invocation.command, invocation.args, { cwd: project.root });
    if (result.exitCode !== 0) {
      throw new CliError(`sveltex ${command} delegated to "${invocation.command} ${invocation.args.join(' ')}" which exited with ${String(result.exitCode)}.`, {
        code: 'SX_DELEGATED_COMMAND_FAILED',
        details: { stderr: result.stderr.trim().slice(0, 2000) },
      });
    }
    deps.reporter.success(`${command} completed through ${invocation.command}.`);
    const data = Object.freeze({ applied: true, command, script, packageManager: pm, invocation, exitCode: result.exitCode });
    deps.reporter.result(data);
    return Object.freeze({ data, summary: `${command} completed.` });
  };
}

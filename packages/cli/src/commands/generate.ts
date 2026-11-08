import type { CommandHandler } from '../types/index.js';
import { flagBoolean } from '../terminal/args.js';
import { projectError, usageError } from '../terminal/errors.js';
import { ChangeSet } from '../safety/changes.js';
import { resolveInside } from '../safety/paths.js';
import { generateFile, GENERATOR_KINDS, isGeneratorKind } from '../generators/files.js';
import { readOptional, requireProject } from './shared.js';

export const generateCommand: CommandHandler = async (args, deps) => {
  const kind = args.positionals[0];
  const name = args.positionals[1];
  if (kind === undefined || name === undefined) {
    throw usageError('Usage: sveltex generate <kind> <name> [--dry-run] [--force]', 'SX_CLI_USAGE');
  }
  if (!isGeneratorKind(kind)) {
    throw usageError(`Unknown generator kind "${kind}". Available: ${GENERATOR_KINDS.join(', ')}.`, 'SX_GENERATOR_UNKNOWN');
  }

  const project = await requireProject(deps.cwd);
  const file = generateFile({ kind, name });
  const absolute = resolveInside(project.root, file.relativePath);
  const existing = await readOptional(absolute);
  if (existing !== undefined && !flagBoolean(args, 'force')) {
    throw projectError(`File ${file.relativePath} already exists. Review it and re-run with --force to overwrite explicitly.`, 'SX_FILE_EXISTS');
  }

  const changeSet = new ChangeSet(project.root);
  changeSet.add(absolute, file.content);
  const plan = changeSet.plan();
  const dryRun = flagBoolean(args, 'dry-run');
  const report = dryRun
    ? Object.freeze({ applied: false, changes: plan, rolledBack: false })
    : await changeSet.apply();
  if (!dryRun) deps.reporter.success(`Generated ${file.relativePath}.`);

  const data = Object.freeze({
    kind,
    name,
    path: file.relativePath,
    applied: report.applied,
    files: report.changes,
    overwritten: existing !== undefined,
  });
  deps.reporter.result(data);
  return Object.freeze({ data, summary: dryRun ? 'Dry run complete.' : `Generated ${file.relativePath}.` });
};

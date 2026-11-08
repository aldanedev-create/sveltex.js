import type { CommandSpec } from '../types/index.js';
import { createCommand } from './create.js';
import { initCommand } from './init.js';
import { addCommand, removeCommand } from './integrations.js';
import { generateCommand } from './generate.js';
import { DELEGATED_SCRIPTS, makeDelegateCommand } from './delegate.js';
import { configCommand, doctorCommand, infoCommand, migrateCommand, modulesCommand, routesCommand, upgradeCommand } from './inspect.js';

function spec(entry: CommandSpec): CommandSpec {
  return Object.freeze(entry);
}

export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  spec({ name: 'create', usage: 'sveltex create <name> [options]', description: 'Create a project from one of six official templates.', run: createCommand }),
  spec({ name: 'init', usage: 'sveltex init [options]', description: 'Add SvelteX to an existing SvelteKit project, preserving existing hooks.', run: initCommand }),
  spec({ name: 'add', usage: 'sveltex add <integration...> [options]', description: 'Install and configure official packages.', run: addCommand }),
  spec({ name: 'remove', usage: 'sveltex remove <integration...> [options]', description: 'Remove integrations without deleting unrelated user code.', run: removeCommand }),
  spec({ name: 'generate', usage: 'sveltex generate <kind> <name> [options]', description: 'Generate a module, service, middleware, route, component, or test.', run: generateCommand }),
  spec({ name: 'doctor', usage: 'sveltex doctor [options]', description: 'Diagnose Node, package manager, config, hooks, and compatibility health.', run: doctorCommand }),
  spec({ name: 'info', usage: 'sveltex info [options]', description: 'Display CLI, Node, and framework versions without exposing secrets.', run: infoCommand }),
  spec({ name: 'routes', usage: 'sveltex routes [options]', description: 'List routes derived from the SvelteKit filesystem convention.', run: routesCommand }),
  spec({ name: 'modules', usage: 'sveltex modules [options]', description: 'Inspect registered modules via static source inspection.', run: modulesCommand }),
  spec({ name: 'config', usage: 'sveltex config [options]', description: 'Validate and inspect configuration statically with secret redaction.', run: configCommand }),
  spec({ name: 'upgrade', usage: 'sveltex upgrade [--apply]', description: 'Report and apply supported package upgrades.', run: upgradeCommand }),
  spec({ name: 'migrate', usage: 'sveltex migrate <name> [--apply]', description: 'Preview and apply a named migration.', run: migrateCommand }),
  ...Object.keys(DELEGATED_SCRIPTS).map((name) => spec({
    name,
    usage: `sveltex ${name} [args...]`,
    description: `Delegate to the project's own "${DELEGATED_SCRIPTS[name] ?? name}" script.`,
    run: makeDelegateCommand(name),
  })),
]);

export function getCommandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((entry) => entry.name === name);
}

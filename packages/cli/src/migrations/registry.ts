import { composeHooks } from '../integrations/hooks.js';
import { usageError } from '../terminal/errors.js';

export interface MigrationChange {
  readonly relativePath: string;
  readonly content: string;
}

export interface MigrationPlan {
  readonly name: string;
  readonly description: string;
  readonly changes: readonly MigrationChange[];
  readonly skipped: readonly string[];
}

export interface MigrationContext {
  readonly root: string;
  readonly read: (relativePath: string) => Promise<string | undefined>;
}

export const MIGRATION_NAMES = ['hooks-sequence', 'gitignore-env'] as const;
export type MigrationName = (typeof MIGRATION_NAMES)[number];

function isMigrationName(value: string): value is MigrationName {
  return (MIGRATION_NAMES as readonly string[]).includes(value);
}

async function planHooksSequence(ctx: MigrationContext): Promise<MigrationPlan> {
  const source = await ctx.read('src/hooks.server.ts');
  const composition = composeHooks(source);
  const changes: MigrationChange[] = composition.changed
    ? [Object.freeze({ relativePath: 'src/hooks.server.ts', content: composition.content })]
    : [];
  return Object.freeze({
    name: 'hooks-sequence',
    description: 'Compose an existing SvelteKit handle with createSvelteXHandler through sequence(), preserving user code.',
    changes: Object.freeze(changes),
    skipped: Object.freeze(composition.changed ? [] : [`src/hooks.server.ts: ${composition.reason}`]),
  });
}

async function planGitignoreEnv(ctx: MigrationContext): Promise<MigrationPlan> {
  const source = await ctx.read('.gitignore');
  const changes: MigrationChange[] = [];
  if (source === undefined) {
    changes.push(Object.freeze({ relativePath: '.gitignore', content: 'node_modules\n/.svelte-kit\n/build\n/.env\n/.env.*\n!/.env.example\n' }));
  } else if (!/(^|\n)\s*\/?\.env\b/.test(source)) {
    changes.push(Object.freeze({ relativePath: '.gitignore', content: `${source.trimEnd()}\n\n# Added by sveltex migrate gitignore-env\n/.env\n/.env.*\n!/.env.example\n` }));
  }
  return Object.freeze({
    name: 'gitignore-env',
    description: 'Ensure local environment files are ignored without removing existing rules.',
    changes: Object.freeze(changes),
    skipped: Object.freeze(changes.length === 0 ? ['.gitignore: already contains .env rules'] : []),
  });
}

export async function planMigration(name: string, ctx: MigrationContext): Promise<MigrationPlan> {
  if (!isMigrationName(name)) {
    throw usageError(`Unknown migration "${name}". Available: ${MIGRATION_NAMES.join(', ')}.`, 'SX_MIGRATION_UNKNOWN');
  }
  return name === 'hooks-sequence' ? planHooksSequence(ctx) : planGitignoreEnv(ctx);
}

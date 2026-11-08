/** Minimal, reversible text composition for an existing SvelteKit hooks file. */
export interface HooksComposition {
  readonly content: string;
  readonly changed: boolean;
  readonly reason: 'already-composed' | 'no-handle' | 'composed' | 'missing';
}

const IMPORTS = [
  "import { sequence } from '@sveltejs/kit/hooks';",
  "import { createSvelteXHandler } from '@sveltex/sveltekit';",
  "import { app } from '$lib/server/sveltex';",
  '',
].join('\n');

const NEW_HOOKS = `${IMPORTS}
/**
 * SvelteX is composed with SvelteKit's own sequence() helper. Add further
 * handles as arguments to sequence(); do not replace the SvelteX handle.
 */
export const handle = sequence(createSvelteXHandler(app));
`;

/**
 * Preserve user code by renaming the existing `handle` export to `userHandle`
 * and appending a composed export. The original file is never replaced wholesale.
 */
export function composeHooks(source: string | undefined): HooksComposition {
  if (source === undefined) {
    return Object.freeze({ content: NEW_HOOKS, changed: true, reason: 'missing' });
  }
  if (source.includes('createSvelteXHandler')) {
    return Object.freeze({ content: source, changed: false, reason: 'already-composed' });
  }
  const handlePattern = /export\s+const\s+handle\b(\s*:\s*Handle\s*)?\s*=\s*/;
  if (!handlePattern.test(source)) {
    return Object.freeze({ content: source, changed: false, reason: 'no-handle' });
  }
  const renamed = source.replace(handlePattern, (_match: string, annotation?: string): string => {
    const suffix = annotation === undefined ? '' : annotation.trim();
    return `const userHandle${suffix} = `;
  });
  let content = IMPORTS + renamed;
  content = `${content.trimEnd()}\n\n// Composed by the sveltex CLI. Your original handle is preserved as userHandle.\nexport const handle = sequence(createSvelteXHandler(app), userHandle);\n`;
  return Object.freeze({ content, changed: true, reason: 'composed' });
}

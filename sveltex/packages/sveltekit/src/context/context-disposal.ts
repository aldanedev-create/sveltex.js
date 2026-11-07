import type { SvelteXRequestContext } from '../types/context.types.js';
export async function disposeContext(context: SvelteXRequestContext): Promise<void> { await context.dispose(); }

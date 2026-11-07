import type { SvelteXRequestContext } from '../types/context.types.js';
export async function disposeRequest(context: SvelteXRequestContext): Promise<void> { await context.dispose(); }

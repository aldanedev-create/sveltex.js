import { createSvelteXHandler } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';
export const handle = createSvelteXHandler(app);

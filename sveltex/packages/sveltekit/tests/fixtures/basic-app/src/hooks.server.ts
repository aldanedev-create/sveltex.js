import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { createSvelteXHandler } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';

const sveltex = createSvelteXHandler(app);
const audit: Handle = async ({ event, resolve }) => {
  event.locals.audit = true;
  return resolve(event);
};

export const handle = sequence(sveltex, audit);

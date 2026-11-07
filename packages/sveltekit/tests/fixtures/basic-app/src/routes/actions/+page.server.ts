import { HealthMessage } from '$lib/server/sveltex';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals }) => ({ message: await locals.sveltex.resolve(HealthMessage) });
export const actions: Actions = {
  default: async ({ locals }) => ({ message: await locals.sveltex.resolve(HealthMessage), audited: locals.audit })
};

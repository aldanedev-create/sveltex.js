import { HealthMessage } from '$lib/server/sveltex';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals }) => ({ message: await locals.sveltex.resolve(HealthMessage) });

import { HealthMessage } from '$lib/server/sveltex';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ locals }) => Response.json({ status: await locals.sveltex.resolve(HealthMessage) });

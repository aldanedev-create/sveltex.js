import type { Application } from '@sveltex/core';
import { beginShutdown, getActiveRequestCount } from '../application/application-runtime.js';

/** Stop accepting requests, wait for in-flight requests to dispose their scopes, then stop Core. */
export async function shutdownApplication(application: Application): Promise<void> {
  await beginShutdown(application);
}

/** Number of requests currently executing through SvelteX handles for this app. */
export { getActiveRequestCount };

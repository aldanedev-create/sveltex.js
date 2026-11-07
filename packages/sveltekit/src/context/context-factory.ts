import type { Application } from '@sveltex/core';
import type { SvelteKitRequestEvent } from '../types/handle.types.js';
import { RequestContext } from './request-context.js';
export function createRequestContext(application: Application, event: SvelteKitRequestEvent): RequestContext {
  return new RequestContext(application, application.createRequestScope(), event);
}

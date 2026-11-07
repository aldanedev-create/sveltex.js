import type { Application } from '@sveltex/core';
import { acquireRequest, ensureApplicationStarted } from './application-runtime.js';
import { createRequestContext } from '../context/context-factory.js';
import { clearRequestContext } from '../context/context-store.js';
import { attachContextToLocals } from '../locals/locals-bridge.js';
import type { Handle, SvelteKitRequestEvent } from '../types/handle.types.js';
import type { SvelteXHandlerOptions } from '../types/config.types.js';
import { validateSvelteXKitConfig } from '../configuration/validate-config.js';

/**
 * Create a SvelteKit Handle that starts the application once and gives every
 * request its own DI scope. The scope is disposed after the downstream handle
 * and route resolution have completed.
 */
export function createSvelteXHandler(application: Application, options: SvelteXHandlerOptions = {}): Handle {
  validateSvelteXKitConfig(options);
  const key = options.localsKey ?? 'sveltex';
  const autoStart = options.autoStart ?? true;

  return async ({ event, resolve }) => {
    if (autoStart) await ensureApplicationStarted(application);
    else if (application.state !== 'running') {
      throw new Error(`SvelteX application must be running before handling requests (current state: ${application.state}).`);
    }

    const releaseRequest = acquireRequest(application);
    let context: ReturnType<typeof createRequestContext> | undefined;
    let attached = false;
    let routeFailed = false;

    try {
      context = createRequestContext(application, event as SvelteKitRequestEvent);
      attachContextToLocals(event as SvelteKitRequestEvent, context, key);
      attached = true;
      return await resolve(event);
    } catch (error) {
      routeFailed = true;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (context) {
        try { await context.dispose(); } catch (error) { cleanupErrors.push(error); }
      }
      if (attached) {
        try { clearRequestContext(event as SvelteKitRequestEvent, key, context); } catch (error) { cleanupErrors.push(error); }
      }
      if (context) {
        try { await options.onRequestDisposed?.(context); } catch (error) { cleanupErrors.push(error); }
      }
      releaseRequest();

      // Never replace SvelteKit's redirect/HttpError/original route exception
      // with a secondary disposal or observer failure.
      if (cleanupErrors.length && !routeFailed) {
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        throw new AggregateError(cleanupErrors, 'SvelteX request cleanup reported multiple errors.');
      }
    }
  };
}

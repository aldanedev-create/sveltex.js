import type { Application } from '@sveltex/core';
import { deferred } from '../utilities/deferred.js';

interface RuntimeState {
  startPromise: Promise<Application> | undefined;
  shutdownPromise: Promise<void> | undefined;
  closing: boolean;
  activeRequests: number;
  drained: ReturnType<typeof deferred<void>>;
}

const runtimes = new WeakMap<Application, RuntimeState>();

function runtimeFor(application: Application): RuntimeState {
  let runtime = runtimes.get(application);
  if (!runtime) {
    runtime = { startPromise: undefined, shutdownPromise: undefined, closing: false, activeRequests: 0, drained: deferred<void>() };
    runtime.drained.resolve();
    runtimes.set(application, runtime);
  }
  return runtime;
}

export function ensureApplicationStarted(application: Application): Promise<Application> {
  const runtime = runtimeFor(application);
  if (runtime.closing || application.state === 'stopping' || application.state === 'stopped') {
    return Promise.reject(new Error('SvelteX application is shutting down or has already stopped.'));
  }
  if (application.state === 'running') return Promise.resolve(application);
  if (application.state === 'failed') return Promise.reject(new Error('SvelteX application startup failed; a failed application cannot be started again.'));
  runtime.startPromise ??= application.start().catch((error: unknown) => {
    runtime!.startPromise = undefined;
    throw error;
  });
  return runtime.startPromise;
}

export function acquireRequest(application: Application): () => void {
  const runtime = runtimeFor(application);
  if (runtime.closing) throw new Error('SvelteX application is shutting down and is no longer accepting requests.');
  if (runtime.activeRequests === 0) runtime.drained = deferred<void>();
  runtime.activeRequests += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtime.activeRequests -= 1;
    if (runtime.activeRequests === 0) runtime.drained.resolve();
  };
}

export function beginShutdown(application: Application): Promise<void> {
  const runtime = runtimeFor(application);
  if (runtime.shutdownPromise) return runtime.shutdownPromise;
  runtime.closing = true;
  runtime.shutdownPromise = (async () => {
    if (runtime.activeRequests > 0) await runtime.drained.promise;
    await application.stop();
  })().catch((error: unknown) => {
    runtime.shutdownPromise = undefined;
    throw error;
  });
  return runtime.shutdownPromise;
}

export function getActiveRequestCount(application: Application): number {
  return runtimeFor(application).activeRequests;
}

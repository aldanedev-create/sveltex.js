import type { Application, Container, InjectionToken } from '@sveltex/core';
import type { SvelteKitRequestEvent } from '../types/handle.types.js';
import type { SvelteXRequestContext } from '../types/context.types.js';
export class RequestContext implements SvelteXRequestContext {
  readonly application: Application; readonly container: Container; readonly request: Request; readonly url: URL;
  readonly params: Readonly<Record<string, string>>; readonly startedAt = Date.now();
  #disposePromise: Promise<void> | undefined;
  constructor(application: Application, container: Container, event: SvelteKitRequestEvent) {
    this.application = application; this.container = container; this.request = event.request; this.url = event.url;
    this.params = Object.freeze({ ...(event.params ?? {}) });
  }
  get isDisposed(): boolean { return this.container.isDisposed; }
  resolve<T>(token: InjectionToken<T>): Promise<T> {
    if (this.isDisposed) return Promise.reject(new Error('SvelteX request context has already been disposed.'));
    return this.container.resolve(token);
  }
  dispose(): Promise<void> { if (!this.#disposePromise) this.#disposePromise = this.container.dispose(); return this.#disposePromise; }
}

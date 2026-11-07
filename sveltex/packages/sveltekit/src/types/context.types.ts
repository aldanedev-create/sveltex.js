import type { Application, Container, InjectionToken } from '@sveltex/core';
export interface SvelteXRequestContext {
  readonly application: Application; readonly container: Container; readonly request: Request; readonly url: URL;
  readonly params: Readonly<Record<string, string>>; readonly startedAt: number;
  resolve<T>(token: InjectionToken<T>): Promise<T>; dispose(): Promise<void>; readonly isDisposed: boolean;
}
export interface SvelteXLocals { sveltex: SvelteXRequestContext; }

declare global {
  namespace App {
    interface Locals { sveltex: SvelteXRequestContext; }
  }
}

export interface SvelteXHandlerOptions {
  readonly localsKey?: string;
  readonly autoStart?: boolean;
  readonly onRequestDisposed?: (context: import('./context.types.js').SvelteXRequestContext) => void | Promise<void>;
}

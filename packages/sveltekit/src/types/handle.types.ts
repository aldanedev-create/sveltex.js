/** Structural equivalents of SvelteKit's Handle types; no runtime Kit import is needed. */
export interface SvelteKitRequestEvent<TLocals extends Record<string, unknown> = Record<string, unknown>> {
  readonly request: Request;
  readonly url: URL;
  readonly locals: TLocals;
  readonly params?: Record<string, string>;
  readonly route?: { id: string | null };
  readonly [key: string]: unknown;
}
// `any` at the SvelteKit boundary is intentional: SvelteKit owns its concrete
// RequestEvent/ResolveOptions types, which vary with route and generated App types.
// The implementation narrows the fields it actually consumes.
export type Resolve = (event: any, options?: any) => any;
export type Handle = (input: { event: any; resolve: Resolve }) => any;

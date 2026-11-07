/** Does not wrap SvelteKit's redirect/HttpError values, preserving their semantics. */
export class SvelteXKitError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'SvelteXKitError'; this.code = code; }
}

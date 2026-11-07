export interface SvelteXRequestMetadata { readonly startedAt: number; readonly url: URL; readonly params: Readonly<Record<string, string>>; }

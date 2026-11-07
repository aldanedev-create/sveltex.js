import type { SvelteXHandlerOptions } from '../types/config.types.js';
import { validateSvelteXKitConfig } from './validate-config.js';
export function defineSvelteXKitConfig<T extends SvelteXHandlerOptions>(config: T): Readonly<T> { validateSvelteXKitConfig(config); return Object.freeze({ ...config }); }

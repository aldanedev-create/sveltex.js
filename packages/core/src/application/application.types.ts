import type { SvelteXConfig } from '../config/config.types.js';
import type { ModuleDefinition } from '../modules/module.types.js';

export type ApplicationState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export interface CreateApplicationOptions {
  readonly config: SvelteXConfig | Record<string, unknown>;
  readonly modules?: readonly ModuleDefinition[];
}

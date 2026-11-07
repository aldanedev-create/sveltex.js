import type { Provider } from '../container/provider.types.js';
import type { Container } from '../container/container.js';
import type { SvelteXConfig } from '../config/config.types.js';
import type { MaybePromise } from '../types/common.js';

export interface ModuleContext {
  readonly config: SvelteXConfig;
  readonly container: Container;
  readonly moduleName: string;
}
export interface ModuleDescriptor {
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly providers?: readonly Provider[];
  readonly exports?: readonly import('../container/tokens.js').InjectionToken[];
  readonly onStart?: (context: ModuleContext) => MaybePromise<void>;
  readonly onStop?: (context: ModuleContext) => MaybePromise<void>;
}
export type ModuleDefinition = Readonly<ModuleDescriptor>;

import type { SvelteXHandlerOptions } from '../types/config.types.js';

export function validateSvelteXKitConfig(config: SvelteXHandlerOptions): void {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('SvelteX SvelteKit configuration must be an object.');
  }
  if (config.localsKey !== undefined && (typeof config.localsKey !== 'string' || !config.localsKey.trim())) {
    throw new TypeError('localsKey must be a non-empty string.');
  }
  if (config.autoStart !== undefined && typeof config.autoStart !== 'boolean') {
    throw new TypeError('autoStart must be a boolean.');
  }
  if (config.onRequestDisposed !== undefined && typeof config.onRequestDisposed !== 'function') {
    throw new TypeError('onRequestDisposed must be a function.');
  }
}

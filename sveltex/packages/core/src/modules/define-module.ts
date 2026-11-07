import { SvelteXError } from '../errors/framework-error.js';
import type { ModuleDefinition, ModuleDescriptor } from './module.types.js';

export function defineModule<T extends ModuleDescriptor>(descriptor: T): Readonly<T> & ModuleDefinition {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.name !== 'string' || !descriptor.name.trim()) {
    throw new SvelteXError('SX_MODULE_INVALID', 'A module must have a non-empty name.');
  }
  if (descriptor.dependencies && new Set(descriptor.dependencies).size !== descriptor.dependencies.length) {
    throw new SvelteXError('SX_MODULE_INVALID', `Module "${descriptor.name}" declares a dependency more than once.`);
  }
  if (descriptor.dependencies?.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new SvelteXError('SX_MODULE_INVALID', `Module "${descriptor.name}" contains an invalid dependency name.`);
  }
  if (descriptor.providers?.some((provider) => !provider || typeof provider !== 'object')) {
    throw new SvelteXError('SX_MODULE_INVALID', `Module "${descriptor.name}" contains an invalid provider.`);
  }
  if (descriptor.onStart !== undefined && typeof descriptor.onStart !== 'function') throw new SvelteXError('SX_MODULE_INVALID', `Module "${descriptor.name}" has an invalid onStart hook.`);
  if (descriptor.onStop !== undefined && typeof descriptor.onStop !== 'function') throw new SvelteXError('SX_MODULE_INVALID', `Module "${descriptor.name}" has an invalid onStop hook.`);
  if (descriptor.exports?.some((item) => item === undefined || item === null)) throw new SvelteXError('SX_MODULE_INVALID', `Module "${descriptor.name}" has an invalid export token.`);
  return Object.freeze({
    ...descriptor,
    name: descriptor.name.trim(),
    ...(descriptor.dependencies ? { dependencies: Object.freeze([...descriptor.dependencies]) } : {}),
    ...(descriptor.providers ? { providers: Object.freeze(descriptor.providers.map((provider) => Object.freeze({ ...provider, ...('inject' in provider && provider.inject ? { inject: Object.freeze([...provider.inject]) } : {}) }))) } : {}),
    ...(descriptor.exports ? { exports: Object.freeze([...descriptor.exports]) } : {}),
  });
}

import { SvelteXError } from '../errors/framework-error.js';
import type { AnyProvider, Provider } from './provider.types.js';
import type { InjectionToken } from './tokens.js';
import { tokenToString } from './tokens.js';

export class ProviderRegistry {
  readonly #providers = new Map<InjectionToken, AnyProvider>();
  #locked = false;
  register(provider: Provider): void {
    if (this.#locked) throw new SvelteXError('SX_APP_INVALID_STATE', 'Provider registry is locked.');
    if (!provider || typeof provider !== 'object' || !('provide' in provider) || provider.provide === undefined || provider.provide === null || (typeof provider.provide === 'string' && provider.provide.trim() === '')) {
      throw new SvelteXError('SX_PROVIDER_INVALID', 'Provider must declare a valid provide token.');
    }
    const strategies = ['useValue', 'useFactory', 'useClass'].filter((key) => key in provider);
    if (strategies.length !== 1) throw new SvelteXError('SX_PROVIDER_INVALID', `Provider ${tokenToString(provider.provide)} must declare exactly one construction strategy.`);
    if ('useFactory' in provider && typeof provider.useFactory !== 'function') throw new SvelteXError('SX_PROVIDER_INVALID', 'useFactory must be a function.');
    if ('useClass' in provider && typeof provider.useClass !== 'function') throw new SvelteXError('SX_PROVIDER_INVALID', 'useClass must be a constructor.');
    if ('inject' in provider && provider.inject !== undefined && (!Array.isArray(provider.inject) || provider.inject.some((item) => item === undefined || item === null || item === ''))) throw new SvelteXError('SX_PROVIDER_INVALID', 'inject must be an array of valid tokens.');
    if (provider.scope !== undefined && !['singleton', 'request', 'transient'].includes(provider.scope)) throw new SvelteXError('SX_PROVIDER_INVALID', 'Invalid provider scope.');
    if ('useValue' in provider && provider.scope !== undefined && provider.scope !== 'singleton') throw new SvelteXError('SX_PROVIDER_INVALID', 'useValue providers must use singleton scope.');
    if (this.#providers.has(provider.provide)) throw new SvelteXError('SX_PROVIDER_DUPLICATE', `Provider already registered for token "${tokenToString(provider.provide)}".`);
    const normalized = { ...provider, ...('inject' in provider && provider.inject ? { inject: Object.freeze([...provider.inject]) } : {}) };
    this.#providers.set(provider.provide, Object.freeze(normalized) as AnyProvider);
  }
  lock(): void { this.#locked = true; }
  get<T>(key: InjectionToken<T>): Provider<T> | undefined { return this.#providers.get(key) as Provider<T> | undefined; }
  has(key: InjectionToken): boolean { return this.#providers.has(key); }
  entries(): readonly AnyProvider[] { return Object.freeze([...this.#providers.values()]); }
}

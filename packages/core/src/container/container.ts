import { SvelteXError, asError } from '../errors/framework-error.js';
import { SvelteXAggregateError } from '../errors/aggregate-error.js';
import type { AnyProvider, Disposable, Provider, ProviderScope } from './provider.types.js';
import { isValueProvider } from './provider.types.js';
import { ProviderRegistry } from './provider-registry.js';
import type { InjectionToken } from './tokens.js';
import { tokenToString } from './tokens.js';

type ScopeKind = 'root' | 'request';
type Cleanup = () => Promise<void>;

/** Async DI container. A root container owns singleton instances; request containers share its registry and singleton cache. */
export class Container {
  readonly #registry: ProviderRegistry;
  readonly #root: Container;
  readonly #kind: ScopeKind;
  readonly #instances = new Map<InjectionToken, Promise<unknown>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cleanups: Cleanup[] = [];
  readonly #children = new Set<Container>();
  #disposed = false;
  #sealed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(registry = new ProviderRegistry(), root?: Container, kind: ScopeKind = 'root') {
    this.#registry = registry;
    this.#root = root ?? this;
    this.#kind = kind;
    if (kind === 'request') this.#root.#children.add(this);
  }

  register<T>(provider: Provider<T>): this {
    if (this.#kind !== 'root' || this.#disposed || this.#sealed) throw new SvelteXError('SX_APP_INVALID_STATE', 'Providers can only be registered on an unsealed root container.');
    this.#registry.register(provider);
    return this;
  }

  seal(): void {
    if (this.#kind !== 'root') throw new SvelteXError('SX_APP_INVALID_STATE', 'Only the root container can be sealed.');
    this.#sealed = true;
    this.#registry.lock();
  }

  createRequestScope(): Container {
    this.#assertActive();
    this.#root.seal();
    return new Container(this.#registry, this.#root, 'request');
  }

  async resolve<T>(key: InjectionToken<T>): Promise<T> {
    this.#assertActive();
    this.#root.seal();
    return this.#resolve(key, []);
  }

  async #resolve<T>(key: InjectionToken<T>, path: readonly InjectionToken[]): Promise<T> {
    if (path.includes(key)) {
      const chain = [...path, key].map(tokenToString).join(' -> ');
      throw new SvelteXError('SX_DI_CYCLE', `Circular dependency detected: ${chain}.`, { details: { path: [...path, key].map(tokenToString) } });
    }
    const provider = this.#registry.get(key);
    if (!provider) throw new SvelteXError('SX_PROVIDER_NOT_FOUND', `No provider registered for "${tokenToString(key)}".`, { details: { token: tokenToString(key) } });
    const scope: ProviderScope = provider.scope ?? 'singleton';
    if (scope === 'request' && this.#kind !== 'request') {
      throw new SvelteXError('SX_PROVIDER_SCOPE_VIOLATION', `Request-scoped provider "${tokenToString(key)}" requires an active request scope.`);
    }
    const owner = scope === 'singleton' ? this.#root : this;
    if (scope !== 'transient') {
      const cached = owner.#instances.get(key);
      if (cached) return await cached as T;
      const pending = owner.#track(owner.#construct(provider, [...path, key]));
      owner.#instances.set(key, pending);
      try { return await pending as T; }
      catch (error) { owner.#instances.delete(key); throw error; }
    }
    return await this.#track(this.#construct(provider, [...path, key])) as T;
  }

  async #construct(provider: AnyProvider, path: readonly InjectionToken[]): Promise<unknown> {
    let value: unknown;
    if (isValueProvider(provider)) {
      value = provider.useValue;
    } else if ('useFactory' in provider) {
      value = await provider.useFactory(Object.freeze({ resolve: <T>(key: InjectionToken<T>) => { this.#assertActive(); return this.#resolve(key, path); } }));
    } else {
      const dependencies = await Promise.all((provider.inject ?? []).map((key) => this.#resolve(key, path)));
      value = new provider.useClass(...dependencies as never[]);
    }
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      const disposable = value as Partial<Disposable>;
      const cleanup: Cleanup | undefined = typeof disposable.dispose === 'function'
        ? async () => { await disposable.dispose?.call(value); }
        : undefined;
      if (cleanup) {
        this.#cleanups.push(cleanup);
      }
    }
    return value;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#disposePromise = this.#disposeInternal();
    return this.#disposePromise;
  }

  async #disposeInternal(): Promise<void> {
    const failures: unknown[] = [];
    if (this.#kind === 'root') {
      for (const child of [...this.#children]) {
        try { await child.dispose(); } catch (error) { failures.push(asError(error)); }
      }
    } else {
      this.#root.#children.delete(this);
    }
    // Wait for in-flight factories so a late-created disposable cannot escape cleanup.
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    for (const cleanup of this.#cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(asError(error)); }
    }
    this.#cleanups.length = 0;
    this.#instances.clear();
    if (failures.length) throw new SvelteXAggregateError('One or more dependency providers failed to dispose.', failures);
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  get isDisposed(): boolean { return this.#disposed; }
  #assertActive(): void {
    if (this.#disposed) throw new SvelteXError('SX_APP_INVALID_STATE', 'Cannot use a disposed dependency-injection container.');
  }
}

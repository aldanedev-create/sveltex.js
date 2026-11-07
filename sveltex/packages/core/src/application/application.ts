import { validateConfig } from '../config/validate-config.js';
import type { SvelteXConfig } from '../config/config.types.js';
import { Container } from '../container/container.js';
import { ProviderRegistry } from '../container/provider-registry.js';
import type { InjectionToken } from '../container/tokens.js';
import { SvelteXError } from '../errors/framework-error.js';
import { LifecycleManager } from '../lifecycle/lifecycle-manager.js';
import { ModuleRegistry } from '../modules/module-registry.js';
import type { ModuleDefinition } from '../modules/module.types.js';
import type { ApplicationState, CreateApplicationOptions } from './application.types.js';

/** One isolated SvelteX application instance. No global application singleton is created. */
export class Application {
  readonly #config: SvelteXConfig;
  readonly #modules = new ModuleRegistry();
  #state: ApplicationState = 'created';
  #startPromise: Promise<this> | undefined;
  #stopPromise: Promise<void> | undefined;
  #lifecycle: LifecycleManager | undefined;

  constructor(options: CreateApplicationOptions) {
    this.#config = validateConfig(options.config);
    for (const module of options.modules ?? []) this.#modules.register(module);
  }

  get config(): SvelteXConfig { return this.#config; }
  get state(): ApplicationState { return this.#state; }
  get modules(): readonly ModuleDefinition[] { return this.#modules.all(); }
  get orderedModules(): readonly ModuleDefinition[] { return this.#modules.ordered(); }

  registerModule(module: ModuleDefinition): this {
    this.#assertState('created', 'Modules may only be registered before startup.');
    this.#modules.register(module);
    return this;
  }

  async start(): Promise<this> {
    if (this.#state === 'running') return this;
    if (this.#startPromise) return this.#startPromise;
    this.#assertState('created', 'Application can only start from the created state.');
    this.#state = 'starting';
    this.#modules.lock();
    this.#startPromise = this.#startInternal();
    return this.#startPromise;
  }

  async #startInternal(): Promise<this> {
    try {
      const ordered = this.#modules.ordered();
      const registry = new ProviderRegistry();
      for (const module of ordered) {
        const local = new Set<InjectionToken>();
        for (const provider of module.providers ?? []) {
          if (local.has(provider.provide)) throw new SvelteXError('SX_PROVIDER_DUPLICATE', `Module "${module.name}" declares provider "${String(provider.provide)}" more than once.`);
          local.add(provider.provide);
          registry.register(provider);
        }
        for (const exported of module.exports ?? []) {
          if (!local.has(exported)) throw new SvelteXError('SX_MODULE_INVALID', `Module "${module.name}" exports a token it does not provide.`);
        }
      }
      // Build a fresh root container with all validated providers before running any lifecycle hook.
      const runtimeContainer = new Container(registry);
      runtimeContainer.seal();
      this.#lifecycle = new LifecycleManager(this.#config, runtimeContainer);
      await this.#lifecycle.start(ordered);
      this.#runtimeContainer = runtimeContainer;
      this.#state = 'running';
      return this;
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
  }

  #runtimeContainer: Container | undefined;

  async resolve<T>(key: InjectionToken<T>): Promise<T> {
    this.#assertState('running', 'Application services can only be resolved while running.');
    return this.#runtimeContainer!.resolve(key);
  }

  createRequestScope(): Container {
    this.#assertState('running', 'Request scopes can only be created while the application is running.');
    return this.#runtimeContainer!.createRequestScope();
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#state === 'created') { this.#state = 'stopped'; return; }
    if (this.#state === 'starting' && this.#startPromise) {
      try { await this.#startPromise; } catch { return; }
      if (this.#stopPromise) return this.#stopPromise;
    }
    if (this.#state === 'failed') { this.#state = 'stopped'; return; }
    this.#assertState('running', 'Application cannot stop from its current state.');
    this.#state = 'stopping';
    this.#stopPromise = this.#stopInternal();
    return this.#stopPromise;
  }

  async #stopInternal(): Promise<void> {
    try { await this.#lifecycle?.stop(); }
    catch (error) { this.#state = 'stopped'; throw error; }
    this.#state = 'stopped';
  }

  #assertState(expected: ApplicationState, message: string): void {
    if (this.#state !== expected) throw new SvelteXError('SX_APP_INVALID_STATE', message, { details: { expected, actual: this.#state } });
  }
}

export function createApplication(options: CreateApplicationOptions): Application {
  return new Application(options);
}

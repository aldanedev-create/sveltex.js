import {
  createApplication,
  defineModule,
  token,
} from '@sveltex/core';
import type {
  Application,
  ApplicationState,
  Container,
  ClassProvider,
  FactoryProvider,
  InjectionToken,
  ModuleContext,
  ModuleDefinition,
  ModuleDescriptor,
  ProviderFactory,
  ProviderScope,
  SvelteXConfig,
  ValueProvider,
  Constructor,
} from '@sveltex/core';
import type { Awaitable } from '@sveltex/shared';
import { TestSetupError } from './errors.js';
import type { CallRecorder } from './fakes.js';

export * from './errors.js';
export * from './fakes.js';

/** A deterministic, injectable clock. Never advances on its own. */
export class FakeClock {
  #now: number;
  readonly #start: number;
  constructor(start = 0) {
    if (!Number.isFinite(start)) throw new TestSetupError('FakeClock start must be a finite number.');
    this.#now = start;
    this.#start = start;
  }
  now(): number { return this.#now; }
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new TestSetupError('advance() requires a non-negative finite number.');
    this.#now += ms;
    return this.#now;
  }
  set(value: number): void {
    if (!Number.isFinite(value)) throw new TestSetupError('set() requires a finite number.');
    this.#now = value;
  }
  reset(): void { this.#now = this.#start; }
}

export interface LifecycleEvent {
  readonly phase: string;
  readonly label: string;
  readonly at: number;
}

/** Records lifecycle events with a deterministic timestamp. Implements CallRecorder for fakes. */
export class LifecycleRecorder implements CallRecorder {
  readonly #clock: () => number;
  readonly #events: LifecycleEvent[] = [];
  constructor(clock: () => number = () => 0) {
    this.#clock = clock;
  }
  record(phase: string, label: string): void {
    this.#events.push(Object.freeze({ phase, label, at: this.#clock() }));
  }
  get events(): readonly LifecycleEvent[] { return Object.freeze([...this.#events]); }
  phases(): readonly string[] { return Object.freeze(this.#events.map((e) => e.phase)); }
  labels(): readonly string[] { return Object.freeze(this.#events.map((e) => e.label)); }
  clear(): void { this.#events.length = 0; }
}

/** Namespaced injection token for tests (avoids colliding with production tokens). */
export function testToken<T>(description: string): InjectionToken<T> {
  return token<T>(`test.${description}`);
}

export function createValueProvider<T>(provide: InjectionToken<T>, useValue: T): ValueProvider<T> {
  return Object.freeze({ provide, useValue }) as ValueProvider<T>;
}

export function createFactoryProvider<T>(
  provide: InjectionToken<T>,
  useFactory: ProviderFactory<T>,
  scope?: ProviderScope,
): FactoryProvider<T> {
  return Object.freeze({
    provide,
    useFactory,
    ...(scope !== undefined ? { scope } : {}),
  }) as FactoryProvider<T>;
}

export function createClassProvider<T>(
  provide: InjectionToken<T>,
  useClass: Constructor<T>,
  inject?: readonly InjectionToken[],
  scope?: ProviderScope,
): ClassProvider<T> {
  return Object.freeze({
    provide,
    useClass,
    ...(inject !== undefined ? { inject } : {}),
    ...(scope !== undefined ? { scope } : {}),
  }) as ClassProvider<T>;
}

/** Define a module with optional deterministic lifecycle tracing. Uses the real core defineModule. */
export function defineTestModule(descriptor: ModuleDescriptor, recorder?: LifecycleRecorder): ModuleDefinition {
  if (!descriptor || typeof descriptor.name !== 'string' || descriptor.name.trim().length === 0) {
    throw new TestSetupError('A test module requires a non-empty name.');
  }
  if (!recorder) return defineModule(descriptor);
  return defineModule({
    ...descriptor,
    onStart: async (ctx: ModuleContext): Promise<void> => {
      recorder.record('module:start', ctx.moduleName);
      await descriptor.onStart?.(ctx);
    },
    onStop: async (ctx: ModuleContext): Promise<void> => {
      recorder.record('module:stop', ctx.moduleName);
      await descriptor.onStop?.(ctx);
    },
  });
}

export interface TestApplicationOptions {
  /** Merged over a validated default config: { name: 'test-app', environment: 'test' }. */
  readonly config?: Record<string, unknown>;
  readonly modules?: readonly ModuleDefinition[];
  readonly clock?: FakeClock;
  readonly recorder?: LifecycleRecorder;
}

export interface RequestFixture {
  readonly scope: Container;
  resolve<T>(key: InjectionToken<T>): Promise<T>;
  dispose(): Promise<void>;
  readonly disposed: boolean;
}

/**
 * A thin builder around the REAL @sveltex/core Application/Container. It adds deterministic
 * clock/recorder, request fixtures and guaranteed cleanup, but delegates all DI and lifecycle
 * behavior to core — no fake application or parallel container implementation.
 */
export class TestApplication {
  readonly app: Application;
  readonly clock: FakeClock;
  readonly recorder: LifecycleRecorder;
  readonly #scopes = new Set<Container>();
  #stopped = false;

  constructor(options: TestApplicationOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.recorder = options.recorder ?? new LifecycleRecorder(() => this.clock.now());
    const config: Record<string, unknown> = {
      name: 'test-app',
      environment: 'test',
      ...(options.config ?? {}),
    };
    this.app = createApplication({
      config,
      ...(options.modules !== undefined ? { modules: options.modules } : {}),
    });
  }

  get state(): ApplicationState { return this.app.state; }
  get config(): SvelteXConfig { return this.app.config; }
  get modules(): readonly ModuleDefinition[] { return this.app.modules; }

  async start(): Promise<this> {
    this.recorder.record('app:start', this.app.config.name);
    await this.app.start();
    this.recorder.record('app:running', this.app.config.name);
    return this;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.recorder.record('app:stop', this.app.config.name);
    // Dispose any request scopes the caller forgot, before application shutdown.
    for (const scope of [...this.#scopes]) {
      await scope.dispose();
      this.#scopes.delete(scope);
    }
    await this.app.stop();
    this.recorder.record('app:stopped', this.app.config.name);
  }

  resolve<T>(key: InjectionToken<T>): Promise<T> {
    return this.app.resolve<T>(key);
  }

  requestScope(): Container {
    const scope = this.app.createRequestScope();
    this.#scopes.add(scope);
    return scope;
  }

  /** Create a managed request fixture with guaranteed disposal on app.stop(). */
  fixture(): RequestFixture {
    const scope = this.requestScope();
    let disposed = false;
    const scopes = this.#scopes;
    return Object.freeze({
      scope,
      resolve: <T>(key: InjectionToken<T>): Promise<T> => scope.resolve<T>(key),
      dispose: async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        await scope.dispose();
        scopes.delete(scope);
      },
      get disposed(): boolean { return disposed; },
    });
  }
}

export function createTestApplication(options: TestApplicationOptions = {}): TestApplication {
  return new TestApplication(options);
}

/** Run a test body with a started application; guarantees stop() even if the body throws. */
export async function withTestApplication<T>(
  fn: (app: TestApplication) => Awaitable<T>,
  options: TestApplicationOptions = {},
): Promise<T> {
  const app = createTestApplication(options);
  await app.start();
  try {
    return await fn(app);
  } finally {
    await app.stop();
  }
}

/** Create a request fixture directly from a running core Application. */
export function createRequestFixture(app: Application): RequestFixture {
  const scope = app.createRequestScope();
  let disposed = false;
  return Object.freeze({
    scope,
    resolve: <T>(key: InjectionToken<T>): Promise<T> => scope.resolve<T>(key),
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await scope.dispose();
    },
    get disposed(): boolean { return disposed; },
  });
}

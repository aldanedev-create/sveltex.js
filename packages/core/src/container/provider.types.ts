import type { InjectionToken, Constructor } from './tokens.js';
import type { MaybePromise } from '../types/common.js';

export type ProviderScope = 'singleton' | 'request' | 'transient';
export interface ResolutionContext {
  readonly resolve: <T>(token: InjectionToken<T>) => Promise<T>;
}
export interface Disposable { dispose(): MaybePromise<void>; }
export type ProviderFactory<T> = (context: ResolutionContext) => MaybePromise<T>;

interface ProviderBase<T> {
  readonly provide: InjectionToken<T>;
  readonly scope?: ProviderScope;
}
export interface ValueProvider<T> extends ProviderBase<T> { readonly useValue: T; }
export interface FactoryProvider<T> extends ProviderBase<T> {
  readonly useFactory: ProviderFactory<T>;
}
export interface ClassProvider<T> extends ProviderBase<T> {
  readonly useClass: Constructor<T>;
  readonly inject?: readonly InjectionToken[];
}
export type Provider<T = unknown> = ValueProvider<T> | FactoryProvider<T> | ClassProvider<T>;
export type AnyProvider = Provider<unknown>;

export function isValueProvider<T>(provider: Provider<T>): provider is ValueProvider<T> {
  return 'useValue' in provider;
}

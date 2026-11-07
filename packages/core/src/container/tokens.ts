export type Constructor<T = unknown> = new (...args: never[]) => T;
export type InjectionToken<T = unknown> = symbol | string | Constructor<T>;

export function token<T>(description: string): InjectionToken<T> {
  if (!description.trim()) throw new TypeError('Token description cannot be empty.');
  return Symbol.for(`@sveltex/${description}`) as InjectionToken<T>;
}

export function tokenToString(value: InjectionToken): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'symbol') return value.description ?? value.toString();
  return value.name || '<anonymous constructor>';
}

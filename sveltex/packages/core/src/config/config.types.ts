export interface SvelteXConfig {
  readonly name: string;
  readonly environment?: string;
  readonly debug?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ConfigValidator<T> = (value: unknown) => asserts value is T;
export interface ConfigDefinition<T> {
  readonly value: Readonly<T>;
  readonly validate?: ConfigValidator<T>;
}

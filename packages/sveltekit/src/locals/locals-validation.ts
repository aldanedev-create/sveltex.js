export function assertLocalsTarget(locals: unknown): asserts locals is object {
  if (locals === null || typeof locals !== 'object') {
    throw new TypeError('SvelteKit event.locals must be an object.');
  }
}

export function assertLocalsKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new TypeError('localsKey must be a non-empty string.');
  }
}

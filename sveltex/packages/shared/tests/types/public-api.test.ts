import { cloneData, deepFreeze, SvelteXError } from '../../dist/index.js';
const frozen: Readonly<{ value: number }> = deepFreeze({ value: 1 });
const cloned: { value: number } = cloneData({ value: 1 });
const error: Error = new SvelteXError('x', { code: 'X' });
void [frozen, cloned, error];

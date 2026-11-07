import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../../dist/index.js';

test('public adapter entrypoint imports without SvelteKit runtime internals', () => {
  assert.equal(typeof adapter.createSvelteXHandler, 'function');
  assert.equal(typeof adapter.getSvelteXContext, 'function');
});

test('adapter does not require process-global request storage', () => {
  assert.equal('AsyncLocalStorage' in adapter, false);
  assert.equal('requestStorage' in adapter, false);
});

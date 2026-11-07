import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSvelteXKitConfig, validateSvelteXKitConfig, createSvelteXHandler } from '../../dist/index.js';
import { makeApplication } from '../helpers.mjs';

test('configuration validation rejects invalid input at runtime', () => {
  assert.throws(() => validateSvelteXKitConfig(null), /must be an object/);
  assert.throws(() => defineSvelteXKitConfig({ localsKey: '  ' }), /localsKey/);
  assert.throws(() => defineSvelteXKitConfig({ autoStart: 'yes' }), /autoStart/);
  assert.throws(() => defineSvelteXKitConfig({ onRequestDisposed: true }), /onRequestDisposed/);
});

test('handler validates configuration before creating a handle', async () => {
  const app = makeApplication();
  assert.throws(() => createSvelteXHandler(app, { localsKey: '' }), /localsKey/);
  assert.equal(app.state, 'created');
});

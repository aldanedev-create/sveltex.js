import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, connectionStringFromEnv, redactConfig, DEFAULT_ENV_PREFIX } from '../../dist/index.js';

test('configFromEnv collects prefixed variables and normalises keys', () => {
  const env = {
    SVELTEX_DB_HOST: '127.0.0.1',
    SVELTEX_DB_MAX_CONNECTIONS: '10',
    SVELTEX_DB_DATABASE_URL: 'postgresql://localhost/app',
    UNRELATED: 'ignored',
  };
  const config = configFromEnv({ env });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.maxConnections, '10');
  assert.equal(config.databaseUrl, 'postgresql://localhost/app');
  assert.equal(config.UNRELATED, undefined);
});

test('configFromEnv honours an explicit key list and custom prefix', () => {
  const env = { APP_DB_HOST: 'h', APP_DB_PORT: '5432', APP_DB_OTHER: 'x' };
  const config = configFromEnv({ env, prefix: 'APP_DB_', keys: ['HOST', 'PORT'] });
  assert.deepEqual({ ...config }, { host: 'h', port: '5432' });
});

test('configFromEnv validates inputs', () => {
  assert.throws(() => configFromEnv({ prefix: '' }), TypeError);
  assert.throws(() => configFromEnv({ env: {}, keys: [''] }), TypeError);
  assert.equal(DEFAULT_ENV_PREFIX, 'SVELTEX_DB_');
});

test('connectionStringFromEnv respects key priority', () => {
  assert.equal(connectionStringFromEnv({ DATABASE_URL: 'db://fallback' }), 'db://fallback');
  assert.equal(
    connectionStringFromEnv({ SVELTEX_DATABASE_URL: 'db://primary', DATABASE_URL: 'db://fallback' }),
    'db://primary',
  );
  assert.equal(connectionStringFromEnv({ DATABASE_URL: '   ' }), undefined);
  assert.equal(connectionStringFromEnv({}), undefined);
});

test('redactConfig never leaks secret-shaped values', () => {
  const config = Object.freeze({
    host: 'localhost',
    password: 'hunter2',
    apiKey: 'sk-secret',
    databaseUrl: 'postgresql://u:p@host/db',
    token: 'abc',
    poolSize: 10,
  });
  const redacted = redactConfig(config);
  assert.equal(Object.isFrozen(redacted), true);
  assert.equal(redacted.host, 'localhost');
  assert.equal(redacted.poolSize, '10');
  for (const key of ['password', 'apiKey', 'databaseUrl', 'token']) {
    assert.equal(redacted[key], '[redacted]');
  }
  assert.equal(JSON.stringify(redacted).includes('hunter2'), false);
  assert.equal(JSON.stringify(redacted).includes('p@host'), false);
});

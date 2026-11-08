import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineDatabaseAdapter,
  defineAdapterContext,
  validateAdapterDefinition,
  createAdapterRegistry,
  createConnection,
  configFromEnv,
  redactConfig,
  runAdapterConformance,
  DatabaseAdapterError,
  UnsupportedCapabilityError,
} from '../../dist/index.js';

test('SEC: injection-shaped adapter names are rejected', () => {
  for (const name of ['users; DROP TABLE x', 'a b', '../escape', 'UPPER', '', 'a'.repeat(65)]) {
    assert.throws(() => defineDatabaseAdapter({
      name,
      async connect(config) { return defineAdapterContext(name, {}, config); },
      async disconnect() {},
    }), TypeError);
  }
});

test('SEC: forged capabilities without implementations are rejected', () => {
  const base = {
    name: 'forged',
    async connect(config) { return defineAdapterContext('forged', {}, config); },
    async disconnect() {},
  };
  assert.throws(() => defineDatabaseAdapter({ ...base, capabilities: { transactions: true } }), /transactions capability/);
  assert.throws(() => defineDatabaseAdapter({ ...base, capabilities: { healthCheck: true } }), /healthCheck capability/);
  assert.throws(() => defineDatabaseAdapter({ ...base, capabilities: { unknownKey: true } }), /Unknown adapter capability/);
  assert.throws(() => defineDatabaseAdapter({ ...base, capabilities: { transactions: 1 } }), /must be a boolean/);
});

test('SEC: registry refuses malformed adapters and duplicate names', () => {
  const reg = createAdapterRegistry();
  assert.throws(() => reg.register({ name: 'bad name', async connect() {}, async disconnect() {} }), TypeError);
  const good = defineDatabaseAdapter({
    name: 'good',
    async connect(config) { return defineAdapterContext('good', {}, config); },
    async disconnect() {},
  });
  reg.register(good);
  assert.throws(() => reg.register(good), DatabaseAdapterError);
});

test('SEC: connection error wrapping never exposes driver/connection strings', async () => {
  const adapter = defineDatabaseAdapter({
    name: 'leaky',
    async connect() { throw new Error('postgresql://admin:supersecret@db.internal/app'); },
    async disconnect() {},
  });
  const conn = createConnection(adapter, Object.freeze({}));
  await assert.rejects(() => conn.connect(), (err) =>
    err instanceof DatabaseAdapterError
    && !err.message.includes('supersecret')
    && !err.message.includes('db.internal'));
  await conn.close();
});

test('SEC: health reports redact adapter failures', async () => {
  const adapter = defineDatabaseAdapter({
    name: 'leaky-health',
    async connect(config) { return defineAdapterContext('leaky-health', {}, config); },
    async disconnect() {},
    async healthCheck() { throw new Error('password=hunter2 token=abc'); },
  });
  const conn = createConnection(adapter, Object.freeze({}));
  await conn.connect();
  const report = await conn.healthCheck();
  assert.equal(report.healthy, false);
  assert.equal(report.error, 'The health check raised an adapter error.');
  assert.equal(JSON.stringify(report).includes('hunter2'), false);
  await conn.close();
});

test('SEC: undeclared transaction capability cannot be invoked', async () => {
  const adapter = defineDatabaseAdapter({
    name: 'no-tx',
    async connect(config) { return defineAdapterContext('no-tx', {}, config); },
    async disconnect() {},
  });
  const conn = createConnection(adapter, Object.freeze({}));
  await conn.connect();
  await assert.rejects(() => conn.transaction(async () => 1), UnsupportedCapabilityError);
  await conn.close();
});

test('SEC: env config is passive (no evaluation) and redaction hides secrets', () => {
  const env = { SVELTEX_DB_PASSWORD: 'p@ss', SVELTEX_DB_HOST: 'localhost', SVELTEX_DB_TOKEN: 'abc' };
  const config = configFromEnv({ env });
  assert.equal(config.password, 'p@ss'); // collected verbatim, never evaluated/executed
  assert.equal(Object.isFrozen(config), true);
  const redacted = redactConfig(config);
  assert.equal(redacted.password, '[redacted]');
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.host, 'localhost');
});

test('SEC: conformance reports redact secrets from setup failures', async () => {
  const report = await runAdapterConformance({
    name: 'secret',
    async create() { throw new Error('mysql://root:topsecret@internal/db'); },
  });
  assert.equal(report.passed, false);
  assert.equal(JSON.stringify(report).includes('topsecret'), false);
  assert.equal(JSON.stringify(report).includes('[redacted]'), true);
});

test('SEC: validateAdapterDefinition accepts only object definitions', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.throws(() => validateAdapterDefinition(bad), TypeError);
  }
});

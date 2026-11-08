import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runAdapterConformance,
  defineDatabaseAdapter,
  defineAdapterContext,
} from '../../dist/index.js';
import { createMemoryAdapter } from '../helpers/adapter.mjs';

test('memory adapter passes every shared conformance check', async () => {
  const report = await runAdapterConformance({
    name: 'memory',
    async create() {
      return { adapter: createMemoryAdapter().adapter, config: Object.freeze({}) };
    },
  });
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(report.passed, true, JSON.stringify(failed));
  assert.equal(report.subject, 'memory');
  const names = report.results.map((r) => r.name);
  assert.ok(names.includes('connect-produces-context'));
  assert.ok(names.includes('health-check-reports-healthy'));
  assert.ok(names.includes('transaction-executes-and-returns-result'));
  assert.ok(names.includes('transaction-preserves-application-errors'));
  assert.ok(names.includes('close-is-idempotent'));
});

test('adapters without optional capabilities pass the not-claimed checks', async () => {
  const report = await runAdapterConformance({
    name: 'minimal',
    async create() {
      return {
        adapter: createMemoryAdapter({ withHealthCheck: false, withTransaction: false }).adapter,
        config: Object.freeze({}),
      };
    },
  });
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(report.passed, true, JSON.stringify(failed));
  const names = report.results.map((r) => r.name);
  assert.ok(names.includes('health-check-not-claimed'));
  assert.ok(names.includes('transaction-not-claimed'));
});

test('broken adapter (declared capability without implementation) is detected', async () => {
  const broken = {
    name: 'broken',
    capabilities: Object.freeze({ transactions: true, savepoints: false, healthCheck: false, migrations: false }),
    async connect(config) { return defineAdapterContext('broken', {}, config); },
    async disconnect() {},
  };
  const report = await runAdapterConformance({
    name: 'broken',
    async create() { return { adapter: broken, config: Object.freeze({}) }; },
  });
  assert.equal(report.passed, false);
  assert.ok(report.results.some((r) => !r.passed && /capabilit/i.test(r.name)));
});

test('setup failures are captured and secrets are redacted from the report', async () => {
  const report = await runAdapterConformance({
    name: 'exploding',
    async create() { throw new Error('postgresql://user:supersecret@host/db'); },
  });
  assert.equal(report.passed, false);
  assert.ok(report.results.some((r) => r.name === 'suite-setup' && !r.passed));
  assert.equal(JSON.stringify(report).includes('supersecret'), false);
});

test('validateAdapterDefinition rejects a hand-built adapter with a forged capability', () => {
  assert.throws(() => defineDatabaseAdapter({
    name: 'forged',
    capabilities: { transactions: true },
    async connect(config) { return defineAdapterContext('forged', {}, config); },
    async disconnect() {},
  }), TypeError);
});

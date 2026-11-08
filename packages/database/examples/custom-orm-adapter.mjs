/**
 * Working "Bring Your Own ORM" example.
 *
 * This file shows how to integrate a data layer that SvelteX does not ship an
 * official adapter for. There is no ORM involved here — a raw `pg.Pool` stands
 * in for "your ORM", to make the contract obligations explicit:
 *
 *   - connect(config)    -> initialise the native client, return a context
 *   - disconnect(ctx)    -> release the native resources
 *   - healthCheck(ctx)   -> verify availability (optional capability)
 *   - transaction(ctx,cb)-> run cb inside a native transaction (optional)
 *
 * The native client is always reachable via connection.context().client, so
 * callers keep the full third-party API. Replace `pg` with PrismaClient,
 * MikroORM, TypeORM's DataSource, or anything else — the shape is identical.
 *
 * Run against a real PostgreSQL server:
 *   SVELTEX_TEST_POSTGRES_URL=postgresql://... node examples/custom-orm-adapter.mjs
 */
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { defineDatabaseAdapter, defineAdapterContext, createConnection } from '../dist/index.js';

export function createCustomPgAdapter() {
  const name = 'custom-pg';
  return defineDatabaseAdapter({
    name,
    capabilities: {
      transactions: true,
      savepoints: false,
      healthCheck: true,
      migrations: false,
    },
    async connect(config) {
      const pool = new pg.Pool({
        connectionString: config.connectionString,
        max: config.maxConnections ?? 4,
      });
      return defineAdapterContext(name, pool, config);
    },
    async disconnect(ctx) {
      await ctx.client.end();
    },
    async healthCheck(ctx) {
      const result = await ctx.client.query('SELECT 1 AS ok');
      return result.rowCount === 1;
    },
    async transaction(ctx, callback) {
      const client = await ctx.client.connect();
      try {
        await client.query('BEGIN');
        const value = await callback(defineAdapterContext(name, client, ctx.config));
        await client.query('COMMIT');
        return value;
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally {
        client.release();
      }
    },
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const url = process.env.SVELTEX_TEST_POSTGRES_URL
    ?? 'postgresql://sveltex:sveltex_test_pw@127.0.0.1:5432/sveltex_test';
  const connection = createConnection(createCustomPgAdapter(), Object.freeze({ connectionString: url }));
  await connection.connect();
  const health = await connection.healthCheck();
  const value = await connection.transaction(async (tx) => {
    const r = await tx.client.query('SELECT 1 + 1 AS sum');
    return r.rows[0].sum;
  });
  console.log(JSON.stringify({ healthy: health.healthy, transactionResult: value, native: typeof connection.native().query }));
  await connection.close();
}

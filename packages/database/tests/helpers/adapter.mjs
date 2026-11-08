import { defineDatabaseAdapter, defineAdapterContext } from '../../dist/index.js';

/** A real, in-memory adapter used by unit and conformance tests. */
export function createMemoryAdapter(options = {}) {
  const name = options.name ?? 'memory';
  const state = {
    connects: 0,
    disconnects: 0,
    healthChecks: 0,
    transactions: 0,
    closed: false,
    store: new Map(),
  };
  const adapter = defineDatabaseAdapter({
    name,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    async connect(config) {
      state.connects += 1;
      if (options.connectError !== undefined) throw options.connectError;
      return defineAdapterContext(name, state.store, config);
    },
    async disconnect() {
      state.disconnects += 1;
      state.closed = true;
    },
    ...(options.withHealthCheck === false ? {} : {
      async healthCheck() {
        state.healthChecks += 1;
        if (options.healthCheckError !== undefined) throw options.healthCheckError;
        return options.unhealthy === true ? false : true;
      },
    }),
    ...(options.withTransaction === false ? {} : {
      async transaction(ctx, cb) {
        state.transactions += 1;
        if (options.transactionError !== undefined) throw options.transactionError;
        return cb(defineAdapterContext(name, new Map(ctx.client), ctx.config));
      },
    }),
  });
  return { adapter, state, name };
}

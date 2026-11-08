import { RedisSessionStore, type RedisSessionStoreOptions } from '../../dist/redis.js';
import { SessionManager, type SessionStore, type SessionRecord } from '../../dist/index.js';

type Data = { userId: string };

const options: RedisSessionStoreOptions = {
  url: 'redis://localhost:6379',
  keyPrefix: 'app:sess:',
  now: () => Date.now(),
};

const store = new RedisSessionStore<Data>(options);

// The adapter must satisfy the storage-agnostic SessionStore contract.
const asContract: SessionStore<Data> = store;
const manager = new SessionManager<Data>(asContract, { ttlMs: 60_000 });

const read: Promise<SessionRecord<Data> | undefined> = asContract.get('session_identifier_0001');
const inserted: Promise<boolean> = asContract.createIfAbsent({
  id: 'session_identifier_0001',
  data: { userId: 'u1' },
  createdAt: 0,
  expiresAt: 60_000,
  revision: 1,
});
const created: Promise<SessionRecord<Data>> = manager.create({ userId: 'u1' });
const closed: Promise<void> = store.connect().then(() => store.disconnect());
void [read, inserted, created, closed];

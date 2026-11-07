import { MemoryCache, type CacheStore } from '../../dist/index.js';
const store: CacheStore = new MemoryCache({ maxEntries: 10 });
const read: Promise<string | undefined> = store.get<string>('key');
void read;

import {
  CacheConfigurationError,
  CacheSerializationError,
  CacheStoreError,
  FallbackCache,
  InMemoryTagVersionSource,
  MemoryCache,
  StampedeGuard,
  TaggedCache,
  computeTtlWithJitter,
  createNamespace,
  deserializeCacheValue,
  invalidateKeys,
  invalidateMatching,
  invalidatePrefix,
  serializeCacheValue,
} from '../../dist/index.js';
import type {
  CacheError,
  CacheLoadOptions,
  CacheSetOptions,
  CacheStore,
  CacheTagVersionSource,
  FallbackCacheOptions,
  FallbackState,
  KeyedCacheStore,
  StampedeGuardOptions,
  TaggedCacheSetOptions,
} from '../../dist/index.js';

const memory: KeyedCacheStore = new MemoryCache({ maxEntries: 10, now: () => 0 });

const versions: CacheTagVersionSource = new InMemoryTagVersionSource();
const tagged: CacheStore = new TaggedCache(memory, { versions });
const taggedOptions: TaggedCacheSetOptions = { ttlMs: 100, tags: ['users'] };

const namespace: KeyedCacheStore = createNamespace(memory, 'app');
const fallbackOptions: FallbackCacheOptions = {
  primary: memory,
  fallback: new MemoryCache(),
  onError: (error: CacheStoreError): void => { void error; },
};
const fallback: CacheStore = new FallbackCache(fallbackOptions);
const fallbackState: FallbackState = 'degraded';

const guardOptions: StampedeGuardOptions = { random: () => 0.5, onCoalesced: () => {} };
const guard = new StampedeGuard(memory, guardOptions);
const loadOptions: CacheLoadOptions = { ttlMs: 100, jitterRatio: 0.2 };
const loaded: Promise<number> = guard.getOrLoad<number>('k', () => 1, loadOptions);

const setOptions: CacheSetOptions = { ttlMs: 5 };
const encoded: string = serializeCacheValue({ a: 1 });
const decoded: unknown = deserializeCacheValue(encoded);
const jittered: number = computeTtlWithJitter(100, 0.25, () => 0.5);
const errors: CacheError[] = [
  new CacheConfigurationError('bad'),
  new CacheSerializationError('bad'),
  new CacheStoreError('get'),
];
const removed1: Promise<number> = invalidateKeys(memory, ['a']);
const removed2: Promise<number> = invalidatePrefix(memory, 'a:');
const removed3: Promise<number> = invalidateMatching(memory, (key: string) => key.length > 0);

void [
  tagged, taggedOptions, namespace, fallback, fallbackState, loaded, setOptions,
  decoded, jittered, errors, removed1, removed2, removed3, guard,
];

// Public subpath surfaces are real compiled outputs, not runtime-only guesses.
import type { KeyedCacheStore as SubKeyedCacheStore } from '../../dist/namespace.js';
import type { CacheTagVersionSource as SubVersionSource } from '../../dist/tags.js';
import type { FallbackState as SubFallbackState } from '../../dist/fallback.js';
import type { CacheLoadOptions as SubLoadOptions } from '../../dist/stampede.js';
import type { RedisTagVersionSourceOptions, RedisCacheOptions } from '../../dist/redis.js';

const subKeyed: SubKeyedCacheStore = memory;
const subVersions: SubVersionSource = versions;
const subState: SubFallbackState = fallbackState;
const subLoad: SubLoadOptions = loadOptions;
const redisOptions: RedisCacheOptions = { keyPrefix: 'app:' };
const versionOptions: RedisTagVersionSourceOptions = { keyPrefix: 'app:' };
void [subKeyed, subVersions, subState, subLoad, redisOptions, versionOptions];

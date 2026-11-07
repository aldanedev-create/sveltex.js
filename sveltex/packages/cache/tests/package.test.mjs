import test from 'node:test'; import assert from 'node:assert/strict';
import { MemoryCache } from '../dist/index.js';
test('cache stores, retrieves, and deletes values',async()=>{ const cache=new MemoryCache(); await cache.set('a',{n:1}); assert.deepEqual(await cache.get('a'),{n:1}); assert.equal(await cache.delete('a'),true); });
test('cache expires entries using injected clock',async()=>{ let now=10; const cache=new MemoryCache({now:()=>now}); await cache.set('a',1,{ttlMs:5}); now=15; assert.equal(await cache.get('a'),undefined); });
test('has distinguishes a cached undefined value from a missing key',async()=>{ const cache=new MemoryCache(); await cache.set('empty',undefined); assert.equal(await cache.has('empty'),true); });
test('cache evicts least recently used entry',async()=>{ const cache=new MemoryCache({maxEntries:2}); await cache.set('a',1); await cache.set('b',2); await cache.get('a'); await cache.set('c',3); assert.equal(await cache.get('b'),undefined); });
test('cache validates keys, TTLs, capacity and clock output',async()=>{ const cache=new MemoryCache(); await assert.rejects(()=>cache.set('',1),TypeError); await assert.rejects(()=>cache.set('a',1,{ttlMs:-1}),RangeError); assert.throws(()=>new MemoryCache({maxEntries:0}),RangeError); assert.throws(()=>new MemoryCache({now:()=>NaN}),RangeError); });
test('cache removes expired entries while calculating size',async()=>{ let now=0; const cache=new MemoryCache({now:()=>now}); await cache.set('a',1,{ttlMs:2}); await cache.set('b',2); now=2; assert.equal(await cache.size(),1); });
test('cache treats zero TTL as immediate deletion',async()=>{ const cache=new MemoryCache(); await cache.set('a',1); await cache.set('a',2,{ttlMs:0}); assert.equal(await cache.has('a'),false); });

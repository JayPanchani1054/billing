import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { QueryCache, queryKey, routeMatches, routeOfKey, stableStringify } from './queryCache.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('query keys', () => {
  test('stableStringify sorts object keys and drops undefined', () => {
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3, undefined] }, z: undefined }), '{"a":{"c":[3,null],"d":2},"b":1}');
    assert.equal(stableStringify(undefined), 'null');
  });

  test('queryKey is order-insensitive and keeps the route', () => {
    const a = queryKey('accounts.ledger.list', { search: 'hd', limit: 10 });
    const b = queryKey('accounts.ledger.list', { limit: 10, search: 'hd' });
    assert.equal(a, b);
    assert.notEqual(a, queryKey('accounts.ledger.list', { limit: 11, search: 'hd' }));
    assert.equal(routeOfKey(a), 'accounts.ledger.list');
    assert.equal(queryKey('app.state', undefined), queryKey('app.state', {}));
  });

  test('routeMatches prefixes on segment boundaries', () => {
    assert.ok(routeMatches('accounts.ledger.list', 'accounts'));
    assert.ok(routeMatches('accounts.ledger.list', 'accounts.ledger'));
    assert.ok(routeMatches('accounts.ledger.list', 'accounts.ledger.list'));
    assert.ok(routeMatches('accounts.ledger.list', ''));
    assert.ok(!routeMatches('accountsx.ledger', 'accounts'));
    assert.ok(!routeMatches('accounts.ledgers', 'accounts.ledger'));
  });
});

describe('QueryCache', () => {
  test('de-duplicates concurrent fetches', async () => {
    const cache = new QueryCache();
    let calls = 0;
    const d = deferred<number>();
    const fetcher = () => {
      calls++;
      return d.promise;
    };
    const key = queryKey('r.x', {});
    const p1 = cache.fetch(key, fetcher);
    const p2 = cache.fetch(key, fetcher);
    assert.equal(p1, p2);
    assert.equal(calls, 1);
    assert.equal(cache.peek(key)?.status, 'loading');
    assert.equal(cache.pending, 1);
    d.resolve(5);
    assert.equal(await p1, 5);
    const snap = cache.peek<number>(key);
    assert.equal(snap?.status, 'success');
    assert.equal(snap?.data, 5);
    assert.equal(snap?.stale, false);
    assert.equal(cache.pending, 0);
  });

  test('stale-while-revalidate keeps data during a refetch', async () => {
    let t = 1000;
    const cache = new QueryCache({ now: () => t });
    const key = queryKey('r.list', {});
    await cache.fetch(key, async () => ['a']);
    assert.equal(cache.needsFetch(key, 30_000), false);
    t += 31_000;
    assert.equal(cache.needsFetch(key, 30_000), true, 'older than staleTime');
    const d = deferred<string[]>();
    const p = cache.fetch(key, () => d.promise);
    const during = cache.peek<string[]>(key);
    assert.deepEqual(during?.data, ['a']);
    assert.equal(during?.status, 'success');
    assert.equal(during?.fetching, true);
    d.resolve(['a', 'b']);
    await p;
    assert.deepEqual(cache.peek<string[]>(key)?.data, ['a', 'b']);
  });

  test('invalidate(prefix) marks matching entries stale and notifies subscribers', async () => {
    const cache = new QueryCache();
    const k1 = queryKey('accounts.ledger.list', { q: 1 });
    const k2 = queryKey('accounts.group.list', {});
    const k3 = queryKey('inventory.item.list', {});
    await Promise.all([cache.fetch(k1, async () => 1), cache.fetch(k2, async () => 2), cache.fetch(k3, async () => 3)]);
    let notified = 0;
    const off = cache.subscribe(k1, () => notified++);
    const keys = cache.invalidate('accounts.ledger');
    assert.deepEqual(keys, [k1]);
    assert.equal(notified, 1);
    assert.equal(cache.peek(k1)?.stale, true);
    assert.equal(cache.peek(k1)?.data, 1, 'data kept while stale');
    assert.equal(cache.peek(k2)?.stale, false);
    assert.equal(cache.needsFetch(k1, 60_000), true);
    assert.deepEqual(cache.invalidate('accounts').sort(), [k1, k2].sort());
    assert.equal(cache.invalidate().length, 3);
    off();
    assert.equal(cache.subscriberCount(k1), 0);
  });

  test('a response that started before an invalidation stays stale', async () => {
    const cache = new QueryCache();
    const key = queryKey('vouchers.list', {});
    const d = deferred<string>();
    const p = cache.fetch(key, () => d.promise);
    cache.invalidate('vouchers');
    d.resolve('old');
    await p;
    const snap = cache.peek(key);
    assert.equal(snap?.data, 'old');
    assert.equal(snap?.stale, true);
    assert.equal(cache.needsFetch(key, 60_000), true);
  });

  test('errors are stored, not refetched automatically, and cleared by invalidate', async () => {
    const cache = new QueryCache();
    const key = queryKey('r.fail', {});
    await assert.rejects(cache.fetch(key, async () => Promise.reject(new Error('boom'))));
    const snap = cache.peek(key);
    assert.equal(snap?.status, 'error');
    assert.equal((snap?.error as Error).message, 'boom');
    assert.equal(cache.needsFetch(key, 0), false);
    cache.invalidate('r');
    assert.equal(cache.peek(key)?.status, 'idle');
    assert.equal(cache.needsFetch(key, 0), true);
  });

  test('force fetch: the newest response wins', async () => {
    const cache = new QueryCache();
    const key = queryKey('r.x', {});
    const first = deferred<string>();
    const second = deferred<string>();
    const p1 = cache.fetch(key, () => first.promise);
    const p2 = cache.fetch(key, () => second.promise, { force: true });
    second.resolve('new');
    await p2;
    first.resolve('old');
    await p1;
    assert.equal(cache.peek(key)?.data, 'new');
  });

  test('clear drops entries and ignores responses in flight', async () => {
    const cache = new QueryCache();
    const key = queryKey('r.x', {});
    const d = deferred<string>();
    const p = cache.fetch(key, () => d.promise);
    cache.clear();
    assert.equal(cache.size, 0);
    d.resolve('late');
    await p;
    assert.equal(cache.peek(key), undefined);
  });

  test('setData and gc', async () => {
    let t = 0;
    const cache = new QueryCache({ now: () => t });
    const key = queryKey('r.one', { id: 1 });
    cache.setData(key, { id: 1 });
    assert.deepEqual(cache.peek(key)?.data, { id: 1 });
    const live = queryKey('r.two', {});
    const off = cache.subscribe(live, () => undefined);
    t = 10_000;
    assert.equal(cache.gc(5_000), 1);
    assert.equal(cache.peek(key), undefined);
    assert.ok(cache.peek(live));
    off();
  });

  test('a fetcher that throws synchronously becomes an error snapshot', async () => {
    const cache = new QueryCache();
    const key = queryKey('r.sync', {});
    await assert.rejects(
      cache.fetch(key, () => {
        throw new Error('sync');
      }),
    );
    assert.equal(cache.peek(key)?.status, 'error');
  });
});

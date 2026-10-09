import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { QueryCache, queryKey } from './queryCache.ts';
import { forceOnRefetch, shouldAutoFetch } from './queryVisibility.ts';

describe('shouldAutoFetch', () => {
  test('only enabled queries of visible screens that need data', () => {
    assert.equal(shouldAutoFetch({ enabled: true, visible: true, needsFetch: true }), true);
    assert.equal(shouldAutoFetch({ enabled: true, visible: false, needsFetch: true }), false);
    assert.equal(shouldAutoFetch({ enabled: false, visible: true, needsFetch: true }), false);
    assert.equal(shouldAutoFetch({ enabled: true, visible: true, needsFetch: false }), false);
  });

  test('a voucher save does not recompute the hidden Gateway dashboard until it is shown again', async () => {
    let now = 0;
    const cache = new QueryCache({ now: () => now });
    const key = queryKey('dashboard.summary', {});
    let calls = 0;
    const fetcher = async () => ++calls;
    await cache.fetch(key, fetcher);
    assert.equal(calls, 1);

    // Voucher entry is pushed over the Gateway (dashboard hidden); the save invalidates 'dashboard'.
    now += 1_000;
    cache.invalidate('dashboard');
    const hiddenTick = () => shouldAutoFetch({ enabled: true, visible: false, needsFetch: cache.needsFetch(key, 30_000) });
    if (hiddenTick()) await cache.fetch(key, fetcher);
    assert.equal(calls, 1, 'no background recompute while hidden');
    assert.equal(cache.peek(key)?.stale, true, 'kept stale');
    assert.equal(cache.peek(key)?.data, 1, 'old data still shown when revealed until the refetch lands');

    // Esc back to the Gateway: visible again → fetch once.
    if (shouldAutoFetch({ enabled: true, visible: true, needsFetch: cache.needsFetch(key, 30_000) })) await cache.fetch(key, fetcher);
    assert.equal(calls, 2);
    assert.equal(cache.peek(key)?.stale, false);
  });
});

describe('refetch on reveal', () => {
  test('shares the request the revealed screen already started (no second dashboard compute)', async () => {
    const cache = new QueryCache();
    const key = queryKey('dashboard.summary', {});
    let calls = 0;
    let release: () => void = () => undefined;
    const fetcher = () =>
      new Promise<number>((resolve) => {
        calls++;
        release = () => resolve(calls);
      });
    const auto = cache.fetch(key, fetcher); // useApiQuery's own fetch when the screen is shown
    const manual = cache.fetch(key, fetcher, { force: forceOnRefetch(cache.hasCurrentRequest(key)) }); // the screen's refetch()
    release();
    assert.equal(await auto, 1);
    assert.equal(await manual, 1);
    assert.equal(calls, 1);
    assert.equal(forceOnRefetch(false), true, 'idle: a real new request');
  });

  test('never shares a request that started before the latest invalidation (it may carry pre-save data)', async () => {
    const cache = new QueryCache();
    const key = queryKey('banking.brs', { ledgerId: 7 });
    const releases: Array<(v: string) => void> = [];
    const fetcher = () => new Promise<string>((resolve) => releases.push(resolve));
    const before = cache.fetch(key, fetcher); // a background fetch is running…
    cache.invalidate('banking'); // …when a save lands
    assert.equal(cache.hasCurrentRequest(key), false);
    const manual = cache.fetch(key, fetcher, { force: forceOnRefetch(cache.hasCurrentRequest(key)) }); // refetch() after the save
    assert.equal(releases.length, 2, 'a new request was started');
    assert.equal(cache.hasCurrentRequest(key), true, 'the new request is current');
    releases[0]('pre-save');
    releases[1]('post-save');
    assert.equal(await before, 'pre-save');
    assert.equal(await manual, 'post-save');
    assert.equal(cache.peek(key)?.data, 'post-save');
    assert.equal(cache.peek(key)?.stale, false);
    assert.equal(cache.hasCurrentRequest(key), false, 'nothing in flight');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  breadcrumbTrail,
  createRootStack,
  makeEntry,
  mountedKeys,
  navReducer,
  removedEntries,
  ResultBroker,
  ROOT_SCREEN,
  topFullIndex,
  transition,
} from './navStack.ts';
import type { NavEntry } from './navStack.ts';

const ids = (s: readonly NavEntry[]) => s.map((e) => e.screenId);

function stackOf(...screens: string[]): readonly NavEntry[] {
  let s = createRootStack();
  for (const id of screens) s = navReducer(s, { type: 'push', entry: makeEntry(id) });
  return s;
}

describe('navReducer', () => {
  test('starts with the gateway only', () => {
    assert.deepEqual(ids(createRootStack()), [ROOT_SCREEN]);
  });

  test('push, pop, popTo, reset', () => {
    const s = stackOf('a', 'b', 'c');
    assert.deepEqual(ids(s), [ROOT_SCREEN, 'a', 'b', 'c']);
    assert.deepEqual(ids(navReducer(s, { type: 'pop' })), [ROOT_SCREEN, 'a', 'b']);
    assert.deepEqual(ids(navReducer(s, { type: 'pop', count: 2 })), [ROOT_SCREEN, 'a']);
    assert.deepEqual(ids(navReducer(s, { type: 'pop', count: 99 })), [ROOT_SCREEN]);
    assert.deepEqual(ids(navReducer(s, { type: 'popTo', index: 1 })), [ROOT_SCREEN, 'a']);
    assert.deepEqual(ids(navReducer(s, { type: 'popTo', index: -5 })), [ROOT_SCREEN]);
    assert.deepEqual(ids(navReducer(s, { type: 'reset' })), [ROOT_SCREEN]);
  });

  test('never pops or replaces the gateway', () => {
    const root = createRootStack();
    assert.equal(navReducer(root, { type: 'pop' }), root, 'same array when nothing changes');
    assert.equal(navReducer(root, { type: 'reset' }), root);
    assert.deepEqual(ids(navReducer(root, { type: 'replace', entry: makeEntry('x') })), [ROOT_SCREEN, 'x']);
    assert.equal(navReducer(root, { type: 'popEntry', key: root[0].key }), root);
  });

  test('replace swaps the top entry', () => {
    const s = stackOf('a', 'b');
    const r = navReducer(s, { type: 'replace', entry: makeEntry('c') });
    assert.deepEqual(ids(r), [ROOT_SCREEN, 'a', 'c']);
    assert.equal(r[1], s[1], 'lower entries keep their identity (stay mounted)');
  });

  test('popEntry removes an entry and everything above it', () => {
    const s = stackOf('a', 'b', 'c');
    assert.deepEqual(ids(navReducer(s, { type: 'popEntry', key: s[2].key })), [ROOT_SCREEN, 'a']);
    assert.equal(navReducer(s, { type: 'popEntry', key: 'nope' }), s);
  });

  test('popTo the current top is a no-op', () => {
    const s = stackOf('a');
    assert.equal(navReducer(s, { type: 'popTo', index: 1 }), s);
  });
});

describe('stack helpers', () => {
  test('removedEntries lists removed entries top-most first', () => {
    const s = stackOf('a', 'b', 'c');
    const next = navReducer(s, { type: 'popTo', index: 1 });
    assert.deepEqual(ids(removedEntries(s, next)), ['c', 'b']);
  });

  test('mountedKeys keeps only the top N entries', () => {
    const s = stackOf('a', 'b', 'c', 'd');
    const m = mountedKeys(s, 3);
    assert.deepEqual(
      s.filter((e) => m.has(e.key)).map((e) => e.screenId),
      ['b', 'c', 'd'],
    );
    assert.equal(mountedKeys(s, 0).size, 1, 'at least the top screen is mounted');
  });

  test('topFullIndex skips dialog screens', () => {
    const s = stackOf('a', 'dlg1', 'dlg2');
    assert.equal(
      topFullIndex(s, (id) => id.startsWith('dlg')),
      1,
    );
    assert.equal(
      topFullIndex(s, () => false),
      3,
    );
  });

  test('breadcrumbTrail', () => {
    const s = stackOf('a');
    assert.deepEqual(
      breadcrumbTrail(s, (e) => e.screenId.toUpperCase()).map((c) => [c.index, c.label]),
      [
        [0, ROOT_SCREEN.toUpperCase()],
        [1, 'A'],
      ],
    );
  });

  test('entries and params are frozen', () => {
    const e = makeEntry('x', { id: 1 });
    assert.ok(Object.isFrozen(e));
    assert.ok(Object.isFrozen(e.params));
  });
});

describe('result delivery', () => {
  test('pop(result) resolves the waiter of exactly that entry', async () => {
    const broker = new ResultBroker();
    let s = stackOf('voucher');
    const form = makeEntry('ledger.form', { initialName: 'HDFC' }, true);
    s = navReducer(s, { type: 'push', entry: form });
    const waiting = broker.wait<{ id: number; name: string }>(form.key);
    const { next } = transition(s, { type: 'pop' }, broker, { value: { id: 7, name: 'HDFC Bank' } });
    assert.deepEqual(ids(next), [ROOT_SCREEN, 'voucher']);
    assert.deepEqual(await waiting, { id: 7, name: 'HDFC Bank' });
    assert.equal(broker.size, 0);
  });

  test('Esc (pop without a result) resolves undefined', async () => {
    const broker = new ResultBroker();
    const form = makeEntry('ledger.form', {}, true);
    const s = navReducer(stackOf('voucher'), { type: 'push', entry: form });
    const waiting = broker.wait(form.key);
    transition(s, { type: 'pop' }, broker);
    assert.equal(await waiting, undefined);
  });

  test('a result is not delivered to a waiter of a different entry', async () => {
    const broker = new ResultBroker();
    const opener = makeEntry('picker.form', {}, true);
    let s = navReducer(stackOf('voucher'), { type: 'push', entry: opener });
    const child = makeEntry('child', {});
    s = navReducer(s, { type: 'push', entry: child });
    const waiting = broker.wait(opener.key);
    // The child pops with a value: the opener entry stays on the stack, so its waiter is untouched.
    transition(s, { type: 'pop' }, broker, { value: 'child result' });
    assert.equal(broker.has(opener.key), true);
    // Later the opener is popped without a result.
    transition(navReducer(s, { type: 'pop' }), { type: 'pop' }, broker);
    assert.equal(await waiting, undefined);
  });

  test('popTo / reset / replace settle every removed waiter with undefined', async () => {
    const broker = new ResultBroker();
    const a = makeEntry('a', {}, true);
    const b = makeEntry('b', {}, true);
    let s = navReducer(createRootStack(), { type: 'push', entry: a });
    s = navReducer(s, { type: 'push', entry: b });
    const wa = broker.wait(a.key);
    const wb = broker.wait(b.key);
    transition(s, { type: 'reset' }, broker, { value: 'ignored for a' });
    assert.equal(await wb, 'ignored for a', 'the top entry receives the explicit result');
    assert.equal(await wa, undefined);

    const c = makeEntry('c', {}, true);
    const s2 = navReducer(createRootStack(), { type: 'push', entry: c });
    const wc = broker.wait(c.key);
    transition(s2, { type: 'replace', entry: makeEntry('d') }, broker);
    assert.equal(await wc, undefined);
  });

  test('popEntry delivers to the named entry even when it is not on top', async () => {
    const broker = new ResultBroker();
    const a = makeEntry('a', {}, true);
    let s = navReducer(createRootStack(), { type: 'push', entry: a });
    const above = makeEntry('above', {}, true);
    s = navReducer(s, { type: 'push', entry: above });
    const wa = broker.wait(a.key);
    const wAbove = broker.wait(above.key);
    const { next } = transition(s, { type: 'popEntry', key: a.key }, broker, { value: 42 });
    assert.deepEqual(ids(next), [ROOT_SCREEN]);
    assert.equal(await wa, 42);
    assert.equal(await wAbove, undefined);
  });

  test('settleAll and repeated waits', async () => {
    const broker = new ResultBroker();
    const first = broker.wait('k');
    const second = broker.wait('k');
    assert.equal(await first, undefined, 'a replaced waiter resolves undefined');
    broker.settleAll();
    assert.equal(await second, undefined);
    assert.equal(broker.deliver('k', 1), false);
  });
});

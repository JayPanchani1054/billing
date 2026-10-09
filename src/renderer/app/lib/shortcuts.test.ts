import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONVENTION_SHORTCUTS, GLOBAL_SHORTCUTS, reservedGlobalKeys } from './shortcuts.ts';

const keysOf = (keys: string) => keys.split(',').map((k) => k.trim().toLowerCase());

describe('keyboard map', () => {
  test('no global key is listed twice', () => {
    const all = GLOBAL_SHORTCUTS.flatMap((s) => keysOf(s.keys));
    assert.equal(new Set(all).size, all.length);
  });

  test('screen conventions never use a reserved global key (e.g. Alt+F5 = Sales Order)', () => {
    const reserved = new Set(reservedGlobalKeys().map((k) => k.toLowerCase()));
    const clashes = CONVENTION_SHORTCUTS.flatMap((s) => keysOf(s.keys)).filter((k) => reserved.has(k));
    assert.deepEqual(clashes, []);
    assert.ok(reserved.has('alt+f5'));
  });

  test('each convention key has one meaning within its group', () => {
    const seen = new Map<string, string>();
    for (const s of CONVENTION_SHORTCUTS) {
      for (const k of keysOf(s.keys)) {
        const id = `${s.group}:${k}`;
        assert.ok(!seen.has(id), `${k} means both "${seen.get(id)}" and "${s.label}" in ${s.group}`);
        seen.set(id, s.label);
      }
    }
  });

  test('the cross-screen conventions are documented (F1 overlay)', () => {
    const documented = new Set(CONVENTION_SHORTCUTS.flatMap((s) => keysOf(s.keys)));
    for (const k of ['alt+d', 'ctrl+d', 'alt+2', 'alt+x', 'alt+a', 'alt+enter', 'alt+f1', 'alt+m', 'ctrl+1', 'ctrl+f', 'alt+n', 'alt+e', 'alt+p']) {
      assert.ok(documented.has(k), `${k} missing from CONVENTION_SHORTCUTS`);
    }
  });
});

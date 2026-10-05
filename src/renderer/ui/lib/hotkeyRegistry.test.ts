import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HotkeyRegistry, ROOT_LAYER } from './hotkeyRegistry.ts';
import type { HotkeyEventLike } from './hotkeyRegistry.ts';
import { parseHotkeyList } from './hotkeys.ts';

interface FakeEvent extends HotkeyEventLike {
  prevented: boolean;
  stopped: boolean;
}

function key(k: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; target?: string; composing?: boolean; prevented?: boolean } = {}): FakeEvent {
  const e: FakeEvent = {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: false,
    defaultPrevented: mods.prevented ?? false,
    isComposing: mods.composing ?? false,
    target: mods.target ?? 'body',
    prevented: false,
    stopped: false,
    preventDefault() {
      e.prevented = true;
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
  };
  return e;
}

const make = () => new HotkeyRegistry<FakeEvent>((t) => t === 'input');

test('root bindings fire; consumed events are prevented and stopped', () => {
  const r = make();
  const calls: string[] = [];
  r.addBinding(ROOT_LAYER, parseHotkeyList('F8'), () => void calls.push('sales'));
  const e = key('F8');
  assert.equal(r.dispatch(e), true);
  assert.deepEqual(calls, ['sales']);
  assert.equal(e.prevented, true);
  assert.equal(e.stopped, true);
  assert.equal(r.dispatch(key('F9')), false);
});

test('deeper screen layer wins over root; returning false falls through', () => {
  const r = make();
  const calls: string[] = [];
  const screen = r.allocateLayerId();
  r.upsertLayer(screen, { parent: ROOT_LAYER, blocking: false, active: true });
  r.addBinding(ROOT_LAYER, parseHotkeyList('Escape'), () => void calls.push('pop'));
  const off = r.addBinding(screen, parseHotkeyList('Escape'), () => {
    calls.push('screen');
    return false;
  });
  r.dispatch(key('Escape'));
  assert.deepEqual(calls, ['screen', 'pop']);
  off();
  r.dispatch(key('Escape'));
  assert.deepEqual(calls, ['screen', 'pop', 'pop']);
});

test('blocking layer (modal) fences screen and root hotkeys', () => {
  const r = make();
  const calls: string[] = [];
  const screen = r.allocateLayerId();
  r.upsertLayer(screen, { parent: ROOT_LAYER, blocking: false, active: true });
  const modal = r.allocateLayerId();
  r.upsertLayer(modal, { parent: screen, blocking: true, active: true });
  r.addBinding(ROOT_LAYER, parseHotkeyList('F8'), () => void calls.push('root-F8'));
  r.addBinding(screen, parseHotkeyList('Ctrl+A'), () => void calls.push('screen-save'));
  r.addBinding(modal, parseHotkeyList('Ctrl+A'), () => void calls.push('modal-accept'));
  assert.equal(r.dispatch(key('F8')), false);
  r.dispatch(key('a', { ctrl: true }));
  assert.deepEqual(calls, ['modal-accept']);
  assert.equal(r.hasBlockingLayer(), true);
  r.removeLayer(modal);
  r.dispatch(key('a', { ctrl: true }));
  r.dispatch(key('F8'));
  assert.deepEqual(calls, ['modal-accept', 'screen-save', 'root-F8']);
});

test('stacked dialogs: the newest blocking layer wins, nested scopes inside it still work', () => {
  const r = make();
  const calls: string[] = [];
  const m1 = r.allocateLayerId();
  r.upsertLayer(m1, { parent: ROOT_LAYER, blocking: true, active: true });
  const m2 = r.allocateLayerId();
  r.upsertLayer(m2, { parent: m1, blocking: true, active: true });
  const inner = r.allocateLayerId();
  r.upsertLayer(inner, { parent: m2, blocking: false, active: true });
  r.addBinding(m1, parseHotkeyList('Escape'), () => void calls.push('m1'));
  r.addBinding(m2, parseHotkeyList('Escape'), () => void calls.push('m2'));
  r.addBinding(inner, parseHotkeyList('Alt+C'), () => void calls.push('inner'));
  r.dispatch(key('Escape'));
  r.dispatch(key('c', { alt: true }));
  assert.deepEqual(calls, ['m2', 'inner']);
  assert.deepEqual(r.eligibleLayers(), [inner, m2]);
});

test('inactive layers (background screens) and their descendants are skipped', () => {
  const r = make();
  const calls: string[] = [];
  const s1 = r.allocateLayerId();
  r.upsertLayer(s1, { parent: ROOT_LAYER, blocking: false, active: false });
  const child = r.allocateLayerId();
  r.upsertLayer(child, { parent: s1, blocking: true, active: true });
  r.addBinding(s1, parseHotkeyList('F2'), () => void calls.push('s1'));
  r.addBinding(child, parseHotkeyList('F2'), () => void calls.push('child'));
  r.addBinding(ROOT_LAYER, parseHotkeyList('F2'), () => void calls.push('root'));
  r.dispatch(key('F2'));
  assert.deepEqual(calls, ['root']);
  r.setLayerActive(s1, true);
  r.dispatch(key('F2'));
  assert.deepEqual(calls, ['root', 'child']);
});

test('later binding in the same layer wins', () => {
  const r = make();
  const calls: string[] = [];
  r.addBinding(ROOT_LAYER, parseHotkeyList('F5'), () => void calls.push('first'));
  r.addBinding(ROOT_LAYER, parseHotkeyList('F5'), () => void calls.push('second'));
  r.dispatch(key('F5'));
  assert.deepEqual(calls, ['second']);
});

test('typing combos are ignored inside editable targets unless allowed; F-keys/Esc/modified still fire', () => {
  const r = make();
  const calls: string[] = [];
  r.addBinding(ROOT_LAYER, parseHotkeyList('d'), () => void calls.push('d'));
  r.addBinding(ROOT_LAYER, parseHotkeyList('c'), () => void calls.push('c'), { allowInInputs: true });
  r.addBinding(ROOT_LAYER, parseHotkeyList('F2'), () => void calls.push('F2'));
  r.addBinding(ROOT_LAYER, parseHotkeyList('Alt+C'), () => void calls.push('Alt+C'));
  r.dispatch(key('d', { target: 'input' }));
  r.dispatch(key('c', { target: 'input' }));
  r.dispatch(key('F2', { target: 'input' }));
  r.dispatch(key('c', { alt: true, target: 'input' }));
  r.dispatch(key('d', { target: 'body' }));
  assert.deepEqual(calls, ['c', 'F2', 'Alt+C', 'd']);
});

test('IME composition and already-handled events are ignored', () => {
  const r = make();
  let n = 0;
  r.addBinding(ROOT_LAYER, parseHotkeyList('Enter'), () => void n++);
  assert.equal(r.dispatch(key('Enter', { composing: true })), false);
  assert.equal(r.dispatch(key('Enter', { prevented: true })), false);
  assert.equal(n, 0);
});

test('a child registered before its parent layer is not effective until the parent registers', () => {
  const r = make();
  const calls: string[] = [];
  const parent = r.allocateLayerId();
  const child = r.allocateLayerId();
  r.upsertLayer(child, { parent, blocking: false, active: true });
  r.addBinding(child, parseHotkeyList('F3'), () => void calls.push('child'));
  r.dispatch(key('F3'));
  r.upsertLayer(parent, { parent: ROOT_LAYER, blocking: false, active: true });
  r.dispatch(key('F3'));
  assert.deepEqual(calls, ['child']);
});

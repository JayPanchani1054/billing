/**
 * A confirmation is a question ("Discard unsaved changes?", "Delete voucher Sales/42?", "Quit Pevqori?"),
 * not a form: Ctrl+S — the 2.0 "save" alias of Ctrl+A (docs/ARCHITECTURE.md §7) — must never answer it. A user who
 * reaches for Ctrl+S to save after an accidental Esc would otherwise confirm "Discard changes".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { confirmHotkeys } from './confirmKeys.ts';
import { HotkeyRegistry, ROOT_LAYER } from './hotkeyRegistry.ts';
import type { HotkeyEventLike } from './hotkeyRegistry.ts';
import { parseHotkeyList } from './hotkeys.ts';

interface FakeEvent extends HotkeyEventLike {
  prevented: boolean;
}

function key(k: string, mods: { ctrl?: boolean; target?: string } = {}): FakeEvent {
  const e: FakeEvent = {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    defaultPrevented: false,
    target: mods.target ?? 'body',
    prevented: false,
    preventDefault() {
      e.prevented = true;
      e.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return e;
}

/** A form screen that saves on Ctrl+A, with a confirmation open over it (Modal = blocking layer). */
function setup(opts: { typing?: boolean; yes?: boolean } = {}) {
  const r = new HotkeyRegistry<FakeEvent>((t) => t === 'input');
  const calls: string[] = [];
  const screen = r.allocateLayerId();
  r.upsertLayer(screen, { parent: ROOT_LAYER, blocking: false, active: true });
  r.addBinding(screen, parseHotkeyList('Ctrl+A'), () => void calls.push('screen-save'));
  const modal = r.allocateLayerId();
  r.upsertLayer(modal, { parent: screen, blocking: true, active: true });
  const scope = r.allocateLayerId(); // ConfirmDialog's own HotkeyScope inside the Modal
  r.upsertLayer(scope, { parent: modal, blocking: false, active: true });
  const map = confirmHotkeys({
    onYes: () => {
      if (opts.yes === false) return false;
      calls.push('yes');
      return true;
    },
    onNo: () => void calls.push('no'),
    typing: opts.typing ?? false,
  });
  for (const [combo, handler] of Object.entries(map)) if (handler) r.addBinding(scope, parseHotkeyList(combo), () => handler());
  return { r, calls };
}

test('Ctrl+S never answers a confirmation (and the form beneath does not save either)', () => {
  const { r, calls } = setup();
  const e = key('s', { ctrl: true });
  r.dispatch(e);
  assert.deepEqual(calls, []);
  assert.equal(e.prevented, true, 'the key is taken by the dialog, so nothing else reacts to it');
});

test('Ctrl+S on a typed confirmation does nothing either', () => {
  const { r, calls } = setup({ typing: true });
  r.dispatch(key('s', { ctrl: true }));
  r.dispatch(key('s', { ctrl: true, target: 'input' }));
  assert.deepEqual(calls, []);
});

test('Y and Ctrl+A answer yes, N answers no (unchanged)', () => {
  const { r, calls } = setup();
  r.dispatch(key('a', { ctrl: true }));
  r.dispatch(key('y'));
  r.dispatch(key('n'));
  assert.deepEqual(calls, ['yes', 'yes', 'no']);
});

test('a typed confirmation: Y / N are letters; Ctrl+A answers once the text matches', () => {
  const typed = setup({ typing: true });
  typed.r.dispatch(key('y'));
  typed.r.dispatch(key('n'));
  typed.r.dispatch(key('a', { ctrl: true }));
  assert.deepEqual(typed.calls, ['yes']);
  const incomplete = setup({ typing: true, yes: false });
  const e = key('a', { ctrl: true, target: 'input' });
  assert.equal(incomplete.r.dispatch(e), false, 'Ctrl+A selects the typed text while the confirmation is incomplete');
  assert.deepEqual(incomplete.calls, []);
});

test('ConfirmDialog takes its keys from confirmHotkeys', () => {
  const src = readFileSync(fileURLToPath(new URL('../ConfirmDialog.tsx', import.meta.url)), 'utf8');
  assert.match(src, /useHotkeys\(\s*confirmHotkeys\(/);
});

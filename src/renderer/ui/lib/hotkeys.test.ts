import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent, hotkeyParts, isTypingCombo, matchesHotkey, parseHotkey, parseHotkeyList, toAriaKeyShortcut } from './hotkeys.ts';
import type { KeyEventLike } from './hotkeys.ts';

const ev = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code: mods.code,
  ctrlKey: mods.ctrlKey ?? false,
  altKey: mods.altKey ?? false,
  shiftKey: mods.shiftKey ?? false,
  metaKey: mods.metaKey ?? false,
});

test('parseHotkey handles modifiers, aliases and case', () => {
  assert.deepEqual(parseHotkey('Ctrl+A'), { key: 'a', ctrl: true, alt: false, shift: false, meta: false });
  assert.deepEqual(parseHotkey('alt+f2'), { key: 'f2', ctrl: false, alt: true, shift: false, meta: false });
  assert.deepEqual(parseHotkey('F8'), { key: 'f8', ctrl: false, alt: false, shift: false, meta: false });
  assert.deepEqual(parseHotkey('Shift+Enter'), { key: 'enter', ctrl: false, alt: false, shift: true, meta: false });
  assert.equal(parseHotkey('Esc').key, 'escape');
  assert.equal(parseHotkey('Escape').key, 'escape');
  assert.equal(parseHotkey('Ctrl+Shift+Tab').shift, true);
  assert.equal(parseHotkey('Ctrl++').key, '+');
  assert.equal(parseHotkey('+').key, '+');
  assert.equal(parseHotkey('Mod+K').ctrl, true);
  assert.equal(parseHotkey('PgDn').key, 'pagedown');
  assert.equal(parseHotkey('Space').key, ' ');
});

test('parseHotkey rejects malformed strings', () => {
  assert.throws(() => parseHotkey(''), TypeError);
  assert.throws(() => parseHotkey('Ctrl+Alt'), TypeError);
  assert.throws(() => parseHotkey('Hyper+A'), TypeError);
});

test('parseHotkeyList splits on commas but keeps a comma key', () => {
  assert.deepEqual(parseHotkeyList('Ctrl+G, Alt+G, Ctrl+K').map((h) => h.key), ['g', 'g', 'k']);
  assert.deepEqual(parseHotkeyList('Ctrl+,').map((h) => h.key), [',']);
  assert.deepEqual(parseHotkeyList('Ctrl+,, F1').map((h) => h.key), [',', 'f1']);
});

test('matchesHotkey: exact modifiers, letter case, code fallback', () => {
  const ctrlA = parseHotkey('Ctrl+A');
  assert.equal(matchesHotkey(ev('a', { ctrlKey: true }), ctrlA), true);
  assert.equal(matchesHotkey(ev('A', { ctrlKey: true }), ctrlA), true);
  assert.equal(matchesHotkey(ev('a', { ctrlKey: true, shiftKey: true }), ctrlA), false);
  assert.equal(matchesHotkey(ev('a', { ctrlKey: true, altKey: true }), ctrlA), false);
  assert.equal(matchesHotkey(ev('a'), ctrlA), false);
  // non-latin layout: key differs, physical code matches
  assert.equal(matchesHotkey(ev('ф', { ctrlKey: true, code: 'KeyA' }), ctrlA), true);
  assert.equal(matchesHotkey(ev('F2', { altKey: true }), parseHotkey('Alt+F2')), true);
  assert.equal(matchesHotkey(ev('F2'), parseHotkey('Alt+F2')), false);
  assert.equal(matchesHotkey(ev('Escape'), parseHotkey('Esc')), true);
  assert.equal(matchesHotkey(ev('Enter', { shiftKey: true }), parseHotkey('Shift+Enter')), true);
  assert.equal(matchesHotkey(ev('Enter'), parseHotkey('Shift+Enter')), false);
  // symbol keys ignore Shift (needed to type them)
  assert.equal(matchesHotkey(ev('+', { shiftKey: true }), parseHotkey('+')), true);
  assert.equal(matchesHotkey(ev('+', { code: 'NumpadAdd' }), parseHotkey('Plus')), true);
  assert.equal(matchesHotkey(ev('Tab', { ctrlKey: true, shiftKey: true }), parseHotkey('Ctrl+Shift+Tab')), true);
});

test('typing combos are recognised', () => {
  assert.equal(isTypingCombo(parseHotkey('d')), true);
  assert.equal(isTypingCombo(parseHotkey('Shift+Enter')), true);
  assert.equal(isTypingCombo(parseHotkey('F8')), false);
  assert.equal(isTypingCombo(parseHotkey('Escape')), false);
  assert.equal(isTypingCombo(parseHotkey('Alt+C')), false);
});

test('display helpers', () => {
  assert.deepEqual(hotkeyParts('ctrl+shift+a'), ['Ctrl', 'Shift', 'A']);
  assert.deepEqual(hotkeyParts('Alt+F2'), ['Alt', 'F2']);
  assert.deepEqual(hotkeyParts('Escape'), ['Esc']);
  assert.deepEqual(hotkeyParts('Down'), ['↓']);
  assert.equal(toAriaKeyShortcut('Ctrl+A'), 'Control+A');
  assert.equal(toAriaKeyShortcut('Alt+F2, Ctrl+K'), 'Alt+F2 Control+K');
  assert.equal(describeEvent(ev('a', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+A');
  assert.equal(describeEvent(ev('Control', { ctrlKey: true })), 'Ctrl');
});

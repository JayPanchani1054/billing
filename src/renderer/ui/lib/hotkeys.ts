/**
 * Hotkey strings → structured combos, event matching and display parts. Pure (no DOM types needed).
 *
 *   parseHotkey('Ctrl+A')        → { key: 'a', ctrl: true, alt: false, shift: false, meta: false }
 *   parseHotkey('Alt+F2')        → { key: 'f2', alt: true, … }
 *   parseHotkey('Shift+Enter')   → { key: 'enter', shift: true, … }
 *   parseHotkey('Ctrl++')        → { key: '+', ctrl: true, … }
 *   parseHotkeyList('Ctrl+G, Alt+G, Ctrl+K') → three combos
 */

export interface ParsedHotkey {
  /** Normalised key: lowercase letter/digit/symbol, or a named key ('enter', 'escape', 'f8', 'arrowdown', ' '). */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** Minimal shape of a keyboard event (DOM KeyboardEvent or React's synthetic one both satisfy it). */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  del: 'delete',
  delete: 'delete',
  ins: 'insert',
  insert: 'insert',
  bksp: 'backspace',
  backspace: 'backspace',
  space: ' ',
  spacebar: ' ',
  plus: '+',
  minus: '-',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  pgup: 'pageup',
  pageup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
  pagedown: 'pagedown',
  home: 'home',
  end: 'end',
  tab: 'tab',
};

const MODIFIERS: Readonly<Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  mod: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  win: 'meta',
  super: 'meta',
};

/** Normalise a key name or KeyboardEvent.key to the registry's canonical form. */
export function normalizeKey(key: string): string {
  if (key === ' ') return ' ';
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/** Split 'Ctrl+Shift++' into ['Ctrl', 'Shift', '+'] — a '+' following a '+' separator is the key. */
function splitCombo(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '+' && cur !== '') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '') parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Parse one combo. Throws a TypeError for malformed strings (programmer error, surfaced early). */
export function parseHotkey(input: string): ParsedHotkey {
  const parts = splitCombo(input.trim());
  if (parts.length === 0) throw new TypeError(`Invalid hotkey: '${input}'`);
  const out: ParsedHotkey = { key: '', ctrl: false, alt: false, shift: false, meta: false };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const mod = MODIFIERS[p.toLowerCase()];
    const isLast = i === parts.length - 1;
    if (mod && !isLast) {
      out[mod] = true;
    } else if (isLast) {
      if (mod) throw new TypeError(`Hotkey '${input}' has no key, only modifiers`);
      out.key = normalizeKey(p);
    } else {
      throw new TypeError(`Invalid modifier '${p}' in hotkey '${input}'`);
    }
  }
  return out;
}

/** Split a comma-separated combo list: 'Ctrl+G, Alt+G' → ['Ctrl+G', 'Alt+G']; 'Ctrl+,' stays one combo. */
export function splitHotkeyList(input: string): string[] {
  const combos: string[] = [];
  let cur = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    // A comma separates combos unless it is itself the key (directly after a '+' separator or at start).
    if (ch === ',' && cur.trim() !== '' && !cur.endsWith('+')) {
      combos.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') combos.push(cur.trim());
  return combos;
}

/** Parse a comma-separated list: 'Ctrl+G, Alt+G'. A literal comma key is written 'Ctrl+,' (no space after). */
export function parseHotkeyList(input: string): ParsedHotkey[] {
  return splitHotkeyList(input).map(parseHotkey);
}

function isLetter(k: string): boolean {
  return k.length === 1 && k >= 'a' && k <= 'z';
}
function isDigit(k: string): boolean {
  return k.length === 1 && k >= '0' && k <= '9';
}
/** A single printable character that typically needs Shift on some layouts ('+', '?', '!' …). */
function isShiftedSymbol(k: string): boolean {
  return k.length === 1 && !isLetter(k) && !isDigit(k) && k !== ' ';
}

export function isFunctionKey(key: string): boolean {
  return /^f([1-9]|1[0-9]|2[0-4])$/.test(normalizeKey(key));
}

/** Does the event match the combo? Modifiers must match exactly (Shift is ignored for symbol keys). */
export function matchesHotkey(e: KeyEventLike, h: ParsedHotkey): boolean {
  if (e.ctrlKey !== h.ctrl || e.altKey !== h.alt || e.metaKey !== h.meta) return false;
  const shiftInsensitive = isShiftedSymbol(h.key);
  if (!shiftInsensitive && e.shiftKey !== h.shift) return false;
  const k = normalizeKey(e.key);
  if (k === h.key) return true;
  // Layout fallbacks: Alt/Ctrl combos may report a different `key`, but `code` is physical.
  if (e.code) {
    if (isLetter(h.key) && e.code === `Key${h.key.toUpperCase()}`) return true;
    if (isDigit(h.key) && (e.code === `Digit${h.key}` || e.code === `Numpad${h.key}`)) return true;
    if (h.key === '+' && e.code === 'NumpadAdd') return true;
    if (h.key === '-' && e.code === 'NumpadSubtract') return true;
  }
  return false;
}

/** True when a combo is "plain typing" — no Ctrl/Alt/Meta and not a function key or Escape. */
export function isTypingCombo(h: ParsedHotkey): boolean {
  if (h.ctrl || h.alt || h.meta) return false;
  if (isFunctionKey(h.key) || h.key === 'escape') return false;
  return true;
}

const DISPLAY: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
  delete: 'Del',
  insert: 'Ins',
  backspace: 'Backspace',
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
  tab: 'Tab',
};

/** Display parts for <Kbd>: 'ctrl+shift+a' → ['Ctrl', 'Shift', 'A']; 'alt+f2' → ['Alt', 'F2']. */
export function hotkeyParts(input: string): string[] {
  const h = parseHotkey(input);
  const parts: string[] = [];
  if (h.ctrl) parts.push('Ctrl');
  if (h.alt) parts.push('Alt');
  if (h.shift) parts.push('Shift');
  if (h.meta) parts.push('Win');
  const named = DISPLAY[h.key];
  if (named) parts.push(named);
  else if (isFunctionKey(h.key)) parts.push(h.key.toUpperCase());
  else parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key[0].toUpperCase() + h.key.slice(1));
  return parts;
}

/** Canonical string for a combo, e.g. for aria-keyshortcuts: 'Control+Shift+A', 'Alt+F2'. */
export function toAriaKeyShortcut(input: string): string {
  return parseHotkeyList(input)
    .map((h) => {
      const parts: string[] = [];
      if (h.ctrl) parts.push('Control');
      if (h.alt) parts.push('Alt');
      if (h.shift) parts.push('Shift');
      if (h.meta) parts.push('Meta');
      const named: Record<string, string> = {
        escape: 'Escape',
        enter: 'Enter',
        ' ': 'Space',
        arrowup: 'ArrowUp',
        arrowdown: 'ArrowDown',
        arrowleft: 'ArrowLeft',
        arrowright: 'ArrowRight',
        pageup: 'PageUp',
        pagedown: 'PageDown',
        delete: 'Delete',
        backspace: 'Backspace',
        home: 'Home',
        end: 'End',
        tab: 'Tab',
        insert: 'Insert',
        '+': 'Plus',
      };
      parts.push(named[h.key] ?? h.key.toUpperCase());
      return parts.join('+');
    })
    .join(' ');
}

/** Human description of an event, e.g. 'Ctrl+Shift+A' — handy for logging/debugging. */
export function describeEvent(e: KeyEventLike): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Win');
  const k = normalizeKey(e.key);
  if (k !== 'control' && k !== 'alt' && k !== 'shift' && k !== 'meta') {
    parts.push(DISPLAY[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)));
  }
  return parts.join('+');
}

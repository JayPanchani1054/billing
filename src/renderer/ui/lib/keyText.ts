/**
 * Keys as words (2.1, SPEC-21 D4: "keys are learned, not printed"): the plain text run a menu, a
 * tooltip or the button key reveal shows instead of boxed chips, and the underlined accelerator of a
 * confirm button. Pure (keyText.test.ts); the components (Kbd, Button, Tooltip, ConfirmDialog) render it.
 */
import { hotkeyParts, splitHotkeyList } from './hotkeys.ts';

/** 'Ctrl+G, Ctrl+K' → 'Ctrl+G or Ctrl+K'; 'alt+down' → 'Alt+↓' (display names from hotkeyParts). */
export function plainKeys(keys: string): string {
  return splitHotkeyList(keys)
    .map((combo) => {
      try {
        return hotkeyParts(combo).join('+');
      } catch {
        return combo;
      }
    })
    .join(' or ');
}

/** Tooltip text for an action with a key: "Print · Alt+P"; the label alone without one ('' = NO_KEY). */
export function keyTip(label: string, key?: string | null): string {
  const k = key?.trim();
  return k ? `${label} · ${plainKeys(k)}` : label;
}

/**
 * Split a label for an underlined accelerator: [letter, rest] when the label starts with `letter`
 * (case-insensitive) — "Yes" + 'Y' → ['Y', 'es'] — otherwise null (the label is shown as it is).
 */
export function accelSplit(label: string, letter: string): [string, string] | null {
  if (label === '' || letter === '' || label[0].toUpperCase() !== letter[0].toUpperCase()) return null;
  return [label[0], label.slice(1)];
}

/**
 * Tooltips of a confirmation's two buttons, "Label · keys" like every other button: Y / N answer only
 * while no confirmation text has to be typed (then they are letters); Ctrl+A and Esc always work.
 */
export function confirmTips(confirmLabel: string, cancelLabel: string, typing: boolean): { confirm: string; cancel: string } {
  return {
    confirm: `${confirmLabel} · ${typing ? 'Ctrl+A' : 'Y or Ctrl+A'}`,
    cancel: `${cancelLabel} · ${typing ? 'Esc' : 'N or Esc'}`,
  };
}

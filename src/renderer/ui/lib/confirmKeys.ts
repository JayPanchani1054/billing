/**
 * The keys of a Yes/No confirmation (ui/ConfirmDialog.tsx) — pure, so the rule is unit-testable with the
 * hotkey registry (confirmKeys.test.ts):
 *
 *   - Ctrl+A and Y answer yes, N answers no (Esc cancels through the Modal);
 *   - Ctrl+S is taken and does nothing. Ctrl+S is the "save" alias of Ctrl+A (docs/ARCHITECTURE.md §7, hotkeyRegistry.ts),
 *     and a confirmation is a question — "Discard unsaved changes?", "Delete voucher Sales/42?", "Quit
 *     Pevqori?" — that a save reflex must never answer. Binding it here keeps the alias away (the registry
 *     only aliases where nothing binds Ctrl+S).
 */

export interface ConfirmKeyHandlers {
  /** Answer yes; return false to pass the key on (the typed confirmation is not complete yet). */
  onYes: () => boolean;
  onNo: () => void;
  /** A text must be typed to confirm: plain Y / N are letters then, not answers. */
  typing: boolean;
}

/** Hotkey map of a confirmation dialog (for useHotkeys). */
export function confirmHotkeys({ onYes, onNo, typing }: ConfirmKeyHandlers): Record<string, (() => boolean | void) | undefined> {
  return {
    'Ctrl+A': onYes,
    'Ctrl+S': () => true,
    y: typing ? undefined : onYes,
    n: typing ? undefined : onNo,
  };
}

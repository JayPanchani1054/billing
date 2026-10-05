/**
 * App-wide hotkey runtime: the singleton registry, its window listener and the layer context that
 * <HotkeyScope> provides and useHotkeys consumes.
 */
import { createContext } from 'react';
import { HotkeyRegistry, ROOT_LAYER } from '../lib/hotkeyRegistry.ts';
import { isEditableTarget } from '../lib/dom.ts';

export { ROOT_LAYER };

export const hotkeyRegistry = new HotkeyRegistry<KeyboardEvent>(isEditableTarget);

/** The hotkey layer id of the nearest <HotkeyScope> (root = app-global). */
export const HotkeyLayerContext = createContext<number>(ROOT_LAYER);

let listening = false;

/** Attach the single window keydown listener (bubble phase → runs after component handlers). */
export function ensureHotkeyListener(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    hotkeyRegistry.dispatch(e);
  });
}

/** True while a dialog/popover fences the app (e.g. to dim global status-bar hints). */
export function isHotkeyFenced(): boolean {
  return hotkeyRegistry.hasBlockingLayer();
}

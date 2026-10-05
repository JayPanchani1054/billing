import { useContext, useEffect } from 'react';
import type { DependencyList } from 'react';
import { parseHotkeyList } from '../lib/hotkeys.ts';
import { HotkeyLayerContext, ROOT_LAYER, ensureHotkeyListener, hotkeyRegistry } from './hotkeyRuntime.ts';
import { useLatestRef } from './useLatestRef.ts';

/** Return `false` to decline the key (it then continues to lower-priority bindings). */
export type HotkeyHandler = (event: KeyboardEvent) => boolean | void;

/** Keys: 'Ctrl+A', 'Alt+F2', 'F8', 'Shift+Enter', 'Escape', or a list 'Ctrl+G, Ctrl+K'. Falsy values are skipped. */
export type HotkeyMap = Readonly<Record<string, HotkeyHandler | null | undefined | false>>;

export interface UseHotkeysOptions {
  /** Default true. */
  enabled?: boolean;
  /**
   * 'auto' (default): bind to the nearest <HotkeyScope> (screen, dialog…). 'global': bind to the
   * app root layer regardless of where the component sits (fenced while a dialog is open).
   */
  scope?: 'auto' | 'global';
  /** Fire plain typing keys ('d', 'Shift+Enter') even when focus is in an input. Default false. */
  allowInInputs?: boolean;
  /** Fire on auto-repeat while the key is held. Default true. */
  allowRepeat?: boolean;
}

/**
 * Register keyboard shortcuts. Handlers always see the latest props (no need to list them in
 * `deps`); `deps` re-registers the bindings when listed values change. Matching events are
 * preventDefault-ed and stopped. Priority: dialogs fence everything beneath them; deeper scopes beat
 * shallower ones; newer beats older.
 */
export function useHotkeys(map: HotkeyMap, deps: DependencyList = [], options: UseHotkeysOptions = {}): void {
  const contextLayer = useContext(HotkeyLayerContext);
  const { enabled = true, scope = 'auto', allowInInputs = false, allowRepeat = true } = options;
  const layer = scope === 'global' ? ROOT_LAYER : contextLayer;
  const mapRef = useLatestRef(map);
  const signature = Object.keys(map)
    .filter((k) => !!map[k])
    .join('\n');

  useEffect(() => {
    if (!enabled || signature === '') return undefined;
    ensureHotkeyListener();
    const offs = signature.split('\n').map((combo) =>
      hotkeyRegistry.addBinding(
        layer,
        parseHotkeyList(combo),
        (e) => {
          const h = mapRef.current[combo];
          return h ? h(e) : false;
        },
        { allowInInputs, allowRepeat },
      ),
    );
    return () => {
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, enabled, signature, allowInInputs, allowRepeat, mapRef, ...deps]);
}

/** The current hotkey layer id (for advanced integrations). */
export function useHotkeyLayer(): number {
  return useContext(HotkeyLayerContext);
}

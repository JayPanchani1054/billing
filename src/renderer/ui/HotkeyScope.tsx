import { useContext, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { HotkeyLayerContext, hotkeyRegistry } from './hooks/hotkeyRuntime.ts';
import { useHotkeys } from './hooks/useHotkeys.ts';
import type { HotkeyMap, UseHotkeysOptions } from './hooks/useHotkeys.ts';

export interface HotkeyScopeProps {
  /** Inactive scopes (and everything inside them) receive no hotkeys — e.g. screens below the top of the nav stack. */
  active?: boolean;
  /** Blocking scopes fence everything outside them (dialogs, drawers, menus). */
  blocking?: boolean;
  children?: ReactNode;
}

/**
 * A hotkey layer. Wrap each screen in `<HotkeyScope active={isTopOfStack}>`; overlays in the kit
 * (Modal, Drawer, Popover, DropdownMenu) create blocking scopes automatically.
 */
export function HotkeyScope({ active = true, blocking = false, children }: HotkeyScopeProps) {
  const parent = useContext(HotkeyLayerContext);
  const [id] = useState(() => hotkeyRegistry.allocateLayerId());

  // Re-registering on any change also refreshes the activation order (a re-activated screen is "newest").
  useLayoutEffect(() => {
    hotkeyRegistry.upsertLayer(id, { parent, blocking, active });
    return () => hotkeyRegistry.removeLayer(id);
  }, [id, parent, blocking, active]);

  return <HotkeyLayerContext.Provider value={id}>{children}</HotkeyLayerContext.Provider>;
}

export interface HotkeysProps extends UseHotkeysOptions {
  map: HotkeyMap;
}

/** Declarative useHotkeys — handy inside a <HotkeyScope> you render in the same component. */
export function Hotkeys({ map, ...options }: HotkeysProps) {
  useHotkeys(map, [], options);
  return null;
}

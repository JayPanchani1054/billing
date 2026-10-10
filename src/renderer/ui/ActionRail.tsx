import { Fragment, useRef } from 'react';
import type { Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Kbd } from './Kbd.tsx';
import { useHotkeys } from './hooks/useHotkeys.ts';
import type { HotkeyMap } from './hooks/useHotkeys.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { useRovingFocus } from './hooks/useRovingFocus.ts';
import { cx } from './lib/cx.ts';
import { toAriaKeyShortcut } from './lib/hotkeys.ts';

export interface ActionRailItem {
  /** Hotkey shown in the chip and registered for the current screen: 'F2', 'Alt+F2', 'Ctrl+A'. */
  key: string;
  label: string;
  onClick: () => void;
  /** Shown greyed and announced as unavailable; the hotkey does nothing. */
  disabled?: boolean;
  /** Not rendered and the hotkey is not registered (feature off / no permission). */
  hidden?: boolean;
  /** React key when the same hotkey appears twice (rare). */
  id?: string;
  /** Items with a different group than the previous one get a divider (and an optional caption). */
  group?: string;
  icon?: IconName;
  /** Explains why it is disabled or what it does (tooltip + description). */
  hint?: string;
  /** Highlight the primary action (e.g. 'Ctrl+A: Accept'). */
  primary?: boolean;
  /**
   * (additive, 2.0) Show this action as a button in the screen bar's command bar ahead of the
   * convention list (app/lib/commandBar.ts); otherwise it sits under "More". Write it AFTER `onClick`
   * in object literals, never straight after `label` (the key-convention scan reads `key, label, onClick`).
   */
  prominent?: boolean;
}

export interface ActionRailProps {
  items: readonly ActionRailItem[];
  /** Register item keys as hotkeys in the current HotkeyScope (default true). */
  registerHotkeys?: boolean;
  /** Show group captions (default false — dividers only). */
  showGroupLabels?: boolean;
  'aria-label'?: string;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/**
 * Keyboard-first right-hand button bar: every screen action with its key chip ("F2 Date",
 * "Alt+F2 Period", "Ctrl+A Accept"). One Tab stop with ↑/↓ roving; the keys work from anywhere on
 * the screen because the rail registers them as screen-level hotkeys.
 */
export function ActionRail({ items, registerHotkeys = true, showGroupLabels = false, className, ref, ...aria }: ActionRailProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const merged = useMergedRefs(navRef, ref);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: true });
  const visible = items.filter((i) => !i.hidden);

  const map: Record<string, (() => void) | undefined> = {};
  for (const it of visible) map[it.key] = it.disabled ? undefined : () => it.onClick();
  useHotkeys(map as HotkeyMap, [], { enabled: registerHotkeys });

  return (
    <aside ref={merged} className={cx('bx-rail', className)} aria-label={aria['aria-label'] ?? 'Screen actions'}>
      <div ref={listRef} role="toolbar" aria-orientation="vertical" aria-label={aria['aria-label'] ?? 'Screen actions'} className="bx-rail__list" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {visible.map((it, i) => {
          const prev = visible[i - 1];
          const newGroup = i > 0 && (it.group ?? '') !== (prev?.group ?? '');
          let aria: string | undefined;
          try {
            aria = toAriaKeyShortcut(it.key);
          } catch {
            aria = undefined;
          }
          return (
            <Fragment key={it.id ?? it.key}>
              {newGroup ? <div className="bx-rail__divider" role="separator" /> : null}
              {showGroupLabels && it.group && (i === 0 || newGroup) ? <div className="bx-rail__group">{it.group}</div> : null}
              <button
                type="button"
                data-roving-item=""
                className={cx('bx-rail__item', it.primary && 'bx-rail__item--primary', it.disabled && 'is-disabled')}
                aria-disabled={it.disabled || undefined}
                aria-keyshortcuts={aria}
                title={it.hint}
                onClick={() => {
                  if (!it.disabled) it.onClick();
                }}
              >
                <Kbd keys={it.key} size="sm" tone={it.primary ? 'inverse' : 'default'} className="bx-rail__kbd" />
                <span className="bx-rail__label">{it.label}</span>
                {it.icon ? <Icon name={it.icon} size="sm" className="bx-rail__icon" /> : null}
              </button>
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}

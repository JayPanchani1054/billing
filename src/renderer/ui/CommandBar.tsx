import { useRef } from 'react';
import { Button } from './Button.tsx';
import { DropdownMenu } from './Menu.tsx';
import type { MenuEntry } from './Menu.tsx';
import type { ActionRailItem } from './ActionRail.tsx';
import { useRovingFocus } from './hooks/useRovingFocus.ts';
import { cx } from './lib/cx.ts';
import { keyTip } from './lib/keyText.ts';

export interface CommandBarProps {
  /** The filled button (the screen's `primary` action), if any. */
  primary?: ActionRailItem | null;
  /** Secondary buttons, in display order. */
  buttons: readonly ActionRailItem[];
  /** Everything else, listed under "More" with its key (grouped by `group`). */
  more: readonly ActionRailItem[];
  'aria-label'?: string;
  className?: string;
}

/**
 * The button's tooltip: "Print · Alt+P" (`keyTip`; a NO_KEY item shows its label), then the action's `hint`
 * after " — " — the description a 2.0 button showed on hover, or why a disabled one cannot run.
 */
function tip(it: ActionRailItem): string {
  const base = keyTip(it.label, it.key);
  return it.hint ? `${base} — ${it.hint}` : base;
}

/**
 * The title row's action buttons plus a "More" menu (2.1: the shell renders it into the top screen's
 * `[data-actions-slot]`). Text-only buttons — the key is in the tooltip ("Print · Alt+P"), in
 * `aria-keyshortcuts`, and in the button's own key chip, which the stylesheet shows only on
 * `:focus-visible` and while Ctrl is held (`html[data-keys]`). More lists every other action with its
 * key as plain text (none for NO_KEY items); checkable items are menuitemcheckbox. Purely
 * presentational: it never registers hotkeys — the keys belong to whoever contributed the actions
 * (useScreenActions), so showing an action here or not never changes what its key does. A toolbar with
 * one Tab stop: ←/→ move between buttons.
 */
export function CommandBar({ primary, buttons, more, className, ...aria }: CommandBarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(ref, { orientation: 'horizontal', loop: true });
  if (!primary && buttons.length === 0 && more.length === 0) return null;

  const entries: MenuEntry[] = [];
  more.forEach((it, i) => {
    const prev = more[i - 1];
    if (i > 0 && (it.group ?? '') !== (prev?.group ?? '')) entries.push({ type: 'separator', key: `sep-${i}` });
    entries.push({
      key: `${i}:${it.id ?? it.key}`,
      label: it.label,
      textValue: it.label,
      shortcut: it.key.trim() || undefined,
      disabled: it.disabled,
      checked: it.checked,
      description: it.disabled && it.hint ? it.hint : undefined,
      onSelect: () => {
        if (!it.disabled) it.onClick();
      },
    });
  });

  const button = (it: ActionRailItem, isPrimary: boolean) => (
    <Button
      key={`${it.id ?? ''}:${it.key}`}
      size="sm"
      variant={isPrimary ? 'primary' : 'ghost'}
      shortcut={it.key.trim() || undefined}
      data-roving-item=""
      aria-disabled={it.disabled || undefined}
      className={cx('bx-cmdbar__btn', it.disabled && 'is-disabled')}
      title={tip(it)}
      onClick={() => {
        if (!it.disabled) it.onClick();
      }}
    >
      {it.label}
    </Button>
  );

  return (
    <div ref={ref} role="toolbar" aria-label={aria['aria-label'] ?? 'Actions'} className={cx('bx-cmdbar', className)} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
      {primary ? button(primary, true) : null}
      {buttons.map((it) => button(it, false))}
      {entries.length > 0 ? (
        <DropdownMenu
          items={entries}
          aria-label="More actions"
          placement="bottom-end"
          menuClassName="bx-cmdbar__menu"
          renderTrigger={(p) => (
            <Button {...p} size="sm" variant="ghost" iconRight="chevron-down" data-roving-item="" aria-label="More actions" title="More actions" className="bx-cmdbar__more">
              More
            </Button>
          )}
        />
      ) : null}
    </div>
  );
}

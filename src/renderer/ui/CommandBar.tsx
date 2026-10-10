import { useRef } from 'react';
import { Button } from './Button.tsx';
import { DropdownMenu } from './Menu.tsx';
import type { MenuEntry } from './Menu.tsx';
import type { ActionRailItem } from './ActionRail.tsx';
import { useRovingFocus } from './hooks/useRovingFocus.ts';
import { cx } from './lib/cx.ts';

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
 * One row of action buttons with their key chips plus a "More" menu (the 2.0 screen bar). Purely
 * presentational: it never registers hotkeys — the keys belong to whoever contributed the actions
 * (useScreenActions), so showing an action here or not never changes what its key does. A toolbar
 * with one Tab stop: ←/→ move between buttons.
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
      icon: it.icon,
      shortcut: it.key,
      disabled: it.disabled,
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
      icon={it.icon}
      shortcut={it.key}
      data-roving-item=""
      aria-disabled={it.disabled || undefined}
      className={cx('bx-cmdbar__btn', it.disabled && 'is-disabled')}
      title={it.hint}
      onClick={() => it.onClick()}
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
            <Button {...p} size="sm" variant="ghost" iconRight="chevron-down" data-roving-item="" aria-label="More actions" className="bx-cmdbar__more">
              More
            </Button>
          )}
        />
      ) : null}
    </div>
  );
}

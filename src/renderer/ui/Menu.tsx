import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react';
import { Button } from './Button.tsx';
import type { ButtonVariant } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Kbd } from './Kbd.tsx';
import { Popover } from './Popover.tsx';
import type { Placement } from './Popover.tsx';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { useRovingFocus } from './hooks/useRovingFocus.ts';
import { cx } from './lib/cx.ts';
import type { ControlSize } from './types.ts';

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** Text for type-ahead when `label` is not a string. */
  textValue?: string;
  icon?: IconName;
  /** Shortcut hint shown at the right (register the key separately). */
  shortcut?: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Destructive action styling (still needs a confirmation step). */
  danger?: boolean;
  /** Renders a check mark and role="menuitemcheckbox". */
  checked?: boolean;
  onSelect?: () => void;
}

export interface MenuSeparator {
  type: 'separator';
  key: string;
}

export interface MenuSectionLabel {
  type: 'label';
  key: string;
  label: ReactNode;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuSectionLabel;

function isItem(e: MenuEntry): e is MenuItem {
  return !('type' in e);
}

export interface MenuProps {
  items: readonly MenuEntry[];
  /** Called with the item key after its own onSelect. */
  onAction?: (key: string) => void;
  /** Called after an item is chosen (DropdownMenu closes here). */
  onClose?: () => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
  /** Focus an item on mount: 'first' (default), 'last', or false. */
  autoFocus?: 'first' | 'last' | false;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Vertical action menu (role="menu"): ↑/↓ move (wrapping), Home/End, type-ahead, Enter/Space
 * activate. Disabled items stay focusable (discoverable) but do nothing.
 */
export function Menu({ items, onAction, onClose, id, autoFocus = 'first', className, ref, ...aria }: MenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const merged = useMergedRefs(rootRef, ref);
  const roving = useRovingFocus(rootRef, { orientation: 'vertical', loop: true, typeahead: true });

  useLayoutEffect(() => {
    if (!autoFocus) return;
    const list = roving.getItems();
    const el = autoFocus === 'last' ? list[list.length - 1] : list[0];
    if (el) {
      for (const it of list) it.tabIndex = it === el ? 0 : -1;
      el.focus({ preventScroll: true });
    }
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activate = (item: MenuItem) => {
    if (item.disabled) return;
    item.onSelect?.();
    onAction?.(item.key);
    onClose?.();
  };

  return (
    <div
      ref={merged}
      id={id}
      role="menu"
      aria-orientation="vertical"
      className={cx('bx-menu', className)}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      {...aria}
    >
      {items.map((entry) => {
        if (!isItem(entry)) {
          return entry.type === 'separator' ? (
            <div key={entry.key} role="separator" className="bx-menu__separator" />
          ) : (
            <div key={entry.key} role="presentation" className="bx-menu__label">
              {entry.label}
            </div>
          );
        }
        const textValue = entry.textValue ?? (typeof entry.label === 'string' ? entry.label : undefined);
        return (
          <button
            key={entry.key}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked === undefined ? undefined : entry.checked}
            aria-disabled={entry.disabled || undefined}
            data-roving-item=""
            data-text-value={textValue}
            tabIndex={-1}
            className={cx('bx-menu__item', entry.danger && 'bx-menu__item--danger', entry.disabled && 'is-disabled')}
            onClick={() => activate(entry)}
          >
            <span className="bx-menu__icon" aria-hidden="true">
              {entry.checked ? <Icon name="check" size="sm" /> : entry.icon ? <Icon name={entry.icon} size="sm" /> : null}
            </span>
            <span className="bx-menu__text">
              <span className="bx-menu__item-label">{entry.label}</span>
              {entry.description ? <span className="bx-menu__desc">{entry.description}</span> : null}
            </span>
            {entry.shortcut ? <Kbd keys={entry.shortcut} size="sm" tone="subtle" className="bx-menu__kbd" /> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
}

export interface DropdownMenuProps {
  items: readonly MenuEntry[];
  onAction?: (key: string) => void;
  /** Default trigger content (a Button). */
  label?: ReactNode;
  icon?: IconName;
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Required when the default trigger has no visible label. */
  'aria-label'?: string;
  disabled?: boolean;
  placement?: Placement;
  /** Custom trigger: spread the given props onto a button. */
  renderTrigger?: (props: MenuTriggerProps) => ReactNode;
  menuClassName?: string;
}

/** Button + popup Menu. ↓/Enter/Space open on the first item, ↑ opens on the last; Esc returns focus. */
export function DropdownMenu({
  items,
  onAction,
  label,
  icon,
  variant = 'secondary',
  size = 'md',
  disabled,
  placement = 'bottom-start',
  renderTrigger,
  menuClassName,
  ...aria
}: DropdownMenuProps) {
  const [open, setOpen] = useState<false | 'first' | 'last'>(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const triggerId = useId();

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    onClick: () => setOpen((o) => (o ? false : 'first')),
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen('first');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen('last');
      }
    },
    'aria-haspopup': 'menu',
    'aria-expanded': !!open,
    'aria-controls': open ? menuId : undefined,
  };

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      {renderTrigger ? (
        renderTrigger(triggerProps)
      ) : (
        <Button
          {...triggerProps}
          id={triggerId}
          variant={variant}
          size={size}
          icon={icon}
          iconRight={label ? 'chevron-down' : undefined}
          disabled={disabled}
          aria-label={aria['aria-label']}
        >
          {label}
        </Button>
      )}
      <Popover open={!!open} onClose={() => setOpen(false)} anchorRef={triggerRef} placement={placement} role="none" initialFocus="none" flush>
        {open ? (
          <Menu
            id={menuId}
            items={items}
            onAction={onAction}
            onClose={close}
            autoFocus={open}
            aria-labelledby={renderTrigger ? undefined : triggerId}
            aria-label={renderTrigger ? aria['aria-label'] : undefined}
            className={menuClassName}
          />
        ) : null}
      </Popover>
    </>
  );
}

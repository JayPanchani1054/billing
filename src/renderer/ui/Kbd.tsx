import { Fragment } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { hotkeyParts, splitHotkeyList } from './lib/hotkeys.ts';
import { cx } from './lib/cx.ts';
import { plainKeys } from './lib/keyText.ts';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Hotkey string rendered as chips: 'Ctrl+A' → [Ctrl]+[A]; lists 'Ctrl+G, Ctrl+K' join with "or". */
  keys?: string;
  /** Free content for a single chip when `keys` is not used. */
  children?: ReactNode;
  size?: 'sm' | 'md';
  /**
   * 'default' = boxed key caps (2.1: the F1 card and the opt-in shortcut bar only); 'subtle' = one plain
   * muted text run ("Ctrl+F8") for menus, tooltips and the button key reveal; 'inverse' = boxed on a
   * solid background (the shortcut bar's primary item).
   */
  tone?: 'default' | 'inverse' | 'subtle';
  ref?: Ref<HTMLElement>;
}

function partsOf(combo: string): string[] {
  try {
    return hotkeyParts(combo);
  } catch {
    return [combo];
  }
}

/** Keys as boxed chips (F1) or, with tone="subtle", as one plain text run (D4: keys are printed, not boxed). */
export function Kbd({ keys, children, size = 'md', tone = 'default', className, ...rest }: KbdProps) {
  if (tone === 'subtle') {
    const text = keys === undefined ? children : plainKeys(keys);
    return (
      <kbd className={cx('bx-kbd--plain', className)} {...rest}>
        {text}
      </kbd>
    );
  }
  const cls = cx('bx-kbd-group', `bx-kbd-group--${size}`, tone !== 'default' && `bx-kbd-group--${tone}`, className);
  if (keys === undefined) {
    return (
      <kbd className={cx('bx-kbd', `bx-kbd--${size}`, tone !== 'default' && `bx-kbd--${tone}`, className)} {...rest}>
        {children}
      </kbd>
    );
  }
  const combos = splitHotkeyList(keys);
  return (
    <kbd className={cls} {...rest}>
      {combos.map((combo, ci) => (
        <Fragment key={ci}>
          {ci > 0 ? <span className="bx-kbd-or">or</span> : null}
          {partsOf(combo).map((p, i) => (
            <Fragment key={i}>
              {i > 0 ? <span className="bx-kbd-plus">+</span> : null}
              <kbd className="bx-kbd">{p}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </kbd>
  );
}

import { Fragment } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { hotkeyParts, splitHotkeyList } from './lib/hotkeys.ts';
import { cx } from './lib/cx.ts';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Hotkey string rendered as chips: 'Ctrl+A' → [Ctrl]+[A]; lists 'Ctrl+G, Ctrl+K' join with "or". */
  keys?: string;
  /** Free content for a single chip when `keys` is not used. */
  children?: ReactNode;
  size?: 'sm' | 'md';
  /** 'inverse' for use on dark/solid backgrounds (e.g. inside a primary button). */
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

/** Keyboard key chips. */
export function Kbd({ keys, children, size = 'md', tone = 'default', className, ...rest }: KbdProps) {
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

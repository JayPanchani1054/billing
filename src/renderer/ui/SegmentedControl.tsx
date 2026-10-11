import { useRef } from 'react';
import type { ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { useRovingFocus } from './hooks/useRovingFocus.ts';
import { cx } from './lib/cx.ts';
import type { ControlSize } from './types.ts';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
  /** Accessible name when the label is icon-only. */
  'aria-label'?: string;
}

export interface SegmentedControlProps<V extends string> {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  'aria-label': string;
  size?: ControlSize;
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Exclusive choice among 2–5 options (Detailed/Condensed, Dr/Cr, Monthly/Quarterly). radiogroup
 * semantics: one Tab stop, ←/→ move and select. 2.1: drawn as text tabs (no pill, no track) —
 * the selected option in 600 with a 2 px brand underline.
 */
export function SegmentedControl<V extends string>({ options, value, onChange, size = 'md', fullWidth = false, disabled = false, className, ref, ...aria }: SegmentedControlProps<V>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const merged = useMergedRefs(rootRef, ref);
  const roving = useRovingFocus(rootRef, {
    orientation: 'horizontal',
    loop: true,
    manageTabIndex: false,
    onNavigate: (el) => {
      const v = el.getAttribute('data-value');
      const opt = options.find((o) => o.value === v);
      if (opt && !opt.disabled) onChange(opt.value);
    },
  });
  return (
    <div
      ref={merged}
      role="radiogroup"
      aria-label={aria['aria-label']}
      aria-disabled={disabled || undefined}
      className={cx('bx-segmented', `bx-segmented--${size}`, fullWidth && 'bx-segmented--block', className)}
      onKeyDown={roving.onKeyDown}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o['aria-label']}
            data-value={o.value}
            data-roving-item=""
            tabIndex={selected ? 0 : -1}
            disabled={disabled || o.disabled}
            className={cx('bx-segmented__item', selected && 'is-selected')}
            onClick={() => onChange(o.value)}
          >
            {o.icon ? <Icon name={o.icon} size="sm" /> : null}
            {o.label !== undefined && o.label !== null && o.label !== '' ? <span>{o.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

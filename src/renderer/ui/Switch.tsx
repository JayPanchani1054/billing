import { useId } from 'react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { useFieldControl } from './fieldContext.ts';
import { cx } from './lib/cx.ts';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value' | 'type'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (to the right). When used inside <Field>, the Field label names it. */
  label?: ReactNode;
  /** Show "Yes"/"No" text next to the track (Tally style; default true — never colour alone). */
  showState?: boolean;
  onText?: string;
  offText?: string;
  size?: 'sm' | 'md';
  ref?: Ref<HTMLButtonElement>;
}

/**
 * On/off switch (role="switch"). Space/click toggles; Y/N set Yes/No (Tally); inside an
 * Enter-advance form Enter moves to the next field.
 */
export function Switch({
  checked,
  onChange,
  label,
  showState = true,
  onText = 'Yes',
  offText = 'No',
  size = 'md',
  className,
  onKeyDown,
  ref,
  ...rest
}: SwitchProps) {
  const labelId = useId();
  const field = useFieldControl({ id: rest.id, 'aria-describedby': rest['aria-describedby'], disabled: rest.disabled });
  return (
    <span className={cx('bx-switch-wrap', field.disabled && 'is-disabled', className)}>
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        className={cx('bx-switch', `bx-switch--${size}`, checked && 'is-on')}
        aria-labelledby={label ? labelId : rest['aria-labelledby']}
        {...rest}
        id={field.id}
        disabled={field.disabled}
        aria-describedby={field['aria-describedby']}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
          const k = e.key.toLowerCase();
          if (k === 'y' || k === 'n') {
            e.preventDefault();
            onChange(k === 'y');
          }
          // Enter: inside an Enter-advance scope the scope moves focus (and cancels the native
          // toggle); elsewhere Enter toggles like any button.
        }}
      >
        <span className="bx-switch__thumb" aria-hidden="true" />
      </button>
      {showState ? (
        <span className="bx-switch__state" aria-hidden="true">
          {checked ? onText : offText}
        </span>
      ) : null}
      {label ? (
        <span id={labelId} className="bx-switch__label">
          {label}
        </span>
      ) : null}
    </span>
  );
}

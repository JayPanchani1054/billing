import { useId, useLayoutEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import { useFieldControl } from './fieldContext.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { cx } from './lib/cx.ts';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'size'> {
  label?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
  /** Mixed state (aria-checked="mixed"). */
  indeterminate?: boolean;
  invalid?: boolean;
  onChange?: (checked: boolean) => void;
  ref?: Ref<HTMLInputElement>;
}

/** Native checkbox, custom-drawn. Space toggles; in Enter-advance forms Enter moves on. */
export function Checkbox({ label, description, indeterminate = false, invalid, onChange, className, ref, ...rest }: CheckboxProps) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const merged = useMergedRefs(innerRef, ref);
  const autoId = useId();
  const field = useFieldControl({ id: rest.id, 'aria-describedby': rest['aria-describedby'], invalid, disabled: rest.disabled, required: rest.required });
  const id = field.id ?? autoId;
  const descId = `${autoId}-desc`;
  useLayoutEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className={cx('bx-check', field.disabled && 'is-disabled', field.invalid && 'is-invalid', className)} htmlFor={id}>
      <span className="bx-check__box">
        <input
          ref={merged}
          type="checkbox"
          className="bx-check__input"
          {...rest}
          id={id}
          disabled={field.disabled}
          required={field.required}
          aria-invalid={field['aria-invalid']}
          aria-describedby={[field['aria-describedby'], description ? descId : null].filter(Boolean).join(' ') || undefined}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <span className="bx-check__mark" aria-hidden="true">
          <Icon name={indeterminate ? 'minus' : 'check'} size={12} strokeWidth={2.5} />
        </span>
      </span>
      {label || description ? (
        <span className="bx-check__text">
          {label ? <span className="bx-check__label">{label}</span> : null}
          {description ? (
            <span className="bx-check__description" id={descId}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}

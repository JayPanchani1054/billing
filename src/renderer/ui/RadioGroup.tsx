import { useId } from 'react';
import type { ReactNode, Ref } from 'react';
import { cx } from './lib/cx.ts';

export interface RadioOption<V extends string> {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
  /** Group label (legend). */
  label: ReactNode;
  hideLabel?: boolean;
  options: readonly RadioOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  name?: string;
  orientation?: 'vertical' | 'horizontal';
  disabled?: boolean;
  required?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  className?: string;
  ref?: Ref<HTMLFieldSetElement>;
}

/** Native radio group in a fieldset — arrow keys move & select (browser behaviour). */
export function RadioGroup<V extends string>({
  label,
  hideLabel = false,
  options,
  value,
  onChange,
  name,
  orientation = 'vertical',
  disabled = false,
  required = false,
  error,
  hint,
  className,
  ref,
}: RadioGroupProps<V>) {
  const autoId = useId();
  const groupName = name ?? `${autoId}-radio`;
  const msgId = `${autoId}-msg`;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const hasMsg = hasError || (hint !== undefined && hint !== null && hint !== '');
  return (
    <fieldset
      ref={ref}
      className={cx('bx-radio-group', `bx-radio-group--${orientation}`, hasError && 'is-invalid', className)}
      disabled={disabled}
      aria-describedby={hasMsg ? msgId : undefined}
      aria-invalid={hasError || undefined}
      aria-required={required || undefined}
    >
      <legend className={cx('bx-radio-group__legend', hideLabel && 'bx-sr-only')}>
        {label}
        {required ? (
          <span className="bx-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </legend>
      <div className="bx-radio-group__options">
        {options.map((o) => {
          const id = `${autoId}-${o.value}`;
          return (
            <label key={o.value} className={cx('bx-radio', o.disabled && 'is-disabled')} htmlFor={id}>
              <input
                id={id}
                type="radio"
                className="bx-radio__input"
                name={groupName}
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                required={required}
                onChange={() => onChange(o.value)}
              />
              <span className="bx-radio__mark" aria-hidden="true" />
              <span className="bx-check__text">
                <span className="bx-check__label">{o.label}</span>
                {o.description ? <span className="bx-check__description">{o.description}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      {hasMsg ? (
        <p id={msgId} className={cx('bx-field__message', hasError && 'bx-field__message--error')}>
          {hasError ? error : hint}
        </p>
      ) : null}
    </fieldset>
  );
}

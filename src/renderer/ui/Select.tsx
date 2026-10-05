import type { ReactNode, Ref, SelectHTMLAttributes } from 'react';
import { Icon } from './Icon.tsx';
import { useFieldControl } from './fieldContext.ts';
import { cx } from './lib/cx.ts';
import type { ControlSize } from './types.ts';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup<V extends string = string> {
  label: string;
  options: readonly SelectOption<V>[];
}

export interface SelectProps<V extends string = string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'defaultValue' | 'onChange' | 'size'> {
  /** Options (or groups); alternatively pass <option> children. */
  options?: ReadonlyArray<SelectOption<V> | SelectOptionGroup<V>>;
  value?: V | '';
  onChange?: (value: V) => void;
  /** Disabled first option shown while nothing is selected. */
  placeholder?: string;
  size?: ControlSize;
  invalid?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLSelectElement>;
}

function isGroup<V extends string>(o: SelectOption<V> | SelectOptionGroup<V>): o is SelectOptionGroup<V> {
  return 'options' in o;
}

/**
 * Native <select> styled like the kit — best for short fixed lists (≤ ~12 options: state, voucher
 * class, rounding method). Use Combobox for masters.
 */
export function Select<V extends string = string>({ options, value, onChange, placeholder, size = 'md', invalid, className, children, ref, ...rest }: SelectProps<V>) {
  const field = useFieldControl({
    id: rest.id,
    'aria-describedby': rest['aria-describedby'],
    'aria-invalid': rest['aria-invalid'],
    invalid,
    required: rest.required,
    disabled: rest.disabled,
  });
  return (
    <div className={cx('bx-select', `bx-select--${size}`, field.invalid && 'is-invalid', field.disabled && 'is-disabled', className)}>
      <select
        ref={ref}
        className="bx-select__field"
        {...rest}
        id={field.id}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        required={field.required}
        disabled={field.disabled}
        value={value}
        onChange={(e) => onChange?.(e.target.value as V)}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options?.map((o) =>
          isGroup(o) ? (
            <optgroup key={o.label} label={o.label}>
              {o.options.map((oo) => (
                <option key={oo.value} value={oo.value} disabled={oo.disabled}>
                  {oo.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ),
        )}
        {children}
      </select>
      <Icon name="chevron-down" size="sm" className="bx-select__chevron" />
    </div>
  );
}

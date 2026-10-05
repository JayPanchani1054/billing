import { useRef } from 'react';
import type { ChangeEvent, FocusEvent as ReactFocusEvent, InputHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { useFieldControl } from './fieldContext.ts';
import { cx } from './lib/cx.ts';
import type { ControlSize } from './types.ts';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ControlSize;
  /** Error styling + aria-invalid (also inherited from <Field error>). */
  invalid?: boolean;
  /** Decorative icon at the start. */
  leadingIcon?: IconName;
  /** Static text/elements before the value (e.g. '₹'). */
  prefix?: ReactNode;
  /** Static text/elements after the value (e.g. unit, weekday). */
  suffix?: ReactNode;
  /** Interactive trailing slot (icon buttons) — not part of Enter navigation. */
  trailing?: ReactNode;
  /** Text alignment of the value (numbers: 'right'). */
  align?: 'left' | 'right' | 'center';
  /** Monospace value (codes like GSTIN/PAN/HSN). */
  mono?: boolean;
  /** Uppercase as you type (GSTIN/PAN). */
  uppercase?: boolean;
  /** Select all text when focused (Tally overwrite behaviour). */
  selectOnFocus?: boolean;
  /** Convenience: receive the string value. */
  onValueChange?: (value: string) => void;
  /** Class for the outer wrapper (the bordered box). */
  wrapperClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

/** Hook-free helper so wrappers keep select-all-on-focus even when clicked with the mouse. */
export function useSelectOnFocus(enabled: boolean) {
  const justFocused = useRef(false);
  return {
    onFocus: (e: ReactFocusEvent<HTMLInputElement>) => {
      if (!enabled) return;
      justFocused.current = true;
      e.currentTarget.select();
    },
    onMouseUp: (e: ReactMouseEvent<HTMLInputElement>) => {
      if (justFocused.current) {
        justFocused.current = false;
        // Keep the selection made on focus instead of placing the caret.
        if (e.currentTarget.selectionStart !== e.currentTarget.selectionEnd) e.preventDefault();
      }
    },
    onBlur: () => {
      justFocused.current = false;
    },
  };
}

/** Single-line text input with optional prefix/suffix/icon/trailing slots. */
export function TextInput({
  size = 'md',
  invalid,
  leadingIcon,
  prefix,
  suffix,
  trailing,
  align = 'left',
  mono = false,
  uppercase = false,
  selectOnFocus = false,
  onValueChange,
  wrapperClassName,
  className,
  type = 'text',
  onChange,
  onFocus,
  onBlur,
  onMouseUp,
  ref,
  ...rest
}: TextInputProps) {
  const field = useFieldControl({
    id: rest.id,
    'aria-describedby': rest['aria-describedby'],
    'aria-invalid': rest['aria-invalid'],
    invalid,
    required: rest.required,
    disabled: rest.disabled,
  });
  const sel = useSelectOnFocus(selectOnFocus);
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (uppercase) {
      const el = e.target;
      const upper = el.value.toUpperCase();
      if (upper !== el.value) {
        const { selectionStart, selectionEnd } = el;
        el.value = upper;
        el.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    onChange?.(e);
    onValueChange?.(e.target.value);
  };
  return (
    <div
      className={cx(
        'bx-input',
        `bx-input--${size}`,
        field.invalid && 'is-invalid',
        field.disabled && 'is-disabled',
        rest.readOnly && 'is-readonly',
        wrapperClassName,
      )}
    >
      {leadingIcon ? <Icon name={leadingIcon} size={size === 'sm' ? 'sm' : 'md'} className="bx-input__icon" /> : null}
      {prefix !== undefined && prefix !== null ? <span className="bx-input__affix bx-input__prefix">{prefix}</span> : null}
      <input
        ref={ref}
        type={type}
        className={cx('bx-input__field', `bx-input__field--${align}`, mono && 'bx-input__field--mono', uppercase && 'bx-input__field--upper', className)}
        {...rest}
        id={field.id}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        required={field.required}
        disabled={field.disabled}
        onChange={handleChange}
        onFocus={(e) => {
          sel.onFocus(e);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          sel.onBlur();
          onBlur?.(e);
        }}
        onMouseUp={(e) => {
          sel.onMouseUp(e);
          onMouseUp?.(e);
        }}
      />
      {suffix !== undefined && suffix !== null ? <span className="bx-input__affix bx-input__suffix">{suffix}</span> : null}
      {trailing ? (
        <span className="bx-input__trailing" data-enter-skip="">
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

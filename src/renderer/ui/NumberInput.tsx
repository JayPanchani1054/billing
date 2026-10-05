import { useEffect, useId } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { TextInput } from './TextInput.tsx';
import type { TextInputProps } from './TextInput.tsx';
import { useDraftField } from './hooks/useDraftField.ts';
import { clampNumber, formatNumberText, parseNumberText } from './lib/numeric.ts';
import { roundTo } from '../../shared/money.ts';

export interface NumberInputProps extends Omit<TextInputProps, 'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max' | 'step' | 'align'> {
  value: number | null;
  onChange: (value: number | null) => void;
  /** Decimal places kept and displayed (default 0). */
  decimals?: number;
  min?: number;
  max?: number;
  /** ArrowUp/ArrowDown step (Shift = ×10). Omit to disable stepping. */
  step?: number;
  /** Indian digit grouping in the display (default true). */
  grouping?: boolean;
  /** Allow arithmetic like `12*4` (default true). */
  expressions?: boolean;
  /** Show empty instead of 0. */
  blankZero?: boolean;
  /** Called after a successful commit (blur / Enter) with the final value. */
  onCommit?: (value: number | null) => void;
  /** Called when the commit-time validation message changes. */
  onValidationChange?: (error: string | null) => void;
  align?: 'left' | 'right';
}

/**
 * Decimal input: right-aligned tabular digits, select-all on focus, Indian grouping on blur,
 * parse via shared parseDecimal (or a safe arithmetic expression), live onChange while valid.
 */
export function NumberInput({
  value,
  onChange,
  decimals = 0,
  min,
  max,
  step,
  grouping = true,
  expressions = true,
  blankZero = false,
  onCommit,
  onValidationChange,
  align = 'right',
  onKeyDown,
  suffix,
  ...rest
}: NumberInputProps) {
  const errId = useId();
  const draft = useDraftField<number | null>({
    value,
    format: (v) => (v === null || (blankZero && v === 0) ? '' : formatNumberText(v, decimals, grouping)),
    parse: (t) => {
      const r = parseNumberText(t, { decimals, expressions });
      return r.ok ? { ok: true, value: r.value } : r;
    },
    onChange,
    normalize: (v) => (v === null ? null : roundTo(clampNumber(v, min, max), decimals)),
    onCommit,
  });

  useEffect(() => {
    onValidationChange?.(draft.error);
    // report changes of the message only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.error]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (step && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      const base = value ?? 0;
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      const next = roundTo(clampNumber(base + delta, min, max), decimals);
      onChange(next);
      draft.setText(formatNumberText(next, decimals, grouping));
    } else if (e.key === 'Enter') {
      draft.commit();
    }
  };

  return (
    <NumericShell
      {...rest}
      inputMode="decimal"
      align={align}
      value={draft.text}
      onChange={draft.onChange}
      onFocus={(e) => {
        draft.onFocus(e);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        draft.onBlur(e);
        rest.onBlur?.(e);
      }}
      onKeyDown={handleKeyDown}
      error={draft.error}
      errId={errId}
      suffix={suffix}
    />
  );
}

export interface NumericShellProps extends TextInputProps {
  error: string | null;
  errId: string;
  suffix?: ReactNode;
}

/** TextInput configured for numbers + an accessible commit-error marker. Internal building block. */
export function NumericShell({ error, errId, suffix, invalid, className, ...rest }: NumericShellProps) {
  return (
    <TextInput
      autoComplete="off"
      spellCheck={false}
      selectOnFocus
      {...rest}
      className={className ? `bx-num ${className}` : 'bx-num'}
      invalid={invalid || !!error}
      aria-describedby={[rest['aria-describedby'], error ? errId : null].filter(Boolean).join(' ') || undefined}
      title={error ?? rest.title}
      suffix={
        error ? (
          <>
            {suffix}
            <Icon name="alert" size="sm" className="bx-input__error-icon" />
            <span id={errId} className="bx-sr-only">
              {error}
            </span>
          </>
        ) : (
          suffix
        )
      }
    />
  );
}

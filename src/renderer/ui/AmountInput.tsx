import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NumericShell } from './NumberInput.tsx';
import type { TextInputProps } from './TextInput.tsx';
import { useDraftField } from './hooks/useDraftField.ts';
import { applySide, formatAmountText, parseAmountText, sideOf } from './lib/numeric.ts';
import type { DrCrSide } from './lib/numeric.ts';
import type { Paise } from '../../shared/money.ts';

export type { DrCrSide } from './lib/numeric.ts';

export interface AmountInputProps extends Omit<TextInputProps, 'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max' | 'align'> {
  /** Integer paise (signed when `drcr`: Dr positive, Cr negative). */
  value: Paise | null;
  onChange: (value: Paise | null) => void;
  /** Show a Dr/Cr toggle; typing `d` / `c` switches side. The emitted value carries the sign. */
  drcr?: boolean;
  /** Side used while the amount is zero/empty (default 'dr'). */
  defaultSide?: DrCrSide;
  /** Notified when the side changes (also while the amount is zero). */
  onSideChange?: (side: DrCrSide) => void;
  /** Allow negative amounts (non-Dr/Cr mode). Default false. */
  allowNegative?: boolean;
  /** Show '' for zero (report-style). */
  blankZero?: boolean;
  /** Show a ₹ prefix. */
  symbol?: boolean;
  min?: Paise;
  max?: Paise;
  onCommit?: (value: Paise | null) => void;
  onValidationChange?: (error: string | null) => void;
}

/**
 * Money entry in integer paise. Accepts `1,23,456.78`, `₹ 50`, `500 Cr`, and safe arithmetic
 * (`1200*3`, `1000+18%`); shows Indian grouping on blur; right-aligned tabular digits; select-all
 * on focus. With `drcr`, a Dr/Cr chip shows the side and `d`/`c` keys switch it.
 */
export function AmountInput({
  value,
  onChange,
  drcr = false,
  defaultSide = 'dr',
  onSideChange,
  allowNegative = false,
  blankZero = false,
  symbol = false,
  min,
  max,
  onCommit,
  onValidationChange,
  onKeyDown,
  trailing,
  ...rest
}: AmountInputProps) {
  const errId = useId();
  const hintId = useId();
  const [side, setSideState] = useState<DrCrSide>(() => sideOf(value, defaultSide));

  // Follow external sign changes.
  useEffect(() => {
    if (drcr && value !== null && value !== 0) setSideState(value < 0 ? 'cr' : 'dr');
  }, [drcr, value]);

  const setSide = (s: DrCrSide) => {
    setSideState(s);
    onSideChange?.(s);
    if (value !== null && value !== 0) {
      const next = applySide(value, s);
      if (next !== value) onChange(next);
    }
  };

  const draft = useDraftField<Paise | null>({
    value,
    format: (v) => formatAmountText(v, { blankZero, absolute: drcr }),
    parse: (t) => {
      const r = parseAmountText(t);
      if (!r.ok) return r;
      if (r.paise === null) return { ok: true, value: null };
      if (drcr) {
        let s = r.side ?? side;
        if (r.paise < 0) s = s === 'dr' ? 'cr' : 'dr';
        return { ok: true, value: applySide(Math.abs(r.paise), s) };
      }
      const signed = r.side === 'cr' ? -Math.abs(r.paise) : r.paise;
      if (signed < 0 && !allowNegative) return { ok: false, error: 'Amount cannot be negative' };
      return { ok: true, value: signed };
    },
    onChange: (v) => {
      if (drcr && v !== null && v !== 0) {
        const s = v < 0 ? 'cr' : 'dr';
        if (s !== side) {
          setSideState(s);
          onSideChange?.(s);
        }
      }
      onChange(v);
    },
    validate: (v) => {
      if (v === null) return null;
      const magnitude = drcr ? Math.abs(v) : v;
      if (min !== undefined && magnitude < min) return `Amount must be at least ${formatAmountText(min)}`;
      if (max !== undefined && magnitude > max) return `Amount must not exceed ${formatAmountText(max)}`;
      return null;
    },
    onCommit,
  });

  useEffect(() => {
    onValidationChange?.(draft.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.error]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (drcr && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'd' || k === 'c') {
        e.preventDefault();
        setSide(k === 'd' ? 'dr' : 'cr');
        return;
      }
    }
    if (e.key === 'Enter') draft.commit();
  };

  const toggle = drcr ? (
    <button
      type="button"
      className="bx-drcr-toggle"
      data-side={side}
      tabIndex={-1}
      aria-label={side === 'dr' ? 'Debit (click to switch to Credit)' : 'Credit (click to switch to Debit)'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setSide(side === 'dr' ? 'cr' : 'dr')}
      disabled={rest.disabled || rest.readOnly}
    >
      {side === 'dr' ? 'Dr' : 'Cr'}
    </button>
  ) : null;

  return (
    <>
      <NumericShell
        {...rest}
        inputMode="decimal"
        align="right"
        prefix={symbol ? '₹' : rest.prefix}
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
        aria-describedby={[rest['aria-describedby'], drcr ? hintId : null].filter(Boolean).join(' ') || undefined}
        trailing={
          toggle || trailing ? (
            <>
              {toggle}
              {trailing}
            </>
          ) : undefined
        }
      />
      {drcr ? (
        <span id={hintId} className="bx-sr-only">
          {`${side === 'dr' ? 'Debit' : 'Credit'}. Type D for debit or C for credit.`}
        </span>
      ) : null}
    </>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Calendar } from './Calendar.tsx';
import { IconButton } from './IconButton.tsx';
import { NumericShell } from './NumberInput.tsx';
import { Popover } from './Popover.tsx';
import type { TextInputProps } from './TextInput.tsx';
import { useDraftField } from './hooks/useDraftField.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { isOutOfRange, weekdayName } from './lib/calendar.ts';
import { formatDate, isValidDate, parseDateInput, todayLocal } from '../../shared/dates.ts';
import type { DateStyle } from '../../shared/dates.ts';

export interface DateInputProps extends Omit<TextInputProps, 'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max'> {
  /** ISO 'YYYY-MM-DD' or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Shorthand like '5' or '5-10' resolves against this (the company working date). Default: system date. */
  referenceDate?: string;
  minDate?: string;
  maxDate?: string;
  /** Display style (default 'DD-MMM-YYYY' → 05-Oct-2026). */
  format?: DateStyle;
  /** Show the weekday after the date (default true). */
  showWeekday?: boolean;
  /** 0 = Sunday (default). */
  weekStartsOn?: number;
  /** Show the calendar button (default true). Alt+↓ opens the calendar regardless. */
  calendarButton?: boolean;
  onCommit?: (value: string | null) => void;
  onValidationChange?: (error: string | null) => void;
}

/**
 * Tally-style date entry: type `5`, `5-10`, `5/10/26`, `05102026`, `5 oct`, `t` (today) or `y`
 * (yesterday) — resolved against `referenceDate` on blur/Enter. Shows the formatted date and
 * weekday; Alt+↓ (or the button) opens a calendar.
 */
export function DateInput({
  value,
  onChange,
  referenceDate,
  minDate,
  maxDate,
  format = 'DD-MMM-YYYY',
  showWeekday = true,
  weekStartsOn = 0,
  calendarButton = true,
  onCommit,
  onValidationChange,
  onKeyDown,
  ref,
  placeholder = 'DD-MM-YYYY',
  ...rest
}: DateInputProps) {
  const errId = useId();
  const popId = useId();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const mergedRef = useMergedRefs(inputRef, ref);
  const reference = referenceDate && isValidDate(referenceDate) ? referenceDate : todayLocal();

  const draft = useDraftField<string | null>({
    value,
    format: (v) => (v ? formatDate(v, format) : ''),
    parse: (t) => {
      const s = t.trim();
      if (s === '') return { ok: true, value: null };
      const iso = parseDateInput(s, reference);
      // Display formats like '05-Oct-2026' round-trip through parseDateInput too.
      return iso ? { ok: true, value: iso } : { ok: false, error: 'Not a valid date — try 5, 5-10 or 05-10-2026' };
    },
    onChange: () => {
      /* dates are emitted on commit only — partial input like '1' would otherwise jump around */
    },
    validate: (v) => {
      if (!v) return rest.required ? 'Enter a date' : null;
      if (minDate && v < minDate) return `Date must be on or after ${formatDate(minDate, format)}`;
      if (maxDate && v > maxDate) return `Date must be on or before ${formatDate(maxDate, format)}`;
      return null;
    },
    onCommit: (v) => {
      if (v !== value) onChange(v);
      onCommit?.(v);
    },
    equals: () => true, // emission happens in onCommit
  });

  useEffect(() => {
    onValidationChange?.(draft.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.error]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === 'Enter') {
      draft.commit();
    } else if (!e.altKey && !e.ctrlKey && (e.key === '+' || e.key === '-') && value && draft.text === formatDate(value, format)) {
      // +/- step the date by a day when the field shows a committed date (quick entry).
      e.preventDefault();
      const d = new Date(`${value}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + (e.key === '+' ? 1 : -1));
      const next = d.toISOString().slice(0, 10);
      if (!isOutOfRange(next, minDate, maxDate)) {
        onChange(next);
        draft.setText(formatDate(next, format));
      }
    }
  };

  const weekday = showWeekday && value && !draft.error ? weekdayName(value, 'short') : '';

  return (
    <div ref={anchorRef} className="bx-date-input">
      <NumericShell
        {...rest}
        ref={mergedRef}
        align="left"
        className="bx-date-input__field"
        placeholder={placeholder}
        value={draft.text}
        onChange={draft.onChange}
        onFocus={(e) => {
          draft.onFocus(e);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          if (!open) draft.onBlur(e);
          rest.onBlur?.(e);
        }}
        onKeyDown={handleKeyDown}
        error={draft.error}
        errId={errId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        suffix={weekday ? <span className="bx-date-input__weekday">{weekday}</span> : undefined}
        trailing={
          calendarButton ? (
            <IconButton
              icon="calendar"
              aria-label="Open calendar (Alt+Down)"
              size="sm"
              tooltip={false}
              tabIndex={-1}
              disabled={rest.disabled || rest.readOnly}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpen((o) => !o)}
            />
          ) : undefined
        }
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        placement="bottom-start"
        id={popId}
        aria-label="Choose date"
        initialFocus="none"
        flush
      >
        <Calendar
          value={value}
          referenceDate={reference}
          minDate={minDate}
          maxDate={maxDate}
          weekStartsOn={weekStartsOn}
          autoFocus
          onCancel={() => {
            setOpen(false);
            inputRef.current?.focus({ preventScroll: true });
          }}
          onSelect={(iso) => {
            setOpen(false);
            onChange(iso);
            draft.setText(formatDate(iso, format));
            onCommit?.(iso);
            inputRef.current?.focus({ preventScroll: true });
          }}
        />
      </Popover>
    </div>
  );
}

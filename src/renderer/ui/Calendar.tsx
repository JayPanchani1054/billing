import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from 'react';
import { IconButton } from './IconButton.tsx';
import { MONTH_LONG, isOutOfRange, monthMatrix, moveDate, weekdayHeaders, weekdayIndex, WEEKDAY_LONG } from './lib/calendar.ts';
import { cx } from './lib/cx.ts';
import { addMonths, isValidDate, parts, todayLocal } from '../../shared/dates.ts';

export interface CalendarProps {
  /** Selected ISO date. */
  value: string | null;
  onSelect: (iso: string) => void;
  /** Working date: initial focus when there is no value, marked as "today". Default: system date. */
  referenceDate?: string;
  minDate?: string;
  maxDate?: string;
  /** 0 = Sunday (default), 1 = Monday. */
  weekStartsOn?: number;
  /** Focus the active day on mount. */
  autoFocus?: boolean;
  /** Esc pressed inside the grid. */
  onCancel?: () => void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function longLabel(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${WEEKDAY_LONG[weekdayIndex(iso)]}, ${d} ${MONTH_LONG[m - 1]} ${y}`;
}

/**
 * Month grid date picker (WAI-ARIA grid): arrows ±day/week, PageUp/PageDown ±month (Shift ±year),
 * Home/End week start/end, Enter/Space select, T jumps to the working date.
 */
export function Calendar({ value, onSelect, referenceDate, minDate, maxDate, weekStartsOn = 0, autoFocus = false, onCancel, className, ref }: CalendarProps) {
  const today = referenceDate && isValidDate(referenceDate) ? referenceDate : todayLocal();
  const [focusDate, setFocusDate] = useState<string>(() => (value && isValidDate(value) ? value : today));
  const gridRef = useRef<HTMLDivElement | null>(null);
  const shouldFocus = useRef(autoFocus);
  const titleId = useId();
  const { y, m } = parts(focusDate);
  const matrix = useMemo(() => monthMatrix(y, m, weekStartsOn), [y, m, weekStartsOn]);
  const headers = useMemo(() => weekdayHeaders(weekStartsOn), [weekStartsOn]);
  const headersLong = useMemo(() => weekdayHeaders(weekStartsOn, 'long'), [weekStartsOn]);

  useLayoutEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus({ preventScroll: true });
  });

  const moveTo = (iso: string) => {
    shouldFocus.current = true;
    setFocusDate(iso);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key.toLowerCase() === 't' && !e.shiftKey) {
      e.preventDefault();
      moveTo(today);
      return;
    }
    const next = moveDate(focusDate, e.key, e.shiftKey, weekStartsOn);
    if (next) {
      e.preventDefault();
      moveTo(next);
    }
  };

  const select = (iso: string) => {
    if (isOutOfRange(iso, minDate, maxDate)) return;
    onSelect(iso);
  };

  return (
    <div ref={ref} className={cx('bx-calendar', className)}>
      <div className="bx-calendar__header">
        <IconButton icon="chevron-left" aria-label="Previous month" size="sm" tooltip={false} onClick={() => setFocusDate(addMonths(focusDate, -1))} />
        <div id={titleId} className="bx-calendar__title" aria-live="polite">
          {MONTH_LONG[m - 1]} {y}
        </div>
        <IconButton icon="chevron-right" aria-label="Next month" size="sm" tooltip={false} onClick={() => setFocusDate(addMonths(focusDate, 1))} />
      </div>
      <div ref={gridRef} role="grid" aria-labelledby={titleId} className="bx-calendar__grid" onKeyDown={onKeyDown}>
        <div role="row" className="bx-calendar__row bx-calendar__row--head">
          {headers.map((h, i) => (
            <div key={h} role="columnheader" aria-label={headersLong[i]} className="bx-calendar__weekday">
              {h.slice(0, 2)}
            </div>
          ))}
        </div>
        {matrix.map((week) => (
          <div role="row" key={week[0]} className="bx-calendar__row">
            {week.map((iso) => {
              const outside = parts(iso).m !== m;
              const disabled = isOutOfRange(iso, minDate, maxDate);
              const selected = iso === value;
              const isToday = iso === today;
              const focused = iso === focusDate;
              return (
                <div role="gridcell" key={iso} aria-selected={selected} className="bx-calendar__cell">
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={focused ? 0 : -1}
                    aria-label={longLabel(iso)}
                    aria-current={isToday ? 'date' : undefined}
                    aria-disabled={disabled || undefined}
                    className={cx(
                      'bx-calendar__day',
                      outside && 'is-outside',
                      selected && 'is-selected',
                      isToday && 'is-today',
                      disabled && 'is-disabled',
                    )}
                    onClick={() => select(iso)}
                    onFocus={() => {
                      if (iso !== focusDate) setFocusDate(iso);
                    }}
                  >
                    {parts(iso).d}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="bx-calendar__footer">
        <button type="button" className="bx-calendar__today" onClick={() => select(today)} disabled={isOutOfRange(today, minDate, maxDate)}>
          {referenceDate ? 'Working date' : 'Today'}
        </button>
      </div>
    </div>
  );
}

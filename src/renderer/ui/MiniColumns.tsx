/**
 * Home's "Sales — last 12 months" (SPEC-21 §1.3, D10): ≤ 12 thin columns, emphasis form — the
 * column at `emphasis` in slot 1 with its direct `label` ("₹35.8 K so far"), the others context
 * grey; first and last month ticks. Plain HTML + CSS (no SVG, no measuring), so it stays tiny: the
 * only graph code in the start-up bundle (≤ 1.5 KB minified). One Tab stop: `role="listbox"`,
 * ←/→ Home/End move, Enter or a click = `onActivate(i)`; each column is an option named
 * "Sep: ₹ 87,414.00" (also its tooltip). The emphasised column is the last one (the running
 * month), so its label is anchored at the right edge.
 */
import { useId, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { graphKeyStep } from './lib/chart.ts';
import { cx } from './lib/cx.ts';
import { formatMoney } from '../../shared/format.ts';

export interface MiniColumnsProps {
  /** Accessible name ("Sales — last 12 months"). */
  title: string;
  /** Month names, oldest first ('Nov' … 'Oct'; ≤ 12, so a name never repeats) — ticks and option names. */
  months: readonly string[];
  /** Paise, one per month. */
  values: readonly number[];
  /** Index of the emphasised (current) month, or null. */
  emphasis: number | null;
  /** Direct label of the emphasised column ("₹35.8 K so far"). */
  label: string;
  onActivate?: (index: number) => void;
}

export function MiniColumns({ title, months, values, emphasis, label, onActivate }: MiniColumnsProps): ReactNode {
  const id = useId();
  const [cur, setCur] = useState(-1);
  const n = months.length;
  const lo = Math.min(0, ...values);
  const pct = (v: number) => `${(v / (Math.max(0, ...values) - lo || 1)) * 100}%`;
  // The graph keys of ui/Chart.tsx; with a modifier, or Enter with nothing highlighted, a key keeps its global meaning.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const to = graphKeyStep(e.key, cur, n);
    if (to !== null) setCur(to);
    else if (e.key === 'Enter' && cur >= 0 && onActivate) onActivate(cur);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="bx-mini">
      <div className="bx-mini__plot" role="listbox" aria-roledescription="graph" aria-orientation="horizontal" aria-label={title} aria-activedescendant={cur >= 0 ? id + cur : undefined} tabIndex={0} onKeyDown={onKeyDown} onBlur={() => setCur(-1)}>
        {months.map((m, i) => {
          const v = values[i] ?? 0;
          const name = `${m}: ${formatMoney(v, { symbol: true })}`;
          return (
            <div key={i} id={id + i} role="option" aria-selected={i === cur} aria-label={name} title={name} className={cx('bx-mini__slot', i === cur && 'is-active')} onClick={() => onActivate?.(i)}>
              <span className={cx('bx-mini__col', i === emphasis ? 'bx-chart--s-1' : 'bx-chart--s-other')} style={{ bottom: pct(Math.min(v, 0) - lo), height: pct(Math.abs(v)) }} />
              {i === emphasis && label ? (
                <span className="bx-chart__direct-label" style={{ position: 'absolute', whiteSpace: 'nowrap', right: 0, bottom: pct(Math.max(v, 0) - lo) }} aria-hidden="true">
                  {label}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {n ? (
        <div className="bx-mini__ticks" aria-hidden="true">
          <span className="bx-chart__tick">{months[0]}</span>
          <span className="bx-chart__tick">{n > 1 ? months[n - 1] : ''}</span>
        </div>
      ) : null}
    </div>
  );
}

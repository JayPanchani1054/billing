/**
 * The report's answer in words and exact numbers (SPEC-21 §2.3, D24): "To collect ₹99,953 ·
 * Overdue ₹4,65,953 · ₹3,66,000 not matched to bills ›". Label 12 muted + value 18/600, " · "
 * between items; at most 3 figures + 1 link item. A number value is paise and is shown exact
 * (ui/lib/statLine.ts); zero amounts are the caller's to drop (`dropZeros`). A value with
 * `onClick` is a link-style button (the drill); a `link` item reads "value label ›" as one link.
 */
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { cx } from './lib/cx.ts';
import { statMoney, statProblems, statTitle } from './lib/statLine.ts';
import type { Paise } from '../../shared/money.ts';

export { dropZeros } from './lib/statLine.ts';

export interface StatLineItem {
  label: string;
  value: Paise | ReactNode;
  onClick?: () => void;
  tone?: 'warning' | 'danger';
  /** Tooltip (e.g. what the figure counts). */
  title?: string;
  /** The one link of the line: "₹3,66,000 not matched to bills ›". */
  link?: boolean;
}

export interface StatLineProps {
  items: readonly StatLineItem[];
  className?: string;
}

export function StatLine({ items, className }: StatLineProps): ReactNode {
  if (items.length === 0) return null;
  // The rule's assert: a console error fails the e2e every-screen sweep, so CI catches a crowded stat.
  const problems = statProblems(items);
  if (problems.length) console.error(`StatLine: ${problems.join('; ')} — at most 3 figures and 1 link`);
  return (
    <p className={cx('bx-statline', className)}>
      {items.map((it, i) => {
        const value = typeof it.value === 'number' ? statMoney(it.value) : it.value;
        const tone = it.tone === 'danger' ? 'bx-statline__value--danger' : it.tone === 'warning' ? 'bx-statline__value--warning' : null;
        if (it.link) {
          return (
            <span key={i} className="bx-statline__item">
              <Button variant="link" className={tone ?? undefined} title={statTitle(it)} onClick={it.onClick} disabled={!it.onClick}>
                {value} {it.label} ›
              </Button>
            </span>
          );
        }
        return (
          <span key={i} className="bx-statline__item" title={statTitle(it)}>
            <span className="bx-statline__label">{it.label}</span>
            {it.onClick ? (
              <Button variant="link" className={cx('bx-statline__value', tone)} onClick={it.onClick}>
                {value}
              </Button>
            ) : (
              <span className={cx('bx-statline__value', tone)}>{value}</span>
            )}
          </span>
        );
      })}
    </p>
  );
}

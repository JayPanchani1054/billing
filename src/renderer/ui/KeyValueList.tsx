import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './lib/cx.ts';
import { formatDrCr, formatMoney } from '../../shared/format.ts';
import { formatDate } from '../../shared/dates.ts';

export interface KeyValueItem {
  key?: string;
  label: ReactNode;
  value: ReactNode;
  /** Format a raw value: 'amount' (paise) · 'drcr' (signed paise) · 'date' (ISO). */
  kind?: 'text' | 'amount' | 'drcr' | 'date';
  /** Emphasise (totals). */
  strong?: boolean;
  /** Hide the row when the value is empty (default false → shows an en dash). */
  hideEmpty?: boolean;
}

export interface KeyValueListProps extends HTMLAttributes<HTMLDListElement> {
  items: readonly KeyValueItem[];
  /** 'inline' ("Label : value") or 'stacked' (label above value). */
  layout?: 'inline' | 'stacked';
  /** Number of columns for the pairs (default 1). */
  columns?: 1 | 2 | 3;
  /** Label column width for inline layout. */
  labelWidth?: number | string;
  /** Align values right (numbers). */
  alignValues?: 'left' | 'right';
  ref?: Ref<HTMLDListElement>;
}

function render(item: KeyValueItem): ReactNode {
  const v = item.value;
  if (typeof v === 'number' && item.kind === 'amount') return formatMoney(v);
  if (typeof v === 'number' && item.kind === 'drcr') return formatDrCr(v, { keepZero: true });
  if (typeof v === 'string' && item.kind === 'date') return formatDate(v);
  return v;
}

/** Read-only label/value pairs (voucher header, party details, company info). */
export function KeyValueList({ items, layout = 'inline', columns = 1, labelWidth, alignValues = 'left', className, style, ...rest }: KeyValueListProps) {
  const s: CSSProperties | undefined =
    labelWidth !== undefined ? ({ ...style, '--kv-label-w': typeof labelWidth === 'number' ? `${labelWidth}px` : labelWidth } as CSSProperties) : style;
  return (
    <dl className={cx('bx-kv', `bx-kv--${layout}`, `bx-kv--cols-${columns}`, alignValues === 'right' && 'bx-kv--values-right', className)} style={s} {...rest}>
      {items.map((item, i) => {
        const value = render(item);
        const isEmpty = value === null || value === undefined || value === '';
        if (isEmpty && item.hideEmpty) return null;
        const numeric = item.kind === 'amount' || item.kind === 'drcr';
        return (
          <div key={item.key ?? i} className={cx('bx-kv__row', item.strong && 'is-strong')}>
            <dt className="bx-kv__label">{item.label}</dt>
            <dd className={cx('bx-kv__value', numeric && 'bx-num')}>{isEmpty ? <span className="bx-kv__empty">–</span> : value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

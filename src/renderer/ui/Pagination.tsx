import type { Ref } from 'react';
import { IconButton } from './IconButton.tsx';
import { Select } from './Select.tsx';
import { cx } from './lib/cx.ts';
import { pageBounds, pageCountOf, paginationRange } from './lib/pagination.ts';
import { formatIndianNumber } from '../../shared/format.ts';

export interface PaginationProps {
  /** 1-based page. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Offer a page-size select with these options. */
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (size: number) => void;
  /** Noun for the summary ("vouchers"). Default "rows". */
  itemLabel?: string;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/** Pager for non-virtual lists backed by `{ rows, total }` APIs. */
export function Pagination({ page, pageSize, total, onPageChange, pageSizeOptions, onPageSizeChange, itemLabel = 'rows', className, ref }: PaginationProps) {
  const count = pageCountOf(total, pageSize);
  const current = Math.min(Math.max(1, page), count);
  const { from, to } = pageBounds(current, pageSize, total);
  const items = paginationRange(current, count);
  return (
    <nav ref={ref} aria-label="Pagination" className={cx('bx-pagination', className)}>
      <p className="bx-pagination__summary bx-num" aria-live="polite">
        {total === 0 ? `No ${itemLabel}` : `${formatIndianNumber(from, 0)}–${formatIndianNumber(to, 0)} of ${formatIndianNumber(total, 0)} ${itemLabel}`}
      </p>
      <div className="bx-pagination__controls">
        {pageSizeOptions && onPageSizeChange ? (
          <Select
            size="sm"
            aria-label="Rows per page"
            value={String(pageSize)}
            onChange={(v) => onPageSizeChange(Number(v))}
            options={pageSizeOptions.map((n) => ({ value: String(n), label: `${n} / page` }))}
            className="bx-pagination__size"
          />
        ) : null}
        <IconButton icon="chevron-left" size="sm" aria-label="Previous page" tooltip={false} disabled={current <= 1} onClick={() => onPageChange(current - 1)} />
        <ol className="bx-pagination__pages">
          {items.map((it) =>
            typeof it === 'number' ? (
              <li key={it}>
                <button
                  type="button"
                  className={cx('bx-pagination__page', it === current && 'is-current')}
                  aria-current={it === current ? 'page' : undefined}
                  aria-label={`Page ${it}`}
                  onClick={() => onPageChange(it)}
                >
                  {it}
                </button>
              </li>
            ) : (
              <li key={it} className="bx-pagination__ellipsis" aria-hidden="true">
                …
              </li>
            ),
          )}
        </ol>
        <IconButton icon="chevron-right" size="sm" aria-label="Next page" tooltip={false} disabled={current >= count} onClick={() => onPageChange(current + 1)} />
      </div>
    </nav>
  );
}

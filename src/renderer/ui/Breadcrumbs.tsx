import type { ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import { cx } from './lib/cx.ts';

export interface BreadcrumbItem {
  key: string;
  label: ReactNode;
  /** Navigate to this level (pops the nav stack). The last item is the current page and is not clickable. */
  onClick?: () => void;
}

export interface BreadcrumbsProps {
  items: readonly BreadcrumbItem[];
  /** Collapse middle items into "…" beyond this count (default 5). */
  maxItems?: number;
  'aria-label'?: string;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/** Navigation-stack trail: Gateway › Display › Trial Balance › Sundry Debtors. */
export function Breadcrumbs({ items, maxItems = 5, className, ref, ...aria }: BreadcrumbsProps) {
  let shown: Array<BreadcrumbItem | 'ellipsis'> = [...items];
  if (items.length > maxItems && maxItems >= 3) {
    shown = [items[0], 'ellipsis', ...items.slice(items.length - (maxItems - 2))];
  }
  const hidden = items.length > maxItems ? items.slice(1, items.length - (maxItems - 2)) : [];
  return (
    <nav ref={ref} aria-label={aria['aria-label'] ?? 'Breadcrumb'} className={cx('bx-breadcrumbs', className)}>
      <ol className="bx-breadcrumbs__list">
        {shown.map((it, i) => {
          const last = i === shown.length - 1;
          if (it === 'ellipsis') {
            const title = hidden.map((h) => (typeof h.label === 'string' ? h.label : '')).filter(Boolean).join(' › ');
            return (
              <li key="__ellipsis" className="bx-breadcrumbs__item">
                <span className="bx-breadcrumbs__ellipsis" title={title}>
                  …
                </span>
                <Icon name="chevron-right" size="xs" className="bx-breadcrumbs__sep" />
              </li>
            );
          }
          return (
            <li key={it.key} className="bx-breadcrumbs__item">
              {last || !it.onClick ? (
                <span className={cx('bx-breadcrumbs__current', !last && 'bx-breadcrumbs__plain')} aria-current={last ? 'page' : undefined}>
                  {it.label}
                </span>
              ) : (
                <button type="button" className="bx-breadcrumbs__link" onClick={it.onClick}>
                  {it.label}
                </button>
              )}
              {!last ? <Icon name="chevron-right" size="xs" className="bx-breadcrumbs__sep" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

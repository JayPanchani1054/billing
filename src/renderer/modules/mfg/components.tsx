/**
 * Shared pieces of the mfg screens: an editable lines table (one <tr> per line, kit controls in the
 * cells, the line's error under it), the focused-line helper for Ctrl+D / Alt+N, and the invalidation
 * list. Keyboard: Enter / Shift+Enter move field by field (useEnterAdvance of the screen); Ctrl+D
 * removes the focused line; Alt+N (or Ctrl+N) inserts a line above it.
 */
import { Fragment } from 'react';
import type { ReactNode } from 'react';

/** Modules whose screens show what the mfg screens change. */
export const MFG_INVALIDATES: readonly string[] = ['mfg', 'vouchers', 'stock', 'reports', 'inventory', 'gst', 'dashboard'];

export interface LineColumn {
  key: string;
  header: string;
  width?: number | string;
  num?: boolean;
}

export interface LineRow {
  key: string;
  cells: Readonly<Record<string, ReactNode>>;
  error?: string | null;
}

/** Key of the line that holds the keyboard focus (data-row-key on its <tr>), or null. */
export function focusedRowKey(): string | null {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  const row = el instanceof Element ? el.closest('[data-row-key]') : null;
  return row ? row.getAttribute('data-row-key') : null;
}

/** Focus the first control of a line (after inserting it). */
export function focusRow(key: string): void {
  if (typeof document === 'undefined') return;
  window.setTimeout(() => {
    const row = document.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
    const input = row?.querySelector<HTMLElement>('input, select, textarea, button');
    input?.focus();
  }, 0);
}

export function LinesTable({ caption, columns, rows, footer, empty }: { caption: string; columns: readonly LineColumn[]; rows: readonly LineRow[]; footer?: ReactNode; empty?: ReactNode }) {
  return (
    <table className="bx-mfg-lines" aria-label={caption}>
      <caption>{caption}</caption>
      <colgroup>
        <col style={{ width: 36 }} />
        {columns.map((c) => (
          <col key={c.key} style={c.width !== undefined ? { width: c.width } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th scope="col">
            <span className="bx-sr-only">Line</span>
          </th>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.num ? 'is-num' : undefined}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && empty ? (
          <tr>
            <td colSpan={columns.length + 1} className="bx-muted">
              {empty}
            </td>
          </tr>
        ) : null}
        {rows.map((r, i) => (
          <Fragment key={r.key}>
            <tr className="bx-mfg-row" data-row-key={r.key}>
              <td className="bx-mfg-lines__no">{i + 1}</td>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'is-num' : undefined}>
                  {r.cells[c.key] ?? null}
                </td>
              ))}
            </tr>
            {r.error ? (
              <tr className="bx-mfg-row__error" role="alert">
                <td />
                <td colSpan={columns.length}>{r.error}</td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </tbody>
      {footer ? (
        <tfoot>
          <tr>
            <td />
            <td colSpan={columns.length}>{footer}</td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/**
 * Shared pieces of the mfg screens: an editable lines table (one <tr> per line, kit controls in the
 * cells, the line's error under it), the focused-line helpers for Ctrl+D / Alt+N / Ctrl+E, and the invalidation
 * list. Keyboard: Enter / Shift+Enter move field by field (useEnterAdvance of the screen); Ctrl+D
 * removes the focused line; Alt+N (or Ctrl+N) inserts a line above it.
 *
 * 2.2: a table with `tools` ends with a narrow column of row tools (each row's `tool`: the journal's
 * "Description" button) — mouse-only (tabIndex -1; Ctrl+E is the key), shown on the row's hover / focus.
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
  /** 2.2: the line's row tools, in the trailing tools column of a table with `tools` (nothing on an empty line). */
  tool?: ReactNode;
}

/**
 * Key of the line an element sits on — the data-row-key of its table row, or of the journal's finished goods
 * section (a line of the voucher too) — or null (the header, the narration, outside the form).
 */
export function rowKeyOf(el: Element | null): string | null {
  const row = el ? el.closest('[data-row-key]') : null;
  return row ? row.getAttribute('data-row-key') : null;
}

/** Key of the line that holds the keyboard focus (data-row-key on its <tr>), or null. */
export function focusedRowKey(): string | null {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return rowKeyOf(el instanceof Element ? el : null);
}

/** Focus the first control of a line (after inserting it, or the first line a save error names) — never a mouse-only tool. */
export function focusRow(key: string): void {
  if (typeof document === 'undefined') return;
  window.setTimeout(() => {
    const row = document.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
    const input = row?.querySelector<HTMLElement>('input, select, textarea, button:not([tabindex="-1"])');
    input?.focus();
  }, 0);
}

/**
 * Focus an element by id once it is on screen — a description appears one render after it is opened — trying
 * again for a few frames (More ▾ gives the focus back to its button after the item ran). As voucher entry's focusId.
 */
export function focusLater(id: string, attempts = 6): void {
  if (typeof document === 'undefined') return;
  const tryFocus = (left: number) => {
    const el = document.getElementById(id);
    if (el) el.focus();
    if (el && (document.activeElement === el || left <= 0)) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (left > 0) requestAnimationFrame(() => tryFocus(left - 1));
  };
  requestAnimationFrame(() => tryFocus(attempts));
}

/**
 * `note`: a rule about the lines (2.1: no teaching sentences on screen) — the caption's tooltip, and read
 * after the caption by a screen reader (never a tooltip over every cell of the grid). `tools`: a trailing
 * column for each row's `tool` (2.2).
 */
export function LinesTable({
  caption,
  note,
  columns,
  rows,
  footer,
  empty,
  tools = false,
}: {
  caption: string;
  note?: string;
  columns: readonly LineColumn[];
  rows: readonly LineRow[];
  footer?: ReactNode;
  empty?: ReactNode;
  tools?: boolean;
}) {
  /** Columns after the line number: the table's own, then the tools column. */
  const span = columns.length + (tools ? 1 : 0);
  return (
    <table className="bx-mfg-lines" aria-label={caption}>
      <caption title={note}>
        {caption}
        {note ? <span className="bx-sr-only">. {note}</span> : null}
      </caption>
      <colgroup>
        <col style={{ width: 36 }} />
        {columns.map((c) => (
          <col key={c.key} style={c.width !== undefined ? { width: c.width } : undefined} />
        ))}
        {/* One small tool (a control-h-sm square, 24–28 px by density) and the cell's padding. */}
        {tools ? <col style={{ width: 36 }} /> : null}
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
          {tools ? (
            <th scope="col">
              <span className="bx-sr-only">Line tools</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && empty ? (
          <tr>
            <td colSpan={span + 1} className="bx-muted">
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
              {tools ? <td className="bx-mfg-lines__tool">{r.tool ?? null}</td> : null}
            </tr>
            {r.error ? (
              <tr className="bx-mfg-row__error" role="alert">
                <td />
                <td colSpan={span}>{r.error}</td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </tbody>
      {footer ? (
        <tfoot>
          <tr>
            <td />
            <td colSpan={span}>{footer}</td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

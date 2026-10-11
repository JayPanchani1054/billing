/**
 * Horizontal statement (two sides with their own trees and equal totals) used by the Profit & Loss A/c
 * and the Balance Sheet: one flat sheet, each side a named section (2.1).
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { StatementLine } from '../../../shared/types/reports.ts';
import { StatementSide, useTreeExpansion } from './components.tsx';
import type { TreeExpansion } from './components.tsx';
import { sheetTabTarget } from './lib/model.ts';
import { visibleRows } from './lib/tree.ts';
import type { BudgetByKey } from './lib/overlay.ts';

export interface BlockData {
  left: readonly StatementLine[];
  right: readonly StatementLine[];
  total: number;
  compareTotal: number | null;
}

export interface BlockExpansion {
  left: TreeExpansion;
  right: TreeExpansion;
}

/** Remembered expansion for both sides of a block (`detailed` opens everything on the first visit). */
export function useBlockExpansion(screenKey: string, block: BlockData | undefined, detailed: boolean): BlockExpansion {
  const left = useTreeExpansion(`${screenKey}:left`, block?.left ?? EMPTY, detailed ? 99 : 0);
  const right = useTreeExpansion(`${screenKey}:right`, block?.right ?? EMPTY, detailed ? 99 : 0);
  return { left, right };
}

const EMPTY: readonly StatementLine[] = [];

/** Lines currently visible on both sides (for export/print and for sizing). */
export function visibleBlock(block: BlockData, exp: BlockExpansion): BlockData {
  return { ...block, left: visibleRows(block.left, exp.left.expandedKeys), right: visibleRows(block.right, exp.right.expandedKeys) };
}

export interface SheetBlock {
  /** "Trading Account" / "Profit & Loss Account" — a quiet row-group label over the block. */
  caption?: string;
  block: BlockData;
  expansion: BlockExpansion;
}

export interface StatementSheetProps {
  leftTitle: string;
  rightTitle: string;
  blocks: readonly SheetBlock[];
  compareLabel: string | null;
  onActivate: (line: StatementLine) => void;
  loading?: boolean;
  /** (additive) Budget column on both sides (overlay.tsx): `leftDrNatural` true for a P&L (expenses left), false for a Balance Sheet. */
  budget?: { name: string; byKey: BudgetByKey; leftDrNatural: boolean } | null;
  /** (2.1) Footnotes moved into row tooltips (Closing Stock, the Profit & Loss A/c line). */
  rowTitle?: (line: StatementLine) => string | undefined;
}

/**
 * A two-sided statement on one flat sheet (2.1, SPEC-21 §1.9): each side is a `section` named after it
 * ("Expenses" | "Income", "Liabilities" | "Assets" — screen readers and tests find the sides by these
 * regions); inside, every block (Trading / Profit & Loss Account) is a tree table under a quiet caption.
 * The column header shows once, on the first block; both sides of a block are sized alike so the
 * captions line up. Tab moves from one side to the other within a block, then to the next block
 * (`sheetTabTarget` — the 2.0 order, although each side is now one section).
 */
export function StatementSheet({ leftTitle, rightTitle, blocks, compareLabel, onActivate, loading, budget = null, rowTitle }: StatementSheetProps) {
  // Rows shown on the longer side of each block (both sides take that height, so captions line up).
  const heights = blocks.map((b) => Math.max(visibleRows(b.block.left, b.expansion.left.expandedKeys).length, visibleRows(b.block.right, b.expansion.right.expandedKeys).length));
  const side = (which: 'left' | 'right') => {
    const title = which === 'left' ? leftTitle : rightTitle;
    const drNatural = budget ? (which === 'left' ? budget.leftDrNatural : !budget.leftDrNatural) : true;
    return (
      <section className="bx-rep-side" aria-label={title}>
        {blocks.map((b, i) => (
          <div key={i} data-sheet-cell={`${i}:${which}`}>
            {/* The caption reads on the left; the right keeps its line so both sides stay level. */}
            {b.caption ? (
              <p className="bx-rep-caption" aria-hidden={which === 'right' ? true : undefined}>
                {which === 'left' ? b.caption : '\u00a0'}
              </p>
            ) : null}
            <StatementSide
              title={title}
              caption={b.caption}
              lines={b.block[which]}
              total={b.block.total}
              compareTotal={b.block.compareTotal}
              compareLabel={compareLabel}
              budget={budget ? { name: budget.name, byKey: budget.byKey, drNatural } : null}
              expansion={b.expansion[which]}
              onActivate={onActivate}
              loading={loading}
              autoFocus={which === 'left' && i === 0}
              heightRows={heights[i]}
              continued={i > 0}
              rowTitle={rowTitle}
            />
          </div>
        ))}
      </section>
    );
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    const grid = e.target as HTMLElement;
    const cell = grid.matches('[role=grid], [role=treegrid]') ? grid.closest('[data-sheet-cell]') : null;
    if (!cell) return;
    const [block, which] = (cell.getAttribute('data-sheet-cell') ?? '').split(':');
    const to = sheetTabTarget(blocks.length, { block: Number(block), side: which === 'right' ? 'right' : 'left' }, e.shiftKey);
    const next = to ? e.currentTarget.querySelector<HTMLElement>(`[data-sheet-cell="${to.block}:${to.side}"] :is([role=grid], [role=treegrid])`) : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  return (
    <div className="bx-rep-sides" onKeyDown={onKeyDown}>
      {side('left')}
      {side('right')}
    </div>
  );
}

/**
 * Horizontal statement block (two sides with their own trees and equal totals) used by the
 * Profit & Loss A/c and the Balance Sheet.
 */
import { useMemo } from 'react';
import type { StatementLine } from '../../../shared/types/reports.ts';
import { Stack } from '../../ui/index.ts';
import { StatementSide, useTreeExpansion } from './components.tsx';
import type { TreeExpansion } from './components.tsx';
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

export interface StatementBlockViewProps {
  caption?: string;
  leftTitle: string;
  rightTitle: string;
  block: BlockData;
  expansion: BlockExpansion;
  compareLabel: string | null;
  onActivate: (line: StatementLine) => void;
  loading?: boolean;
  autoFocus?: boolean;
  /** (additive) Budget column on both sides (overlay.tsx): `leftDrNatural` true for a P&L (expenses left), false for a Balance Sheet. */
  budget?: { name: string; byKey: BudgetByKey; leftDrNatural: boolean } | null;
}

export function StatementBlockView({ caption, leftTitle, rightTitle, block, expansion, compareLabel, onActivate, loading, autoFocus, budget = null }: StatementBlockViewProps) {
  const heightRows = useMemo(
    () => Math.max(visibleRows(block.left, expansion.left.expandedKeys).length, visibleRows(block.right, expansion.right.expandedKeys).length),
    [block, expansion.left.expandedKeys, expansion.right.expandedKeys],
  );
  return (
    <Stack gap={2}>
      {caption ? <h2 className="bx-rep-section-title">{caption}</h2> : null}
      <div className="bx-rep-sides">
        <StatementSide
          title={leftTitle}
          lines={block.left}
          total={block.total}
          compareTotal={block.compareTotal}
          compareLabel={compareLabel}
          budget={budget ? { name: budget.name, byKey: budget.byKey, drNatural: budget.leftDrNatural } : null}
          expansion={expansion.left}
          onActivate={onActivate}
          loading={loading}
          autoFocus={autoFocus}
          heightRows={heightRows}
        />
        <StatementSide
          title={rightTitle}
          lines={block.right}
          total={block.total}
          compareTotal={block.compareTotal}
          compareLabel={compareLabel}
          budget={budget ? { name: budget.name, byKey: budget.byKey, drNatural: !budget.leftDrNatural } : null}
          expansion={expansion.right}
          onActivate={onActivate}
          loading={loading}
          heightRows={heightRows}
        />
      </div>
    </Stack>
  );
}

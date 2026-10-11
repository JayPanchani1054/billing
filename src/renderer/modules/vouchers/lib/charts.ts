/**
 * The Day Book's graph (2.1.2 — the owner's change to SPEC-21 D26: "graphs on all reports"). Pure, so
 * charts.test.ts proves "graph total = table total" in node.
 *
 *   dayBookChart(rows)  "What happened this period?" — one bar per voucher type of the amounts the table
 *                       lists (the Debit or Credit cell of each row), only the types present, Top 6 +
 *                       Other, slot 1. Optional and cancelled vouchers count as the table's total counts
 *                       them: not at all. Enter on a bar shows only that voucher type (the "Voucher types"
 *                       menu), the same filter the menu sets.
 *
 * The vouchers module is eager (it stays in the start-up bundle): this file reaches only the small graph
 * core (ui/lib/chartCore.ts) at run time, never ui/lib/chartSpec.ts (app/lib/chartImports.test.ts).
 */
import { clipTakeaway, compactValue, enoughData, foldTop } from '../../../ui/lib/chartCore.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import { DAYBOOK_CHIPS } from './daybook.ts';
import type { DayBookRow, TypeChip } from './daybook.ts';

/** Voucher types drawn as bars before the rest fold into "Other" (D26: Top 6 + Other). */
export const TOP_TYPES = 6;

/** One bar: a "Voucher types" menu entry (Sales, Receipt, Credit / Debit Notes …), or a type outside the menu. */
export interface DayBookType {
  label: string;
  /** The menu entry Enter on the bar selects (null: a type the menu does not list, e.g. quotations). */
  chip: string | null;
  amount: number;
  count: number;
}

const chipOf = new Map(DAYBOOK_CHIPS.flatMap((c) => c.baseTypes.map((b) => [b, c] as const)));

/**
 * The listed vouchers by type, in the order the bars draw them (largest amount first, ties by first
 * appearance). The amount is what the row shows (its Debit or Credit cell); optional and cancelled
 * vouchers are left out, as the table's total leaves them out. Types with no amount are dropped.
 */
export function dayBookTypes(rows: readonly DayBookRow[]): DayBookType[] {
  const by = new Map<string, DayBookType>();
  for (const r of rows) {
    if (r.isCancelled || r.isOptional) continue;
    const chip = chipOf.get(r.baseType) ?? null;
    const key = chip ? `chip:${chip.id}` : `type:${r.typeName}`;
    let t = by.get(key);
    if (!t) {
      t = { label: chip ? chip.label : r.typeName, chip: chip ? chip.id : null, amount: 0, count: 0 };
      by.set(key, t);
    }
    t.amount += r.debit + r.credit;
    t.count++;
  }
  return [...by.values()].filter((t) => t.amount !== 0).sort((a, b) => b.amount - a.amount);
}

/**
 * "Amount by voucher type" (vouchers.daybook): a strip above the table (a Day Book is long and mixes
 * types, so inline bars do not fit). Total = Σ bars = the table's Debit total + Credit total (optional
 * and cancelled vouchers not counted). Null below two types with an amount (2.1.1 D2: categories).
 * `onType` receives the menu entry of the bar; "Other", a type outside the menu and an entry the screen's
 * menu hides (`menu`: Orders without order processing, Stock without inventory) select nothing — the
 * filter would otherwise be one the menu cannot show or untick.
 */
export function dayBookChart(rows: readonly DayBookRow[], onType?: (chip: string) => void, menu: readonly Pick<TypeChip, 'id'>[] = DAYBOOK_CHIPS): ChartSpec | null {
  const types = dayBookTypes(rows);
  const f = foldTop(
    types,
    TOP_TYPES,
    (t) => t.amount,
    (t) => t.label,
  );
  const named = f.categories.length < types.length ? f.categories.length - 1 : f.categories.length;
  const offered = new Set(menu.map((c) => c.id));
  const takeaway = clipTakeaway(
    types
      .slice(0, 2)
      .map((t) => `${t.label} ${compactValue(t.amount)}`)
      .join(' · '),
  );
  const spec: ChartSpec = {
    kind: 'bar',
    title: 'Amount by voucher type',
    takeaway,
    categories: f.categories,
    series: [{ name: 'Amount', values: f.values }],
    total: f.values.reduce((a, b) => a + b, 0),
    activate: onType
      ? (i) => {
          const chip = i < named ? types[i]?.chip : null;
          if (chip && offered.has(chip)) onType(chip);
        }
      : undefined,
  };
  return enoughData(spec) ? spec : null;
}

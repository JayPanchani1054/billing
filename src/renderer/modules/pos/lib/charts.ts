/**
 * The POS Day-end Summary's graph and stat (SPEC-21 §5, WP-L1). Pure — tested in charts.test.ts.
 *
 *   tenderChart  'pos.summary' (By tender view)  bar of the net takings per tender, one colour (the tender
 *                                                names carry the identity); drawn inline in the table when
 *                                                it is the table's ≤ 7 rows, else Top 6 + Other
 *   summaryStat  'pos.summary'                   "Cash in drawer ₹y · Net sales ₹x · On credit ₹z · GST ₹w" — never a
 *                                                figure the visible table's total already shows
 */
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { PosRegister, PosSummary } from '../../../../shared/types/pos.ts';
import { enoughData, foldTop, statRepeatsTotal, take } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import { expectedDrawer } from './summary.ts';
import type { SummaryView } from './summary.ts';

/** One figure of the toolbar-row stat (ui/StatLine.tsx): paise. */
export interface StatItem {
  label: string;
  value: Paise;
  title?: string;
}

/**
 * Net takings by tender (Σ = the table's Net total). Takeaway: the share of the largest tender.
 * `activate(i)` = Enter on that tender's row (its bills); only for unfolded categories.
 */
export function tenderChart(s: Pick<PosSummary, 'byTender'>, activate?: (modeId: number) => void): ChartSpec | null {
  const rows = s.byTender;
  const folded = foldTop(rows, 6, (r) => r.net, (r) => r.name);
  const total = folded.values.reduce((a, b) => a + b, 0);
  let top = -1;
  folded.values.forEach((v, i) => {
    if (top < 0 || Math.abs(v) > Math.abs(folded.values[top])) top = i;
  });
  const whole = folded.values.reduce((a, v) => a + Math.abs(v), 0);
  const spec: ChartSpec = {
    kind: 'bar',
    title: 'Takings by tender',
    takeaway: top >= 0 && whole > 0 ? take.share(folded.categories[top], (Math.abs(folded.values[top]) / whole) * 100, 'the takings') : '',
    categories: folded.categories,
    series: [{ name: 'Net', values: folded.values }],
    label: 'tips',
    total,
  };
  if (activate) {
    const byName = new Map(rows.map((r) => [r.name, r.modeId]));
    spec.activate = (i) => {
      const id = byName.get(folded.categories[i]);
      if (id !== undefined) activate(id);
    };
  }
  return enoughData(spec) ? spec : null;
}

/**
 * The day's answer in words: the cash the drawer should hold (the opening float + cash received −
 * refunded), the net sales (sales − returns: the By tender table only shows what was paid, not what
 * went on credit), what was sold on credit and the GST on sales. A figure equal to a total the visible
 * table shows is left out (D24) — the table already says it (the cashier and counter views' Net
 * total is the net sales). `visibleTotals` = the totals of the view on screen.
 */
export function summaryStat(s: Pick<PosSummary, 'net' | 'netCash' | 'changeGiven' | 'creditSales' | 'creditReturns' | 'tax' | 'returnTax' | 'bills' | 'returns' | 'exchangeIssued' | 'exchangeUsed' | 'mrpSavings'>, openingFloat: Paise, visibleTotals: readonly number[]): StatItem[] {
  const rupees = (p: Paise) => `₹${formatMoney(p)}`;
  const details = [
    `${s.bills} bill${s.bills === 1 ? '' : 's'} · ${s.returns} return${s.returns === 1 ? '' : 's'}`,
    `change given ${rupees(s.changeGiven)}`,
    s.exchangeIssued || s.exchangeUsed ? `exchange credit issued ${rupees(s.exchangeIssued)}, used ${rupees(s.exchangeUsed)}` : null,
    s.mrpSavings ? `customers saved ${rupees(s.mrpSavings)} on MRP` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const all: StatItem[] = [
    { label: 'Cash in drawer', value: expectedDrawer(s, openingFloat), title: `Opening float + cash received − refunded. ${details}` },
    { label: 'Net sales', value: s.net, title: 'Sales − returns, including GST' },
    { label: 'On credit', value: s.creditSales, title: s.creditReturns > 0 ? `Returns credited to customers ${rupees(s.creditReturns)}` : 'Left on customers’ accounts' },
    { label: 'GST', value: s.tax - s.returnTax, title: `On sales ${rupees(s.tax)} − on returns ${rupees(s.returnTax)}` },
  ];
  return all.filter((i, n) => (n === 0 || i.value !== 0) && !statRepeatsTotal([i.value], visibleTotals));
}

/** The totals the table of `view` shows (its footer row), for `summaryStat`. */
export function visibleTotals(s: Pick<PosSummary, 'byTender' | 'sales' | 'returnValue' | 'net'>, view: SummaryView, register?: Pick<PosRegister, 'sums'>): number[] {
  if (view === 'tender') {
    const t = (k: 'received' | 'refunded' | 'net') => s.byTender.reduce((a, r) => a + r[k], 0);
    return [t('received'), t('refunded'), t('net')];
  }
  if (view === 'bills') return register ? [register.sums.billValue, register.sums.credit] : [];
  return [s.sales, s.returnValue, s.net];
}

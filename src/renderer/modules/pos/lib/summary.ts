/**
 * Day-end POS summary — pure helpers (tested in summary.test.ts): the KPI tiles, the cash drawer
 * line and the export tables of each view (by tender / by user / by counter / bills).
 */
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { PosRegister, PosRegisterInput, PosSummary, PosSummaryCounterRow, PosSummaryTenderRow, PosSummaryUserRow } from '../../../../shared/types/pos.ts';
import { POS_TENDER_KIND_LABELS } from '../../../../shared/types/pos.ts';
import type { TableExportDef } from '../../../app/export.ts';

export type SummaryView = 'tender' | 'user' | 'counter' | 'bills';

export const SUMMARY_VIEWS: ReadonlyArray<{ view: SummaryView; label: string }> = [
  { view: 'tender', label: 'By tender' },
  { view: 'user', label: 'By cashier' },
  { view: 'counter', label: 'By counter' },
  { view: 'bills', label: 'Bills and returns' },
];

export interface Tile {
  label: string;
  value: Paise;
  caption: string;
}

/** Headline figures of the day. */
export function summaryTiles(s: PosSummary): Tile[] {
  return [
    { label: 'Net sales', value: s.net, caption: `${s.bills} bill${s.bills === 1 ? '' : 's'} − ${s.returns} return${s.returns === 1 ? '' : 's'}` },
    { label: 'Cash in drawer from POS', value: s.netCash, caption: `Received in cash − refunded; change given ₹ ${formatMoney(s.changeGiven)}` },
    { label: 'Sold on credit', value: s.creditSales, caption: s.creditReturns > 0 ? `Returns credited to customers ₹ ${formatMoney(s.creditReturns)}` : 'Left on customers’ accounts' },
    { label: 'GST on sales', value: s.tax - s.returnTax, caption: `Sales ₹ ${formatMoney(s.tax)} − returns ₹ ${formatMoney(s.returnTax)}` },
  ];
}

/** Expected cash in the drawer: opening float + cash received − cash refunded (cash net of change). */
export function expectedDrawer(s: Pick<PosSummary, 'netCash'>, openingFloat: Paise): Paise {
  return openingFloat + s.netCash;
}

/** Counted cash − expected: positive = excess, negative = short. */
export function drawerDifference(counted: Paise | null, expected: Paise): Paise | null {
  return counted === null ? null : counted - expected;
}

export function summaryExport(s: PosSummary, view: SummaryView, register?: PosRegister): TableExportDef {
  const period = { from: s.from, to: s.to };
  if (view === 'tender') {
    return {
      title: 'POS Summary — By Tender',
      period,
      columns: [{ header: 'Tender' }, { header: 'Kind' }, { header: 'Ledger' }, { header: 'Received', kind: 'amount' }, { header: 'Refunded', kind: 'amount' }, { header: 'Net', kind: 'amount' }, { header: 'Bills', kind: 'number' }],
      rows: s.byTender.map((t) => [t.name, POS_TENDER_KIND_LABELS[t.kind], t.ledgerName, t.received, t.refunded, t.net, t.count]),
      totals: ['Total', '', '', s.byTender.reduce((a, t) => a + t.received, 0), s.byTender.reduce((a, t) => a + t.refunded, 0), s.byTender.reduce((a, t) => a + t.net, 0), null],
    };
  }
  if (view === 'user') {
    return {
      title: 'POS Summary — By Cashier',
      period,
      columns: [{ header: 'Cashier' }, { header: 'Bills', kind: 'number' }, { header: 'Sales', kind: 'amount' }, { header: 'Returns', kind: 'number' }, { header: 'Return value', kind: 'amount' }, { header: 'Net', kind: 'amount' }],
      rows: s.byUser.map((u) => [u.userName, u.bills, u.sales, u.returns, u.returnValue, u.net]),
      totals: ['Total', s.bills, s.sales, s.returns, s.returnValue, s.net],
    };
  }
  if (view === 'counter') {
    return {
      title: 'POS Summary — By Counter',
      period,
      columns: [{ header: 'Counter' }, { header: 'Bills', kind: 'number' }, { header: 'Sales', kind: 'amount' }, { header: 'Return value', kind: 'amount' }, { header: 'Net', kind: 'amount' }],
      rows: s.byCounter.map((c) => [c.counter || '(not named)', c.bills, c.sales, c.returnValue, c.net]),
      totals: ['Total', s.bills, s.sales, s.returnValue, s.net],
    };
  }
  const rows = register?.rows ?? [];
  return {
    title: 'POS Register',
    period,
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Type' },
      { header: 'No.' },
      { header: 'Customer' },
      { header: 'Value', kind: 'amount' },
      { header: 'Paid', kind: 'amount' },
      { header: 'On account', kind: 'amount' },
      { header: 'Tenders' },
      { header: 'Counter' },
      { header: 'Cashier' },
    ],
    rows: rows.map((r) => [r.date, r.kind === 'sale' ? r.voucherTypeName : `${r.voucherTypeName} (return${r.returnOf?.number ? ` of ${r.returnOf.number}` : ''})`, r.number ?? '', r.partyName ?? '', signed(r), signed(r, 'paid'), signed(r, 'credit'), r.tenders, r.counter ?? '', r.userName ?? '']),
    totals: ['', '', '', 'Total', register?.sums.billValue ?? 0, register?.sums.paid ?? 0, register?.sums.credit ?? 0, '', '', ''],
  };
}

/** Register amounts: a return counts negative. */
export function signed(r: { kind: 'sale' | 'return'; billValue: Paise; paid: Paise; credit: Paise }, field: 'billValue' | 'paid' | 'credit' = 'billValue'): Paise {
  return r.kind === 'sale' ? r[field] : -r[field];
}

/**
 * Drill-down from a summary row (Enter): the bills and returns behind it — the register filtered by
 * that tender mode, cashier (null: entered without a login) or counter ('' = not named).
 */
export interface SummaryDrill {
  label: string;
  filter: Pick<PosRegisterInput, 'modeId' | 'userId' | 'counter'>;
}

export function drillTender(r: Pick<PosSummaryTenderRow, 'modeId' | 'name'>): SummaryDrill {
  return { label: `Paid by ${r.name}`, filter: { modeId: r.modeId } };
}

export function drillUser(r: Pick<PosSummaryUserRow, 'userId' | 'userName'>): SummaryDrill {
  return { label: `Cashier ${r.userName}`, filter: { userId: r.userId } };
}

export function drillCounter(r: Pick<PosSummaryCounterRow, 'counter'>): SummaryDrill {
  return { label: `Counter ${r.counter || '(not named)'}`, filter: { counter: r.counter } };
}

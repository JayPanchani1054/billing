/**
 * Pure presentation logic for the dashboard (tested in model.test.ts): KPI deltas and captions, the
 * 12-month chart series, ageing mini-bars, the alerts list, drill-down targets and the export table.
 * Amounts are paise. Text is plain English for small-business owners.
 */
import { diffDays, formatDate, MONTH_NAMES } from '../../../../shared/dates.ts';
import { formatCompactINR, formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type {
  DashboardAgeingBucket,
  DashboardFlow,
  DashboardMonth,
  DashboardSummary,
  DateRange,
} from '../../../../shared/types/dashboard.ts';

/** A screen to open (canonical ids, see the feature brief). */
export interface DrillTarget {
  screen: string;
  params?: Record<string, unknown>;
}

// ───────────────────────────── Numbers & words ─────────────────────────────

/** Percentage change, 1 decimal; null when there is nothing to compare with. */
export function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

/** '₹1.23 L' */
export const compact = (p: Paise): string => formatCompactINR(p);
/** '₹ 1,23,456.00' */
export const exact = (p: Paise): string => formatMoney(p, { symbol: true });

/** Signed-percentage text for captions: '+12.5%', '−3.0%', 'no change'. */
export function changeText(delta: number | null): string | null {
  if (delta === null) return null;
  if (delta === 0) return 'no change';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}%`;
}

/** 'Nov 25' — short month label for chart categories. */
export function shortMonth(month: string): string {
  const m = Number(month.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? month.slice(5, 7)} ${month.slice(2, 4)}`;
}

/** 'Due today' · 'Due tomorrow' · 'Due in 3 days' · '1 day overdue' · '12 days overdue'. */
export function dueText(date: string, asOf: string): string {
  const d = diffDays(asOf, date);
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  if (d > 1) return `Due in ${d} days`;
  return `${plural(-d, 'day')} overdue`;
}

// ───────────────────────────── KPI captions ─────────────────────────────

export interface FlowKpi {
  value: Paise;
  /** % vs the same period last year (null when last year was 0). */
  delta: number | null;
  /** 'Today ₹300 · This month ₹1.3 K' */
  caption: string;
  /** 'Same period last year ₹1.0 K' */
  comparison: string;
}

export function flowKpi(f: DashboardFlow): FlowKpi {
  return {
    value: f.period,
    delta: deltaPercent(f.period, f.lastYear.period),
    caption: `Today ${compact(f.today)} · This month ${compact(f.mtd)}`,
    comparison: f.lastYear.period === 0 ? 'Nothing in the same period last year' : `Same period last year ${compact(f.lastYear.period)}`,
  };
}

/** Sales of the last 12 months (sparkline values). */
export function salesSpark(trend: readonly DashboardMonth[]): number[] {
  return trend.map((m) => m.sales);
}

// ───────────────────────────── Trend chart ─────────────────────────────

export interface TrendChart {
  categories: string[];
  series: Array<{ name: string; values: number[]; slot: 1 | 2 }>;
  /** Accessible takeaway: 'Sales peaked in Sep 2026 at ₹2,500.00. 12-month sales ₹4.8 K, purchases ₹8.8 K.' */
  description: string;
  empty: boolean;
}

export function trendChart(trend: readonly DashboardMonth[]): TrendChart {
  const sales = trend.map((m) => m.sales);
  const purchases = trend.map((m) => m.purchases);
  const totalS = sales.reduce((a, b) => a + b, 0);
  const totalP = purchases.reduce((a, b) => a + b, 0);
  const empty = trend.every((m) => m.sales === 0 && m.purchases === 0);
  let description = 'No sales or purchases in the last 12 months.';
  if (!empty) {
    let best = 0;
    for (let i = 1; i < sales.length; i++) if (sales[i] > sales[best]) best = i;
    const peak = sales[best] > 0 ? `Sales peaked in ${monthLong(trend[best].month)} at ${exact(sales[best])}. ` : '';
    description = `${peak}12-month sales ${compact(totalS)}, purchases ${compact(totalP)}.`;
  }
  return {
    categories: trend.map((m) => shortMonth(m.month)),
    // Colour follows the entity: Sales is always slot 1, Purchases slot 2.
    series: [
      { name: 'Sales', values: sales, slot: 1 },
      { name: 'Purchases', values: purchases, slot: 2 },
    ],
    description,
    empty,
  };
}

function monthLong(month: string): string {
  const m = Number(month.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? ''} ${month.slice(0, 4)}`;
}

// ───────────────────────────── Ageing mini-bars ─────────────────────────────

export interface AgeingBar {
  index: number;
  label: string;
  amount: Paise;
  /** Bar length 0–100 (% of the largest positive bucket). */
  percent: number;
  overdue: boolean;
}

export function ageingBars(buckets: readonly DashboardAgeingBucket[]): AgeingBar[] {
  const max = buckets.reduce((m, b) => Math.max(m, b.amount), 0);
  return buckets.map((b) => ({
    index: b.index,
    label: b.label,
    amount: b.amount,
    percent: max > 0 && b.amount > 0 ? Math.max(1, Math.round((b.amount / max) * 1000) / 10) : 0,
    overdue: b.index > 0,
  }));
}

// ───────────────────────────── Drill-down targets ─────────────────────────────

export const DRILL = {
  salesRegister: (r: DateRange): DrillTarget => ({ screen: 'reports.register', params: { baseType: 'sales', from: r.from, to: r.to } }),
  purchaseRegister: (r: DateRange): DrillTarget => ({ screen: 'reports.register', params: { baseType: 'purchase', from: r.from, to: r.to } }),
  profitLoss: (r: DateRange): DrillTarget => ({ screen: 'reports.profitLoss', params: { from: r.from, to: r.to } }),
  receivables: (): DrillTarget => ({ screen: 'outstanding.receivables' }),
  receivablesOverdue: (): DrillTarget => ({ screen: 'outstanding.receivables', params: { view: 'bills', overdueOnly: true } }),
  receivablesAgeing: (): DrillTarget => ({ screen: 'outstanding.receivables', params: { view: 'ageing' } }),
  payables: (): DrillTarget => ({ screen: 'outstanding.payables' }),
  payablesBills: (): DrillTarget => ({ screen: 'outstanding.payables', params: { view: 'bills' } }),
  payablesOverdue: (): DrillTarget => ({ screen: 'outstanding.payables', params: { view: 'bills', overdueOnly: true } }),
  payablesAgeing: (): DrillTarget => ({ screen: 'outstanding.payables', params: { view: 'ageing' } }),
  cashBank: (r: DateRange): DrillTarget => ({ screen: 'reports.cashBank', params: { from: r.from, to: r.to } }),
  ledger: (ledgerId: number, r?: DateRange): DrillTarget => ({ screen: 'reports.ledger', params: r ? { ledgerId, from: r.from, to: r.to } : { ledgerId } }),
  brs: (ledgerId: number): DrillTarget => ({ screen: 'banking.brs', params: { ledgerId } }),
  gstr3b: (period: string): DrillTarget => ({ screen: 'gst.gstr3b', params: { period } }),
  einvoice: (r: DateRange): DrillTarget => ({ screen: 'gst.einvoice', params: { from: r.from, to: r.to } }),
  ewaybill: (r: DateRange): DrillTarget => ({ screen: 'gst.ewaybill', params: { from: r.from, to: r.to } }),
  stockSummary: (): DrillTarget => ({ screen: 'stock.summary' }),
  stockItem: (itemId: number): DrillTarget => ({ screen: 'stock.item', params: { itemId } }),
  voucher: (id: number): DrillTarget => ({ screen: 'vouchers.view', params: { id } }),
  dayBook: (r: DateRange): DrillTarget => ({ screen: 'vouchers.daybook', params: { from: r.from, to: r.to } }),
  pdc: (): DrillTarget => ({ screen: 'banking.pdc' }),
  backup: (): DrillTarget => ({ screen: 'data.backup' }),
  dashboard: (): DrillTarget => ({ screen: 'dashboard.home' }),
} as const;

// ───────────────────────────── Alerts ─────────────────────────────

export type AlertTone = 'danger' | 'warning' | 'info';

export interface DashboardAlert {
  id: string;
  tone: AlertTone;
  icon: 'clock' | 'alert' | 'box' | 'receipt' | 'truck' | 'database' | 'gst' | 'calendar' | 'wallet' | 'bank';
  title: string;
  body: string;
  target: DrillTarget;
}

/** Last backup older than this many days is flagged. */
export const BACKUP_WARN_DAYS = 7;
/** GST payment is flagged as urgent this many days before it is due. */
export const GST_URGENT_DAYS = 5;

const TONE_ORDER: Record<AlertTone, number> = { danger: 0, warning: 1, info: 2 };

/** Things that need the owner's attention, most serious first. */
export function buildAlerts(s: DashboardSummary): DashboardAlert[] {
  const out: DashboardAlert[] = [];
  const r = s.receivables;
  if (r.overdue > 0) {
    const old = r.ageing.filter((b) => (b.minDays ?? 0) > 90).reduce((t, b) => t + b.amount, 0);
    out.push({
      id: 'receivables-overdue',
      tone: old > 0 ? 'danger' : 'warning',
      icon: 'clock',
      title: `${compact(r.overdue)} overdue from customers`,
      body: `${plural(r.overdueBillCount, 'bill')} from ${plural(r.overduePartyCount, 'customer')} ${r.overdueBillCount === 1 ? 'is' : 'are'} past the due date${old > 0 ? ` — ${compact(old)} is over 90 days old` : ''}.`,
      target: DRILL.receivablesOverdue(),
    });
  }
  const p = s.payables;
  if (p.overdue > 0) {
    out.push({
      id: 'payables-overdue',
      tone: 'warning',
      icon: 'clock',
      title: `${compact(p.overdue)} overdue to suppliers`,
      body: `${plural(p.overdueBillCount, 'bill')} to ${plural(p.overduePartyCount, 'supplier')} ${p.overdueBillCount === 1 ? 'is' : 'are'} past the due date.`,
      target: DRILL.payablesOverdue(),
    });
  }
  if (p.dueSoon.count > 0) {
    out.push({
      id: 'payables-due-soon',
      tone: 'info',
      icon: 'calendar',
      title: `${compact(p.dueSoon.amount)} to pay in the next ${p.dueSoon.days} days`,
      body: `${plural(p.dueSoon.count, 'supplier bill')} ${p.dueSoon.count === 1 ? 'falls' : 'fall'} due by ${formatDate(p.dueSoon.until)}.`,
      target: DRILL.payablesBills(),
    });
  }
  if (s.gst && s.gst.netPayable > 0) {
    const days = diffDays(s.asOf, s.gst.dueDate);
    out.push({
      id: 'gst-due',
      tone: days <= GST_URGENT_DAYS ? 'warning' : 'info',
      icon: 'gst',
      title: `GST of ${compact(s.gst.netPayable)} for ${s.gst.label}`,
      body: `Estimated cash payment after input credit. ${s.gst.dueForm} is due by ${formatDate(s.gst.dueDate)}${days >= 0 ? ` (${dueText(s.gst.dueDate, s.asOf).toLowerCase()})` : ''}.`,
      target: DRILL.gstr3b(s.gst.period),
    });
  }
  if (s.cashBank.cashTotal < 0) {
    out.push({
      id: 'cash-negative',
      tone: 'danger',
      icon: 'wallet',
      title: 'Cash in hand is negative',
      body: `The cash books show ${exact(-s.cashBank.cashTotal)} Cr — a payment may have been entered twice or a receipt is missing.`,
      target: DRILL.cashBank(s.ranges.period),
    });
  }
  for (const b of s.cashBank.banks) {
    if (!b.isOverdraft && b.balance < 0) {
      out.push({
        id: `bank-overdrawn-${b.ledgerId}`,
        tone: 'warning',
        icon: 'bank',
        title: `${b.name} is overdrawn`,
        body: `The books show ${exact(-b.balance)} Cr. Check the entries or reconcile with the bank statement.`,
        target: DRILL.ledger(b.ledgerId),
      });
    }
  }
  if (s.lowStock.count > 0) {
    const names = s.lowStock.items.slice(0, 3).map((i) => i.name);
    const more = s.lowStock.count - names.length;
    out.push({
      id: 'low-stock',
      tone: 'warning',
      icon: 'box',
      title: `${plural(s.lowStock.count, 'item')} below reorder level`,
      body: `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
      target: s.lowStock.count === 1 && s.lowStock.items[0] ? DRILL.stockItem(s.lowStock.items[0].itemId) : DRILL.stockSummary(),
    });
  }
  const c = s.compliance;
  if (c.einvoicePending !== null && c.einvoicePending > 0) {
    out.push({
      id: 'einvoice-pending',
      tone: 'warning',
      icon: 'receipt',
      title: `${plural(c.einvoicePending, 'invoice')} without an e-invoice`,
      body: 'Generate the IRN for these B2B / export invoices (Gateway › GST › e-Invoice).',
      target: DRILL.einvoice({ from: c.from, to: c.to }),
    });
  }
  if (c.ewayPending !== null && c.ewayPending > 0) {
    out.push({
      id: 'eway-pending',
      tone: 'warning',
      icon: 'truck',
      title: `${plural(c.ewayPending, 'invoice')} without an e-way bill`,
      body: 'Goods worth more than ₹50,000 need an e-way bill before they move.',
      target: DRILL.ewaybill({ from: c.from, to: c.to }),
    });
  }
  const soonPdc = s.postDated.rows.filter((x) => diffDays(s.asOf, x.date) <= 7);
  if (soonPdc.length > 0) {
    out.push({
      id: 'pdc-week',
      tone: 'info',
      icon: 'calendar',
      title: `${plural(soonPdc.length, 'post-dated cheque')} due this week`,
      body: `Next: ${soonPdc[0].partyName ?? soonPdc[0].typeName} ${exact(soonPdc[0].amount)} on ${formatDate(soonPdc[0].date)}.`,
      target: DRILL.pdc(),
    });
  }
  const bk = s.backup;
  if (bk.lastBackupAt === null) {
    out.push({
      id: 'backup',
      tone: s.hasVouchers ? 'danger' : 'warning',
      icon: 'database',
      title: 'Your books have never been backed up',
      body: 'Take a backup now and keep a copy on another drive or a pen drive.',
      target: DRILL.backup(),
    });
  } else if (bk.daysSince !== null && bk.daysSince >= BACKUP_WARN_DAYS) {
    out.push({
      id: 'backup',
      tone: 'warning',
      icon: 'database',
      title: `Last backup was ${plural(bk.daysSince, 'day')} ago`,
      body: 'Back up at least once a week so you never lose your entries.',
      target: DRILL.backup(),
    });
  }
  return out.map((a, i) => ({ a, i })).sort((x, y) => TONE_ORDER[x.a.tone] - TONE_ORDER[y.a.tone] || x.i - y.i).map((x) => x.a);
}

// ───────────────────────────── Export ─────────────────────────────

export interface DashboardExport {
  columns: Array<{ header: string; kind?: 'text' | 'amount' | 'percent'; width?: number; decimals?: number }>;
  rows: Array<Array<string | number | null>>;
  notes?: string;
}

/** The summary as one table (Alt+E / Alt+P): every figure with last year where it applies. */
export function exportTable(s: DashboardSummary): DashboardExport {
  const rows: Array<Array<string | number | null>> = [];
  const flow = (label: string, f: DashboardFlow): void => {
    rows.push([`${label} — this period`, f.period, f.lastYear.period, deltaPercent(f.period, f.lastYear.period)]);
    rows.push([`${label} — year to date`, f.ytd, f.lastYear.ytd, deltaPercent(f.ytd, f.lastYear.ytd)]);
    rows.push([`${label} — this month`, f.mtd, f.lastYear.mtd, deltaPercent(f.mtd, f.lastYear.mtd)]);
    rows.push([`${label} — today`, f.today, f.lastYear.today, deltaPercent(f.today, f.lastYear.today)]);
  };
  flow('Sales', s.sales);
  flow('Purchases', s.purchases);
  if (s.grossProfit) {
    rows.push([s.grossProfit.amount < 0 ? 'Gross loss — this period' : 'Gross profit — this period', Math.abs(s.grossProfit.amount), null, null]);
    rows.push(['Gross margin %', null, null, s.grossProfit.marginPercent]);
  }
  rows.push(['Receivables', s.receivables.total, null, null]);
  rows.push(['Receivables overdue', s.receivables.overdue, null, null]);
  rows.push(['Payables', s.payables.total, null, null]);
  rows.push([`Payables due in ${s.payables.dueSoon.days} days`, s.payables.dueSoon.amount, null, null]);
  // Balances: never a bare minus in an accounting report — a credit balance is labelled instead.
  rows.push([s.cashBank.cashTotal < 0 ? 'Cash in hand (Cr balance)' : 'Cash in hand', Math.abs(s.cashBank.cashTotal), null, null]);
  for (const b of s.cashBank.banks) rows.push([`${b.name}${b.balance < 0 ? (b.isOverdraft ? ' (overdraft used)' : ' (overdrawn, Cr)') : ''}`, Math.abs(b.balance), null, null]);
  if (s.gst) {
    rows.push([`GST output tax — ${s.gst.label}`, s.gst.outputTax, null, null]);
    rows.push([`GST input credit — ${s.gst.label}`, s.gst.inputTax, null, null]);
    rows.push([`GST payable (estimate) — due ${formatDate(s.gst.dueDate)}`, s.gst.netPayable, null, null]);
  }
  for (const c of s.topCustomers) rows.push([`Top customer: ${c.name}`, c.amount, null, c.sharePercent]);
  for (const i of s.topItems) rows.push([`Top item: ${i.name}`, i.amount, null, i.sharePercent]);
  return {
    columns: [
      { header: 'Particulars', kind: 'text', width: 44 },
      { header: 'Amount', kind: 'amount', width: 16 },
      { header: 'Same period last year', kind: 'amount', width: 16 },
      { header: 'Change / share %', kind: 'percent', width: 12, decimals: 2 },
    ],
    rows,
    notes: `Balances as on ${formatDate(s.asOf)}. Sales and purchases are net of returns and exclude GST.`,
  };
}

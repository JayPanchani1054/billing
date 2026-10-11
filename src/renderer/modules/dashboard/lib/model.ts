/**
 * Pure presentation logic for the dashboard (tested in model.test.ts): figures and their captions, the
 * graph specs (Home's sales columns, the full Dashboard's trend line and receivables by age), the
 * alerts list, the Setup line, the one-line cards, drill-down targets and the export table.
 * Amounts are paise. Text is plain English for small-business owners.
 */
import { diffDays, endOfMonth, financialYear, formatDate, MONTH_NAMES } from '../../../../shared/dates.ts';
import { formatCompactINR, formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type {
  DashboardAgeingBucket,
  DashboardFlow,
  DashboardGst,
  DashboardMonth,
  DashboardSetup,
  DashboardSummary,
  DashboardSummaryInput,
  DateRange,
} from '../../../../shared/types/dashboard.ts';
import { clipTakeaway, drawnTotal, enoughData, take } from '../../../ui/lib/chartCore.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';

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

/** '₹1.2 K', or '₹1.2 K overdrawn' for a negative value — never a bare minus. */
export function compactSigned(p: Paise, negativeWord: string): string {
  return p < 0 ? `${compact(-p)} ${negativeWord}` : compact(p);
}

// ───────────────────────────── Request & ranges ─────────────────────────────

/**
 * The dashboard request. Balances (receivables, payables, cash & bank, stock) are as on the working
 * date — or the period end when the period ends earlier — because the screens they drill into
 * (Receivables / Payables, Cash/Bank Books, Reorder Status) report as on the period end: with the
 * default period (financial year to date) both are the same day, and a past period shows the books
 * as they stood at its end.
 */
export function summaryInput(workingDate: string, from: string, to: string): DashboardSummaryInput {
  return { asOf: to < workingDate ? to : workingDate, from, to };
}

/**
 * Home's request (D10): as `summaryInput`, with the trend ending at the balances date (`trendTo`) — "Sales —
 * last 12 months" is the 12 months up to the working date even when the period runs on to the year end
 * (never cut off at the start of the period's 12-month window), and the running month is drawn only up to
 * that date: the "so far" figure its label and the takeaway state (`sales.mtd`).
 */
export function homeSummaryInput(workingDate: string, from: string, to: string): DashboardSummaryInput {
  const input = summaryInput(workingDate, from, to);
  return { ...input, trendTo: input.asOf };
}

/** Range for "balance as on asOf" drill-downs (Cash/Bank Books, a ledger): period start → asOf. */
export function balanceRange(s: Pick<DashboardSummary, 'asOf' | 'ranges'>): DateRange {
  const from = s.ranges.period.from <= s.asOf ? s.ranges.period.from : s.ranges.mtd.from;
  return { from, to: s.asOf };
}

// ───────────────────────────── KPI captions ─────────────────────────────

/** A KPI tile's label and the (non-negative) value it shows. */
export interface KpiFigure {
  label: string;
  value: Paise;
}

/** A negative figure gets its own label instead of a minus sign ('Cash & bank (overdrawn)'). */
export function signedKpi(label: string, p: Paise, negativeLabel: string): KpiFigure {
  return p < 0 ? { label: negativeLabel, value: -p } : { label, value: p };
}

/** 'Cash ₹6.1 K · Bank ₹29.9 K' (an overdrawn bank / negative cash in words). */
export function cashBankCaption(c: DashboardSummary['cashBank']): string {
  return `Cash ${compactSigned(c.cashTotal, 'negative')} · Bank ${compactSigned(c.bankTotal, 'overdrawn')}`;
}

export interface FlowKpi {
  value: Paise;
  /** % vs the same period last year (null when last year was 0). */
  delta: number | null;
  /** 'Today ₹300 · This month ₹1.3 K' */
  caption: string;
  /** 'Same period last year ₹1.0 K' */
  comparison: string;
}

/**
 * `asOf` / `workingDate`: when the balances are as on a past period end (summaryInput), the "today"
 * and "this month" figures are that day's and that month's — labelled with the date instead.
 */
export function flowKpi(f: DashboardFlow, asOf?: string, workingDate?: string): FlowKpi {
  const past = asOf !== undefined && workingDate !== undefined && asOf !== workingDate;
  const day = past ? `On ${formatDate(asOf)}` : 'Today';
  const month = past ? `${monthLong(asOf.slice(0, 7))} to date` : 'This month';
  return {
    value: f.period,
    delta: deltaPercent(f.period, f.lastYear.period),
    caption: `${day} ${compactSigned(f.today, 'net returns')} · ${month} ${compactSigned(f.mtd, 'net returns')}`,
    comparison: f.lastYear.period === 0 ? 'Nothing in the same period last year' : `Same period last year ${compact(f.lastYear.period)}`,
  };
}

/** Sales of the last 12 months (sparkline values). */
export function salesSpark(trend: readonly DashboardMonth[]): number[] {
  return trend.map((m) => m.sales);
}

// ───────────────────────────── Full Dashboard graphs (2.1) ─────────────────────────────

export interface TrendChart {
  categories: string[];
  /**
   * Sales is the measured series (slot 1); Purchases is context (grey, D29) — never a second colour.
   * A month after `upTo` (the rest of a period that has not happened yet) has no mark (null), never a 0.
   */
  series: Array<{ name: string; values: Array<number | null>; slot: 1 | 'other' }>;
  /** The one-sentence takeaway: 'Best month Sep 2026 ₹2.5 K · 12 months: sales ₹4.8 K, purchases ₹8.8 K'. */
  description: string;
  empty: boolean;
}

/**
 * `upTo` ('YYYY-MM-DD', the balances date): the trend runs to the period end (core `trendMonths`), so with
 * a period that ends later — the whole financial year — its last months have not happened yet. They are
 * drawn as no mark instead of a fall to zero, and left out of the takeaway.
 */
export function trendChart(trend: readonly DashboardMonth[], upTo?: string): TrendChart {
  const last = upTo ? upTo.slice(0, 7) : null;
  const past = (m: DashboardMonth): boolean => last === null || m.month <= last;
  const shown = trend.filter(past);
  const sales = trend.map((m) => (past(m) ? m.sales : null));
  const purchases = trend.map((m) => (past(m) ? m.purchases : null));
  const totalS = shown.reduce((a, m) => a + m.sales, 0);
  const totalP = shown.reduce((a, m) => a + m.purchases, 0);
  const empty = shown.every((m) => m.sales === 0 && m.purchases === 0);
  let description = 'No sales or purchases in the last 12 months';
  if (!empty) {
    let best = 0;
    for (let i = 1; i < shown.length; i++) if (shown[i].sales > shown[best].sales) best = i;
    const peak = shown[best].sales > 0 ? `Best month ${monthLong(shown[best].month)} ${compact(shown[best].sales)} · ` : '';
    description = clipTakeaway(`${peak}${shown.length} months: sales ${compact(totalS)}, purchases ${compact(totalP)}`);
  }
  return {
    categories: trend.map((m) => shortMonth(m.month)),
    series: [
      { name: 'Sales', values: sales, slot: 1 },
      { name: 'Purchases', values: purchases, slot: 'other' },
    ],
    description,
    empty,
  };
}

/**
 * The full Dashboard's trend (§5 dashboard.home): a line of Sales (slot 1, area) with Purchases as grey
 * context; Enter on a month opens that month's Sales Register. Null when there is nothing to draw.
 * `upTo`: months after it have no mark (see trendChart).
 */
export function trendSpec(trend: readonly DashboardMonth[], activate?: (index: number) => void, upTo?: string): ChartSpec | null {
  const c = trendChart(trend, upTo);
  if (c.empty) return null;
  const spec: ChartSpec = {
    kind: 'line',
    title: 'Sales and purchases — last 12 months',
    takeaway: c.description,
    categories: c.categories,
    series: c.series,
    label: 'last',
    total: 0,
    activate,
  };
  spec.total = drawnTotal(spec);
  return enoughData(spec) ? spec : null;
}

/**
 * The trend card's one sentence — the graph's takeaway, also when there is too little to draw (fewer than three
 * months up to `upTo`, early in a whole-year period): then the card still names the months there were, and says
 * "No sales or purchases…" only when there were none.
 */
export function trendCardText(trend: readonly DashboardMonth[], upTo?: string): string {
  return trendChart(trend, upTo).description;
}

/**
 * Receivables by age (§5 dashboard.home, the AgeingCard): ordinal columns — "Not due" grey, the overdue
 * buckets o1…o5 (more than five fold into the oldest). Total = Σ buckets = the bills outstanding.
 */
export function ageingSpec(buckets: readonly DashboardAgeingBucket[], activate?: (index: number) => void): ChartSpec | null {
  if (buckets.length < 2) return null;
  const notDue = buckets.filter((b) => b.index === 0);
  const overdue = buckets.filter((b) => b.index > 0);
  const kept = overdue.slice(0, 4);
  const rest = overdue.slice(4);
  const categories = [...notDue, ...kept].map((b) => b.label);
  const values = [...notDue, ...kept].map((b) => b.amount);
  if (rest.length > 0) {
    categories.push(rest.length === 1 ? rest[0].label : `Over ${(rest[0].minDays ?? 1) - 1} days`);
    values.push(rest.reduce((t, b) => t + b.amount, 0));
  }
  const total = values.reduce((a, b) => a + b, 0);
  const old = buckets.filter((b) => (b.minDays ?? 0) > 90).reduce((t, b) => t + b.amount, 0);
  const late = overdue.reduce((t, b) => t + b.amount, 0);
  const takeaway =
    old > 0 ? take.ordinal(compact(old), `${compact(total)} in unpaid bills`, '90 days') : late > 0 ? `Of ${compact(total)} in unpaid bills, ${compact(late)} is overdue` : `${compact(total)} in unpaid bills, none overdue`;
  const spec: ChartSpec = {
    kind: 'column',
    title: 'Receivables by age',
    takeaway,
    categories,
    series: [{ name: 'Unpaid bills', values }],
    color: 'ordinal',
    greyBefore: notDue.length > 0 ? 1 : 0,
    label: 'max',
    total,
    activate,
  };
  return enoughData(spec) ? spec : null;
}

function monthLong(month: string): string {
  const m = Number(month.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? ''} ${month.slice(0, 4)}`;
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
  reorder: (): DrillTarget => ({ screen: 'stock.reorder' }),
  stockItem: (itemId: number): DrillTarget => ({ screen: 'stock.item', params: { itemId } }),
  voucher: (id: number): DrillTarget => ({ screen: 'vouchers.view', params: { id } }),
  dayBook: (r: DateRange): DrillTarget => ({ screen: 'vouchers.daybook', params: { from: r.from, to: r.to } }),
  pdc: (): DrillTarget => ({ screen: 'banking.pdc' }),
  backup: (): DrillTarget => ({ screen: 'data.backup' }),
  dashboard: (): DrillTarget => ({ screen: 'dashboard.home' }),
  features: (): DrillTarget => ({ screen: 'company.features' }),
  profile: (): DrillTarget => ({ screen: 'company.profile' }),
  invoicePrinting: (): DrillTarget => ({ screen: 'print.settings' }),
  /** 2.0 Invoice Numbering screen (accounts module; absent until registered — the step is then left out). */
  invoiceNumbering: (): DrillTarget => ({ screen: 'accounts.numbering' }),
  backupSettings: (): DrillTarget => ({ screen: 'company.config', params: { tab: 'backup' } }),
  /** Ledger Creation under a group (reserved code, e.g. 'SUNDRY_DEBTORS'); Alt+C-style "Under" stays editable. */
  newLedger: (groupCode?: 'SUNDRY_DEBTORS' | 'SUNDRY_CREDITORS' | 'BANK_ACCOUNTS'): DrillTarget => ({ screen: 'accounts.ledger.form', params: groupCode ? { groupCode } : {} }),
  newItem: (): DrillTarget => ({ screen: 'inventory.item.form', params: {} }),
  xmlImport: (): DrillTarget => ({ screen: 'data.xmlImport' }),
} as const;

// ───────────────────────────── Alerts ─────────────────────────────

export type AlertTone = 'danger' | 'warning' | 'info';

export interface DashboardAlert {
  id: string;
  tone: AlertTone;
  icon: 'clock' | 'alert' | 'box' | 'receipt' | 'truck' | 'database' | 'gst' | 'calendar' | 'wallet' | 'bank';
  title: string;
  body: string;
  /** Screen the alert opens; null when the viewer may not open it (shown, but not clickable). */
  target: DrillTarget | null;
}

/** What the viewer may open (nav.canOpen: screen permission and feature). Default: everything. */
export interface AlertViewer {
  canOpen: (screen: string) => boolean;
}

/** Last backup older than this many days is flagged. */
export const BACKUP_WARN_DAYS = 7;
/** GST payment is flagged as urgent this many days before it is due. */
export const GST_URGENT_DAYS = 5;

const TONE_ORDER: Record<AlertTone, number> = { danger: 0, warning: 1, info: 2 };

/**
 * Things that need the owner's attention, most serious first. An alert whose screen the viewer may
 * not open stays (it is still true) but gets no target; the backup alerts then ask the viewer to
 * get the owner to back up instead of pointing at a screen they cannot use.
 */
export function buildAlerts(s: DashboardSummary, viewer: AlertViewer = { canOpen: () => true }): DashboardAlert[] {
  const out: DashboardAlert[] = [];
  const canBackup = viewer.canOpen(DRILL.backup().screen);
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
  // The return to pay next: last month's while it is still due, else this month's estimate so far.
  const gst = s.gstDue && s.gstDue.netPayable > 0 ? s.gstDue : s.gst && s.gst.netPayable > 0 ? s.gst : null;
  if (gst) {
    const days = diffDays(s.asOf, gst.dueDate);
    out.push({
      id: 'gst-due',
      tone: days <= GST_URGENT_DAYS ? 'warning' : 'info',
      icon: 'gst',
      // Home shows the title alone (the body is its tooltip): it says when, as the visible 2.0 body did.
      title: `GST of ${compact(gst.netPayable)} for ${gst.label} · ${dueText(gst.dueDate, s.asOf).toLowerCase()}`,
      body: `Estimated cash payment after input credit. ${gst.dueForm} is due by ${formatDate(gst.dueDate)}${days >= 0 ? ` (${dueText(gst.dueDate, s.asOf).toLowerCase()})` : ''}.`,
      target: DRILL.gstr3b(gst.period),
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
      target: s.lowStock.count === 1 && s.lowStock.items[0] ? DRILL.stockItem(s.lowStock.items[0].itemId) : DRILL.reorder(),
    });
  }
  const c = s.compliance;
  if (c.einvoicePending !== null && c.einvoicePending > 0) {
    out.push({
      id: 'einvoice-pending',
      tone: 'warning',
      icon: 'receipt',
      title: `${plural(c.einvoicePending, 'invoice')} without an e-Invoice`,
      body: 'Generate the IRN for these B2B / export invoices (Home › GST › e-Invoice).',
      target: DRILL.einvoice({ from: c.from, to: c.to }),
    });
  }
  if (c.ewayPending !== null && c.ewayPending > 0) {
    out.push({
      id: 'eway-pending',
      tone: 'warning',
      icon: 'truck',
      title: `${plural(c.ewayPending, 'invoice')} without an e-Way Bill`,
      body: 'Goods worth more than ₹50,000 need an e-Way Bill before they move.',
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
      body: canBackup
        ? 'Take a backup now and keep a copy on another drive or a pen drive.'
        : 'Ask the company owner to take a backup and keep a copy on another drive or a pen drive.',
      target: DRILL.backup(),
    });
  } else if (bk.daysSince !== null && bk.daysSince >= BACKUP_WARN_DAYS) {
    out.push({
      id: 'backup',
      tone: 'warning',
      icon: 'database',
      title: `Last backup was ${plural(bk.daysSince, 'day')} ago`,
      body: canBackup ? 'Back up at least once a week so you never lose your entries.' : 'Ask the company owner to back up — at least once a week.',
      target: DRILL.backup(),
    });
  }
  return out
    .map((a, i) => ({ a: a.target && !viewer.canOpen(a.target.screen) ? { ...a, target: null } : a, i }))
    .sort((x, y) => TONE_ORDER[x.a.tone] - TONE_ORDER[y.a.tone] || x.i - y.i)
    .map((x) => x.a);
}

// ───────────────────────────── GST card ─────────────────────────────

export interface GstCardItem {
  key: string;
  label: string;
  value: Paise;
  kind: 'amount';
  strong?: boolean;
}

/** Rows of one GST month on the card: tax on sales, ITC, reverse charge, cash to pay, credit left. */
export function gstItems(g: DashboardGst): GstCardItem[] {
  const items: GstCardItem[] = [
    { key: 'out', label: 'Tax on sales', value: g.outputTax, kind: 'amount' },
    { key: 'in', label: 'Input tax credit', value: g.inputTax, kind: 'amount' },
  ];
  if (g.reverseChargeTax !== 0) items.push({ key: 'rcm', label: 'Reverse charge (cash)', value: g.reverseChargeTax, kind: 'amount' });
  items.push({ key: 'pay', label: g.netPayable > 0 ? 'To pay in cash' : 'Nothing to pay in cash', value: g.netPayable, kind: 'amount', strong: true });
  if (g.creditCarriedForward > 0) items.push({ key: 'cf', label: 'Credit carried forward', value: g.creditCarriedForward, kind: 'amount' });
  return items;
}

/** 'GSTR-3B due by 20-Oct-2026 (due in 12 days)' / '… (3 days overdue)'. */
export function gstDueLine(g: DashboardGst, asOf: string): string {
  return `${g.dueForm} due by ${formatDate(g.dueDate)} (${dueText(g.dueDate, asOf).toLowerCase()})`;
}

// ───────────────────────────── Getting started ─────────────────────────────

export type StartStepId = 'profile' | 'features' | 'numbering' | 'printing' | 'ledgers' | 'items' | 'sale' | 'payment' | 'backup' | 'xmlImport';

/** A voucher to open with its F-key's checks (shell.openVoucher), instead of a screen. */
export type StartVoucherTarget = 'sales-voucher' | 'receipt-voucher';

/** The base type a voucher target opens. */
export const START_VOUCHER_BASE: Readonly<Record<StartVoucherTarget, 'sales' | 'receipt'>> = { 'sales-voucher': 'sales', 'receipt-voucher': 'receipt' };

export function isVoucherTarget(t: DrillTarget | StartVoucherTarget): t is StartVoucherTarget {
  return typeof t === 'string';
}

export interface StartStep {
  id: StartStepId;
  title: string;
  body: string;
  action: string;
  /** Screen to open, or a voucher (`sales-voucher` F8, `receipt-voucher` F6) opened by shell.openVoucher. */
  target: DrillTarget | StartVoucherTarget;
  shortcut?: string;
  /** Done — from the books (`setup`), or ticked by the user. Clicking the step never marks it. */
  done: boolean;
  /** Done because the books say so (the user cannot untick it). */
  doneFromBooks: boolean;
  /** Not counted in the progress (e.g. the XML data import). */
  optional?: boolean;
}

export interface StartStepsInput {
  manageCompany: boolean;
  createMasters: boolean;
  createVouchers: boolean;
  importData: boolean;
  inventory: boolean;
  /** nav.canOpen — a step whose screen the user may not open is left out. Default: everything. */
  canOpen?: (screen: string) => boolean;
  /** dashboard.summary `setup`; undefined while loading (nothing is done yet). */
  setup?: DashboardSetup;
  hasVouchers?: boolean;
  /** Steps the user ticked by hand ("Mark as done"), per company. */
  ticked?: readonly string[];
}

/**
 * The company's first steps — one list for the whole app (Home shows it through the dashboard):
 * company details, features, the invoice number series (2.0), what prints on the invoice, ledgers,
 * items, the first sale, the first payment received (2.0) and backups, plus the XML data import while
 * the books are empty. Filtered by what the user may do and open (a step whose screen is not
 * registered or not allowed is left out); each step is done when the books say so (`setup`) or when
 * the user ticked it.
 */
export function startSteps(o: StartStepsInput): StartStep[] {
  const canOpen = o.canOpen ?? (() => true);
  const f = o.setup;
  const ticked = new Set(o.ticked ?? []);
  const steps: StartStep[] = [];
  const add = (step: Omit<StartStep, 'done' | 'doneFromBooks'>, fromBooks: boolean | undefined): void => {
    if (!isVoucherTarget(step.target) && !canOpen(step.target.screen)) return;
    const books = fromBooks === true;
    steps.push({ ...step, doneFromBooks: books, done: books || ticked.has(step.id) });
  };
  if (o.manageCompany) {
    add({ id: 'profile', title: 'Check your company details', body: 'Address, GSTIN and logo appear on every invoice.', action: 'Company details', target: DRILL.profile() }, f?.profileComplete);
    add({ id: 'features', title: 'Switch on what you need', body: 'GST, inventory, bill-wise dues, godowns and more.', action: 'Features', target: DRILL.features(), shortcut: 'F11' }, f?.featuresReviewed);
    add(
      {
        id: 'numbering',
        title: 'Set your invoice number series',
        body: 'Prefix, starting number and a fresh series every financial year — e.g. INV/26-27/0001.',
        action: 'Invoice numbering',
        target: DRILL.invoiceNumbering(),
      },
      f?.numberingSet,
    );
    add(
      {
        id: 'printing',
        title: 'Choose what prints on your invoice',
        body: 'Template, logo, bank details, UPI QR code, declaration and terms — with a live preview.',
        action: 'Invoice printing',
        target: DRILL.invoicePrinting(),
      },
      f?.invoicePrintingSet,
    );
  }
  if (o.createMasters) {
    add({ id: 'ledgers', title: 'Add your customers, suppliers and bank', body: 'Enter opening balances so dues and bank balances start right.', action: 'Create ledger', target: DRILL.newLedger('SUNDRY_DEBTORS') }, f?.hasOwnLedgers);
    if (o.inventory) add({ id: 'items', title: 'Add the items you sell', body: 'With GST rate, HSN and opening stock.', action: 'Create stock item', target: DRILL.newItem() }, f?.hasItems);
  }
  if (o.createVouchers) {
    add({ id: 'sale', title: 'Record your first sale', body: 'Sales, dues, cash and GST then appear here.', action: 'Sales invoice', target: 'sales-voucher', shortcut: 'F8' }, f?.hasSales);
    add(
      { id: 'payment', title: 'Record a payment', body: 'When a customer pays you, enter the receipt so “To collect” stays right.', action: 'Receipt', target: 'receipt-voucher', shortcut: 'F6' },
      f?.hasReceipts,
    );
  }
  if (o.manageCompany) {
    add({ id: 'backup', title: 'Set up backups', body: 'Choose a backup folder — ideally on another drive or a USB disk.', action: 'Backup settings', target: DRILL.backupSettings() }, f?.backupFolderSet);
  }
  if (o.importData && !o.hasVouchers) {
    add({ id: 'xmlImport', title: 'Moving from another accounting program?', body: 'Bring your masters and vouchers across in one go from its XML export.', action: 'Import from XML', target: DRILL.xmlImport(), optional: true }, false);
  }
  return steps;
}

export interface StartProgress {
  done: number;
  total: number;
  complete: boolean;
}

/** Progress over the steps that count (optional ones excluded). */
export function startProgress(steps: readonly StartStep[]): StartProgress {
  const counted = steps.filter((x) => !x.optional);
  const done = counted.filter((x) => x.done).length;
  return { done, total: counted.length, complete: done === counted.length };
}

/**
 * What the dashboard shows for getting started — with or without vouchers (the guidance no longer
 * vanishes at the first sale): the steps until every counted step is done or the user hid the card.
 * With no steps the user can take and no vouchers yet: a short "nothing recorded yet".
 */
export function startCardMode(steps: readonly StartStep[], o: { hidden: boolean; hasVouchers: boolean }): 'steps' | 'empty' | null {
  if (steps.length === 0) return o.hasVouchers ? null : 'empty';
  if (o.hidden) return null;
  const p = startProgress(steps);
  if (p.total === 0) return o.hasVouchers ? null : 'steps'; // only optional steps (XML data import)
  return p.complete ? null : 'steps';
}

/**
 * "Show Get started" (dashboard rail Alt+S, Gateway panel button): offered when the user hid the card
 * and it would show again — undoing Hide. Nothing to offer when every step is done anyway.
 */
export function canShowStartCard(steps: readonly StartStep[], o: { hidden: boolean; hasVouchers: boolean }): boolean {
  return o.hidden && startCardMode(steps, { hidden: false, hasVouchers: o.hasVouchers }) !== null;
}

/** Per-company "Get started" preferences kept in the browser (localStorage). */
export interface StartPrefs {
  hidden: boolean;
  ticked: string[];
}

export const startPrefsKey = (companyId: string): string => `pevqori.dashboard.start.${companyId}`;

export function parseStartPrefs(raw: string | null | undefined): StartPrefs {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<StartPrefs>) : {};
    return { hidden: p.hidden === true, ticked: Array.isArray(p.ticked) ? p.ticked.filter((x): x is string => typeof x === 'string') : [] };
  } catch {
    return { hidden: false, ticked: [] };
  }
}

export function toggleTicked(prefs: StartPrefs, id: string, on: boolean): StartPrefs {
  const ticked = prefs.ticked.filter((x) => x !== id);
  return { ...prefs, ticked: on ? [...ticked, id] : ticked };
}

// ───────────────────────────── Home panel (2.1) ─────────────────────────────

/** One of Home's three figures: To collect, To pay, Cash & bank (SPEC-21 §1.3, D10). */
export interface HomeFigure {
  id: 'collect' | 'pay' | 'cashBank';
  /** Relabelled instead of a minus sign when the figure is negative ('Advances from customers'). */
  label: string;
  /** Never negative (see label). */
  value: Paise;
  /** At most one caption, and only when it asks for action ('₹4.66 L overdue'); null otherwise. */
  caption: string | null;
  /** The quieter facts (who is overdue, what falls due, the cash / bank split) — the figure's tooltip. */
  tooltip: string;
  /** Where the figure drills (nav.canOpen still decides whether it is clickable). */
  target: DrillTarget;
  /** Alert ids (buildAlerts) the caption already says — "Needs your attention" leaves them out. */
  covers: string[];
}

/**
 * Home's three figures, in this order: who owes you, whom you owe, the money you have. To collect is
 * the net outstanding (bills + advances + on account); when what is overdue is more than that, the
 * caption reconciles it: '₹4.66 L overdue · ₹3.66 L not matched' (advances and on-account receipts not
 * yet matched to bills).
 */
export function homeFigures(s: DashboardSummary): HomeFigure[] {
  const r = s.receivables;
  const p = s.payables;
  const collect = signedKpi('To collect', r.total, 'Advances from customers');
  const pay = signedKpi('To pay', p.total, 'Advances to suppliers');
  const money = signedKpi('Cash & bank', s.cashBank.cashTotal + s.cashBank.bankTotal, 'Cash & bank (overdrawn)');
  const unmatched = Math.abs(r.advance + r.onAccount);
  const collectCaption = r.overdue > 0 ? (r.overdue > r.total && unmatched > 0 ? `${compact(r.overdue)} overdue · ${compact(unmatched)} not matched` : `${compact(r.overdue)} overdue`) : null;
  const overdrawn = s.cashBank.banks.filter((b) => !b.isOverdraft && b.balance < 0);
  let cashCaption: string | null = null;
  let cashCovers: string[] = [];
  if (s.cashBank.cashTotal < 0) {
    cashCaption = 'Cash in hand is negative';
    cashCovers = ['cash-negative'];
  } else if (overdrawn.length > 0) {
    cashCaption = overdrawn.length === 1 ? `${overdrawn[0].name} overdrawn` : `${overdrawn.length} banks overdrawn`;
    cashCovers = overdrawn.map((b) => `bank-overdrawn-${b.ledgerId}`);
  }
  return [
    {
      id: 'collect',
      label: collect.label,
      value: collect.value,
      caption: collectCaption,
      tooltip: r.overdue > 0 ? `${compact(r.overdue)} overdue from ${plural(r.overduePartyCount, 'customer')} · ${compact(r.notDue)} not yet due` : `Nothing overdue · ${plural(r.partyCount, 'customer')}`,
      target: DRILL.receivables(),
      covers: r.overdue > 0 ? ['receivables-overdue'] : [],
    },
    {
      id: 'pay',
      label: pay.label,
      value: pay.value,
      caption: p.overdue > 0 ? `${compact(p.overdue)} overdue` : null,
      tooltip: p.dueSoon.count > 0 ? `${compact(p.dueSoon.amount)} due in ${p.dueSoon.days} days` : `Nothing due in ${p.dueSoon.days} days`,
      target: DRILL.payables(),
      covers: p.overdue > 0 ? ['payables-overdue'] : [],
    },
    { id: 'cashBank', label: money.label, value: money.value, caption: cashCaption, tooltip: cashBankCaption(s.cashBank), target: DRILL.cashBank(balanceRange(s)), covers: cashCovers },
  ];
}

/** Home's graph (§1.3): "Sales — last 12 months", the working-date month emphasised. */
export interface HomeSalesGraph {
  title: string;
  /** 'Apr' … 'Oct' — ticks and option names (≤ 12, so a name never repeats). */
  months: string[];
  /** 'YYYY-MM' of each column. */
  keys: string[];
  /** trend[i].sales (net movement of the Sales Accounts), paise. */
  values: number[];
  /** The column of the working-date month (slot 1), or null when that month is not in the series. */
  emphasis: number | null;
  /** Its direct label: '₹35.8 K so far'. */
  label: string;
  /** The header's answer: '₹35.8 K so far in Oct · ▲ 12 % vs 1–10 Oct 2025'. */
  takeaway: string;
  /** Σ values (what the columns add up to). */
  total: number;
}

export const HOME_GRAPH_TITLE = 'Sales — last 12 months';

/** '1–10 Oct 2025' (or '1 Oct 2025' for one day). */
function dayRange(r: DateRange): string {
  const d1 = Number(r.from.slice(8, 10));
  const d2 = Number(r.to.slice(8, 10));
  const tail = `${MONTH_NAMES[Number(r.to.slice(5, 7)) - 1] ?? ''} ${r.to.slice(0, 4)}`;
  return r.from === r.to ? `${d1} ${tail}` : `${d1}–${d2} ${tail}`;
}

/**
 * One column per month of `s.trend` from the month the books begin (or eleven months before the
 * working-date month, whichever is later) to the working-date month — at least 3 months, else null
 * (no graph, no Ctrl+J). The drawn value is `trend[i].sales`; the label and the takeaway use
 * `sales.mtd` (1st of the month → the working date) and compare it with the same days a year earlier.
 */
export function homeSalesGraph(s: DashboardSummary): HomeSalesGraph | null {
  const end = s.asOf.slice(0, 7);
  const first = s.booksFrom.slice(0, 7);
  const window = (() => {
    const y = Number(end.slice(0, 4));
    const m = Number(end.slice(5, 7)) - 11;
    const back = m <= 0 ? `${y - 1}-${String(m + 12).padStart(2, '0')}` : `${y}-${String(m).padStart(2, '0')}`;
    return back > first ? back : first;
  })();
  const shown = s.trend.filter((t) => t.month >= window && t.month <= end);
  // Nothing sold yet (a new company): an empty plot says nothing — no graph, as on every report.
  if (shown.length < 3 || shown.every((t) => t.sales === 0)) return null;
  const emphasisAt = shown.findIndex((t) => t.month === end);
  const emphasis = emphasisAt >= 0 ? emphasisAt : null;
  const running = s.asOf !== endOfMonth(s.asOf);
  const monthName = MONTH_NAMES[Number(end.slice(5, 7)) - 1] ?? end;
  const now = `${compactSigned(s.sales.mtd, 'net returns')}${running ? ' so far' : ''}`;
  const last = s.sales.lastYear.mtd;
  const delta = deltaPercent(s.sales.mtd, last);
  const range = dayRange(s.ranges.lastYear.mtd);
  // No books for last year's range (a first-year company): nothing to compare with, so no comparison.
  const vs =
    s.ranges.lastYear.mtd.to < s.booksFrom
      ? ''
      : last === 0
        ? `${range}: nothing`
        : delta === null || Math.round(delta) === 0
          ? `same as ${range}`
          : `${delta > 0 ? '▲' : '▼'} ${Math.abs(Math.round(delta))} % vs ${range}`;
  const values = shown.map((t) => t.sales);
  return {
    title: HOME_GRAPH_TITLE,
    months: shown.map((t) => MONTH_NAMES[Number(t.month.slice(5, 7)) - 1] ?? t.month),
    keys: shown.map((t) => t.month),
    values,
    emphasis,
    label: emphasis === null ? '' : now,
    takeaway: clipTakeaway(vs ? `${now} in ${monthName} · ${vs}` : `${now} in ${monthName}`),
    total: values.reduce((a, b) => a + b, 0),
  };
}

/**
 * Where a Home column drills: the Sales Accounts monthly summary over that month's financial year
 * (never before the books begin), with that month's row active — the same ledger movement the column
 * draws (core tie-out, reports/tieouts.test.ts). `upTo` (Home's balances date): the summary of the
 * year it falls in ends there, as the graph does — the running month's row is its "so far" column.
 */
export function homeSalesDrill(month: string, booksFrom: string, groupId: number, fyStartMonth = 4, upTo?: string): DrillTarget {
  const fy = financialYear(`${month}-01`, fyStartMonth);
  const to = upTo !== undefined && upTo >= `${month}-01` && upTo < fy.end ? upTo : fy.end;
  return { screen: 'reports.monthlySummary', params: { groupId, from: fy.start < booksFrom ? booksFrom : fy.start, to, month } };
}

/** Rows of "Needs your attention" on Home before "N more". */
export const HOME_ALERTS_SHOWN = 3;

/**
 * "Needs your attention" on Home: the alerts, minus what a figure's caption already says, and minus
 * the backup alert while the Setup line is showing with its backup step still open (D10).
 */
export function homeAlerts(s: DashboardSummary, o: { viewer?: AlertViewer; figures?: readonly HomeFigure[]; setupBackupOpen?: boolean } = {}): DashboardAlert[] {
  const covered = new Set((o.figures ?? homeFigures(s)).flatMap((f) => f.covers));
  if (o.setupBackupOpen) covered.add('backup');
  return buildAlerts(s, o.viewer).filter((a) => !covered.has(a.id));
}

/** The Setup line (D11): 'Setup 4 of 9 · Next: Choose what prints on your invoice'. */
export interface SetupLine {
  done: number;
  total: number;
  /** The first step not done (counted steps first, then an optional one). */
  next: StartStep | null;
  /** The backup step is listed and not done (the backup alert then stays out of Home's list). */
  backupOpen: boolean;
}

export function setupLine(steps: readonly StartStep[]): SetupLine {
  const p = startProgress(steps);
  const next = steps.find((x) => !x.done && !x.optional) ?? steps.find((x) => !x.done) ?? null;
  return { done: p.done, total: p.total, next, backupOpen: steps.some((x) => x.id === 'backup' && !x.done) };
}

/** What the Home panel shows, top to bottom (each part hides itself when it has nothing to say). */
export const HOME_PANEL: readonly string[] = ['period', 'figures', 'graph', 'attention', 'setup', 'fullDashboard'];

// ───────────────────────────── Full Dashboard (2.1) ─────────────────────────────

/** One quiet line standing for a card of the full Dashboard ("Show all cards" shows the cards). */
export interface CardLine {
  id: 'cashBank' | 'gst' | 'topCustomer' | 'topItem' | 'lowStock' | 'postDated' | 'recent';
  title: string;
  text: string;
  link: string;
  target: DrillTarget;
}

/** The secondary cards as one line each, in card order; a card with nothing to say has no line. */
export function cardLines(s: DashboardSummary): CardLine[] {
  const out: CardLine[] = [];
  out.push({ id: 'cashBank', title: 'Cash & bank', text: cashBankCaption(s.cashBank), link: 'Cash/Bank books', target: DRILL.cashBank(balanceRange(s)) });
  const g = s.gstDue ?? s.gst;
  if (g) {
    out.push({
      id: 'gst',
      title: 'GST',
      text: `${g.label}: ${g.netPayable > 0 ? `${compact(g.netPayable)} to pay in cash` : 'nothing to pay in cash'} · ${gstDueLine(g, s.asOf)}`,
      link: g.dueForm,
      target: DRILL.gstr3b(g.period),
    });
  }
  const c = s.topCustomers[0];
  if (c) out.push({ id: 'topCustomer', title: 'Top customer', text: `${c.name} ${compact(c.amount)}${c.sharePercent === null ? '' : ` · ${Math.round(c.sharePercent)} % of sales`}`, link: 'Ledger', target: DRILL.ledger(c.ledgerId, s.ranges.period) });
  if (s.features.inventory) {
    const i = s.topItems[0];
    if (i) out.push({ id: 'topItem', title: 'Top item', text: `${i.name} ${compact(i.amount)}${i.sharePercent === null ? '' : ` · ${Math.round(i.sharePercent)} % of sales`}`, link: 'Stock item', target: DRILL.stockItem(i.itemId) });
    out.push({ id: 'lowStock', title: 'Low stock', text: s.lowStock.count > 0 ? `${plural(s.lowStock.count, 'item')} below the reorder level` : 'Stock levels are fine', link: 'Reorder status', target: DRILL.reorder() });
  }
  if (s.postDated.count > 0) out.push({ id: 'postDated', title: 'Post-dated cheques', text: `To receive ${compact(s.postDated.inflow)} · to pay ${compact(s.postDated.outflow)}`, link: 'All cheques', target: DRILL.pdc() });
  // The Day Book of the voucher's own date: the last voucher entered may be dated any day.
  const v = s.recentVouchers[0];
  if (v) out.push({ id: 'recent', title: 'Last entry', text: `${v.typeName}${v.number ? ` ${v.number}` : ''}${v.partyName ? ` · ${v.partyName}` : ''} · ${exact(v.amount)}`, link: 'Day Book', target: DRILL.dayBook({ from: v.date, to: v.date }) });
  return out;
}

/** The full Dashboard's four figures (§5): Sales (▲ % vs last year), Gross profit (margin %), Receivables, Cash & bank. */
export const DASHBOARD_FIGURES: readonly string[] = ['Sales', 'Gross profit', 'Receivables', 'Cash & bank'];

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
  rows.push([s.receivables.total < 0 ? 'Receivables (net advance from customers)' : 'Receivables', Math.abs(s.receivables.total), null, null]);
  rows.push(['Receivables overdue', s.receivables.overdue, null, null]);
  rows.push([s.payables.total < 0 ? 'Payables (net advance to suppliers)' : 'Payables', Math.abs(s.payables.total), null, null]);
  rows.push([`Payables due in ${s.payables.dueSoon.days} days`, s.payables.dueSoon.amount, null, null]);
  // Balances: never a bare minus in an accounting report — a credit balance is labelled instead.
  rows.push([s.cashBank.cashTotal < 0 ? 'Cash in hand (Cr balance)' : 'Cash in hand', Math.abs(s.cashBank.cashTotal), null, null]);
  for (const b of s.cashBank.banks) rows.push([`${b.name}${b.balance < 0 ? (b.isOverdraft ? ' (overdraft used)' : ' (overdrawn, Cr)') : ''}`, Math.abs(b.balance), null, null]);
  if (s.gstDue) {
    rows.push([`GST output tax — ${s.gstDue.label}`, s.gstDue.outputTax, null, null]);
    rows.push([`GST input credit — ${s.gstDue.label}`, s.gstDue.inputTax, null, null]);
    rows.push([`GST payable — ${s.gstDue.label} — due ${formatDate(s.gstDue.dueDate)}`, s.gstDue.netPayable, null, null]);
  }
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
    notes: `Period ${formatDate(s.ranges.period.from)} to ${formatDate(s.ranges.period.to)}. Balances as on ${formatDate(s.asOf)}. Sales and purchases are net of returns and exclude GST.`,
  };
}

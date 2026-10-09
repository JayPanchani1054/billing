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
  DashboardGst,
  DashboardMonth,
  DashboardSetup,
  DashboardSummary,
  DashboardSummaryInput,
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
  backupSettings: (): DrillTarget => ({ screen: 'company.config', params: { tab: 'backup' } }),
  newLedger: (): DrillTarget => ({ screen: 'accounts.ledger.form', params: {} }),
  newItem: (): DrillTarget => ({ screen: 'inventory.item.form', params: {} }),
  tally: (): DrillTarget => ({ screen: 'data.tally' }),
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
      title: `GST of ${compact(gst.netPayable)} for ${gst.label}`,
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
      body: 'Generate the IRN for these B2B / export invoices (Gateway › GST › e-Invoice).',
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

export type StartStepId = 'profile' | 'features' | 'printing' | 'ledgers' | 'items' | 'sale' | 'backup' | 'tally';

export interface StartStep {
  id: StartStepId;
  title: string;
  body: string;
  action: string;
  /** Screen to open, or `sales-voucher` for the sales invoice (shell.openVoucher). */
  target: DrillTarget | 'sales-voucher';
  shortcut?: string;
  /** Done — from the books (`setup`), or ticked by the user. Clicking the step never marks it. */
  done: boolean;
  /** Done because the books say so (the user cannot untick it). */
  doneFromBooks: boolean;
  /** Not counted in the progress (e.g. migrating from Tally). */
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
 * The company's first steps — one list for the whole app (the Gateway shows it through the
 * dashboard): company details, features, invoice printing, ledgers, items, the first sale and
 * backups, plus the Tally migration while the books are empty. Filtered by what the user may do
 * and open; each step is done when the books say so (`setup`) or when the user ticked it.
 */
export function startSteps(o: StartStepsInput): StartStep[] {
  const canOpen = o.canOpen ?? (() => true);
  const f = o.setup;
  const ticked = new Set(o.ticked ?? []);
  const steps: StartStep[] = [];
  const add = (step: Omit<StartStep, 'done' | 'doneFromBooks'>, fromBooks: boolean | undefined): void => {
    if (step.target !== 'sales-voucher' && !canOpen(step.target.screen)) return;
    const books = fromBooks === true;
    steps.push({ ...step, doneFromBooks: books, done: books || ticked.has(step.id) });
  };
  if (o.manageCompany) {
    add({ id: 'profile', title: 'Check your company details', body: 'Address, GSTIN and logo appear on every invoice.', action: 'Company details', target: DRILL.profile() }, f?.profileComplete);
    add({ id: 'features', title: 'Switch on what you need', body: 'GST, inventory, bill-wise dues, godowns and more.', action: 'Features', target: DRILL.features(), shortcut: 'F11' }, f?.featuresReviewed);
    add(
      { id: 'printing', title: 'Set up invoice printing', body: 'Template, bank details, UPI QR code and declaration — with a preview.', action: 'Invoice printing', target: DRILL.invoicePrinting() },
      f?.invoicePrintingSet,
    );
  }
  if (o.createMasters) {
    add({ id: 'ledgers', title: 'Add your customers, suppliers and bank', body: 'Enter opening balances so dues and bank balances start right.', action: 'Create ledger', target: DRILL.newLedger() }, f?.hasOwnLedgers);
    if (o.inventory) add({ id: 'items', title: 'Add the items you sell', body: 'With GST rate, HSN and opening stock.', action: 'Create stock item', target: DRILL.newItem() }, f?.hasItems);
  }
  if (o.createVouchers) {
    add({ id: 'sale', title: 'Record your first sale', body: 'Sales, dues, cash and GST then appear here.', action: 'Sales invoice', target: 'sales-voucher', shortcut: 'F8' }, f?.hasSales);
  }
  if (o.manageCompany) {
    add({ id: 'backup', title: 'Set up backups', body: 'Choose a backup folder — ideally on another drive or a USB disk.', action: 'Backup settings', target: DRILL.backupSettings() }, f?.backupFolderSet);
  }
  if (o.importData && !o.hasVouchers) {
    add({ id: 'tally', title: 'Moving from Tally?', body: 'Bring your masters and vouchers across in one go.', action: 'Migrate from Tally', target: DRILL.tally(), optional: true }, false);
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
  if (p.total === 0) return o.hasVouchers ? null : 'steps'; // only optional steps (Tally migration)
  return p.complete ? null : 'steps';
}

/** Per-company "Get started" preferences kept in the browser (localStorage). */
export interface StartPrefs {
  hidden: boolean;
  ticked: string[];
}

export const startPrefsKey = (companyId: string): string => `bahi.dashboard.start.${companyId}`;

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

/**
 * 'dashboard.summary' — every figure on the Gateway dashboard in one read-only call.
 *
 * Built from a handful of aggregate queries (each on a covering index) plus the shared engines:
 *   - sales / purchases / direct incomes & expenses: ONE query over ledger_entries (idx_le_books)
 *     for all eight ranges (today, MTD, YTD, period × this year / last year);
 *   - 12-month trend: one GROUP BY month over the same ledgers;
 *   - receivables / payables: outstanding/reports.ts `sideParties` (the Receivables screen's engine,
 *     FIFO for ledgers not maintained bill-wise — so the dashboard and the drill-down agree);
 *   - cash / bank: accounts/books.ts `closingBalances`;
 *   - gross profit: inventory valuation (opening + closing stock in ONE replay) when integrated;
 *   - GST: gst/gstr3b.ts `computeGstr3b` for the month of `asOf` (the GSTR-3B screen's figures);
 *   - last backup: data/backup.ts `lastBackupAt`.
 * Money is integer paise; see README.md for every rule.
 */
import { addDays, endOfMonth, financialYear, formatMonth, maxDate, minDate, monthKey, monthsBetween, startOfMonth } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type { Permission, VoucherBaseType } from '../../../shared/constants.ts';
import type {
  DashboardAgeingBucket,
  DashboardBackup,
  DashboardBalanceRow,
  DashboardCashBank,
  DashboardCompliance,
  DashboardFeatures,
  DashboardFlow,
  DashboardGrossProfit,
  DashboardGst,
  DashboardLowStockItem,
  DashboardMonth,
  DashboardOutstanding,
  DashboardPdc,
  DashboardRanges,
  DashboardSummary,
  DashboardSummaryInput,
  DashboardTopCustomer,
  DashboardTopItem,
  DashboardVoucherRow,
  DateRange,
  FlowSet,
} from '../../../shared/types/dashboard.ts';
import type { OutstandingSide } from '../../../shared/types/outstanding.ts';
import type { CompanyCtx, Session } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { BOOKS_FILTER, closingBalances, loadGroupTree, type GroupTree } from '../accounts/books.ts';
import { getConfig, getFeatures } from '../company/service.ts';
import { lastBackupAt } from '../data/backup.ts';
import { loadCompany, loadDocs } from '../gst/docs.ts';
import { computeGstr3b } from '../gst/gstr3b.ts';
import { monthPeriodKey, parsePeriodKey } from '../gst/period.ts';
import { computeStockValuation, stockByItem } from '../inventory/index.ts';
import { billAge, bucketIndex, makeBuckets } from '../outstanding/ageing.ts';
import { overdueDays, sideSign } from '../outstanding/engine.ts';
import { sideParties } from '../outstanding/reports.ts';
import { comparePeriod } from '../reports/financials.ts';

/** Bills falling due within this many days count as "due soon". */
export const DUE_SOON_DAYS = 7;
export const TOP_N = 5;
export const RECENT_N = 8;
export const PDC_N = 10;
export const LOW_STOCK_N = 10;

// ───────────────────────────── Ranges ─────────────────────────────

/** Today / MTD / YTD / period ranges for `asOf` and the same ranges a year earlier. Pure. */
export function dashboardRanges(input: DashboardSummaryInput, fyStartMonth: number, booksFrom: string): DashboardRanges {
  const { asOf } = input;
  const fyStart = financialYear(asOf, fyStartMonth).start;
  const today: DateRange = { from: asOf, to: asOf };
  const mtd: DateRange = { from: startOfMonth(asOf), to: asOf };
  const ytd: DateRange = { from: fyStart < booksFrom && booksFrom <= asOf ? booksFrom : fyStart, to: asOf };
  const period: DateRange = { from: input.from, to: input.to };
  const ly = (r: DateRange): DateRange => comparePeriod(r.from, r.to, 'previous_year');
  return { today, mtd, ytd, period, lastYear: { today: ly(today), mtd: ly(mtd), ytd: ly(ytd), period: ly(period) } };
}

const RANGE_KEYS = ['today', 'mtd', 'ytd', 'period'] as const;

// ───────────────────────────── Ledger classification ─────────────────────────────

type TradingKind = 's' | 'p' | 'di' | 'de';

interface LedgerRow {
  id: number;
  name: string;
  group_id: number;
  opening_balance: number;
  bank_account_no: string | null;
}

interface Classified {
  /** Trading ledgers by kind: Sales Accounts, Purchase Accounts, other direct incomes / expenses. */
  trading: Map<TradingKind, number[]>;
  tradingOpening: Map<TradingKind, Paise>;
  cash: LedgerRow[];
  banks: Array<LedgerRow & { od: boolean }>;
  cashBankIds: number[];
}

function classify(ledgers: readonly LedgerRow[], tree: GroupTree): Classified {
  const salesId = [...tree.byId.values()].find((g) => g.reservedCode === 'SALES_ACCOUNTS')?.id;
  const purchaseId = [...tree.byId.values()].find((g) => g.reservedCode === 'PURCHASE_ACCOUNTS')?.id;
  const trading = new Map<TradingKind, number[]>([['s', []], ['p', []], ['di', []], ['de', []]]);
  const tradingOpening = new Map<TradingKind, Paise>([['s', 0], ['p', 0], ['di', 0], ['de', 0]]);
  const cash: LedgerRow[] = [];
  const banks: Array<LedgerRow & { od: boolean }> = [];
  for (const l of ledgers) {
    const g = tree.byId.get(l.group_id);
    if (!g) continue;
    const primary = tree.byId.get(g.primaryId);
    let kind: TradingKind | null = null;
    if (salesId !== undefined && g.primaryId === salesId) kind = 's';
    else if (purchaseId !== undefined && g.primaryId === purchaseId) kind = 'p';
    else if (primary && primary.affectsGrossProfit && primary.nature === 'income') kind = 'di';
    else if (primary && primary.affectsGrossProfit && primary.nature === 'expenses') kind = 'de';
    if (kind) {
      (trading.get(kind) as number[]).push(l.id);
      tradingOpening.set(kind, (tradingOpening.get(kind) ?? 0) + l.opening_balance);
    }
    if (g.cls.isCash) cash.push(l);
    else if (g.cls.isBank) banks.push({ ...l, od: g.cls.isBankOd });
  }
  return { trading, tradingOpening, cash, banks, cashBankIds: [...cash.map((l) => l.id), ...banks.map((l) => l.id)] };
}

// ───────────────────────────── Flows ─────────────────────────────

interface FlowSums {
  /** Dr-signed Σ per kind per range key ('today', 'ly_today', …). */
  [kind: string]: Record<string, Paise>;
}

function flowSums(db: Db, cls: Classified, r: DashboardRanges, today: string): FlowSums {
  const ranges: Array<[string, DateRange]> = [];
  for (const k of RANGE_KEYS) {
    ranges.push([k, r[k]]);
    ranges.push([`ly_${k}`, r.lastYear[k]]);
  }
  const params: Record<string, string> = { today };
  const cols: string[] = [];
  ranges.forEach(([key, range], i) => {
    params[`f${i}`] = range.from;
    params[`t${i}`] = range.to;
    // Column aliases are fixed identifiers from RANGE_KEYS (never user input).
    cols.push(`SUM(CASE WHEN le.date >= :f${i} AND le.date <= :t${i} THEN le.amount ELSE 0 END) AS ${key}`);
  });
  params.minFrom = ranges.reduce((m, [, x]) => minDate(m, x.from), ranges[0][1].from);
  params.maxTo = ranges.reduce((m, [, x]) => maxDate(m, x.to), ranges[0][1].to);
  for (const k of ['s', 'p', 'di', 'de'] as const) params[`ids_${k}`] = JSON.stringify(cls.trading.get(k) ?? []);

  const out: FlowSums = {};
  for (const k of ['s', 'p', 'di', 'de']) out[k] = Object.fromEntries(ranges.map(([key]) => [key, 0]));
  const rows = db.all<Record<string, number | string | null>>(
    `WITH k(id, kind) AS (
       SELECT value, 's' FROM json_each(:ids_s) UNION ALL SELECT value, 'p' FROM json_each(:ids_p)
       UNION ALL SELECT value, 'di' FROM json_each(:ids_di) UNION ALL SELECT value, 'de' FROM json_each(:ids_de)
     )
     SELECT k.kind AS kind, ${cols.join(', ')}
       FROM k JOIN ledger_entries le ON le.ledger_id = k.id
      WHERE le.date >= :minFrom AND le.date <= :maxTo AND ${BOOKS_FILTER('le')}
      GROUP BY k.kind`,
    params,
  );
  for (const row of rows) {
    const kind = String(row.kind);
    for (const [key] of ranges) out[kind][key] = Number(row[key] ?? 0);
  }
  return out;
}

/** Side-natural flow: sales/incomes are credits (−), purchases/expenses debits (+). */
function toFlow(sums: Record<string, Paise>, sign: 1 | -1): DashboardFlow {
  const pick = (prefix: string): FlowSet => ({
    today: nz(sign * sums[`${prefix}today`]),
    mtd: nz(sign * sums[`${prefix}mtd`]),
    ytd: nz(sign * sums[`${prefix}ytd`]),
    period: nz(sign * sums[`${prefix}period`]),
  });
  return { ...pick(''), lastYear: pick('ly_') };
}

/** Avoid -0 in JSON. */
const nz = (n: number): number => (n === 0 ? 0 : n);

function trendMonths(db: Db, cls: Classified, to: string, today: string): DashboardMonth[] {
  // 12 calendar months ending with the month of `to`.
  const lastMonthStart = startOfMonth(to);
  const from = shiftMonths(lastMonthStart, -11);
  const months = monthsBetween(from, lastMonthStart);
  const until = endOfMonth(lastMonthStart);
  const byMonth = new Map<string, { s: number; p: number }>(months.map((m) => [m, { s: 0, p: 0 }]));
  for (const r of db.all<{ m: string; kind: string; amt: number }>(
    `WITH k(id, kind) AS (SELECT value, 's' FROM json_each(:s) UNION ALL SELECT value, 'p' FROM json_each(:p))
     SELECT substr(le.date, 1, 7) AS m, k.kind AS kind, SUM(le.amount) AS amt
       FROM k JOIN ledger_entries le ON le.ledger_id = k.id
      WHERE le.date >= :from AND le.date <= :until AND ${BOOKS_FILTER('le')}
      GROUP BY m, k.kind`,
    { s: JSON.stringify(cls.trading.get('s') ?? []), p: JSON.stringify(cls.trading.get('p') ?? []), from, until, today },
  )) {
    const slot = byMonth.get(r.m);
    if (!slot) continue;
    if (r.kind === 's') slot.s = nz(-r.amt);
    else slot.p = nz(r.amt);
  }
  return months.map((m) => {
    const f = `${m}-01`;
    const v = byMonth.get(m) as { s: number; p: number };
    return { month: m, from: f, to: endOfMonth(f), sales: v.s, purchases: v.p };
  });
}

/** First day of the month `n` months away from a month start. */
function shiftMonths(monthStart: string, n: number): string {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7));
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

// ───────────────────────────── Gross profit ─────────────────────────────

function grossProfit(db: Db, sums: FlowSums, cls: Classified, period: DateRange, booksFrom: string, integrated: boolean, today: string): DashboardGrossProfit {
  // Nominal opening balances belong to the first P&L (a company that starts its books mid-year enters
  // year-to-date figures as openings) — exactly as reports' nominalMovement does.
  const withOb = period.from <= booksFrom && booksFrom <= period.to;
  const ob = (k: TradingKind): Paise => (withOb ? (cls.tradingOpening.get(k) ?? 0) : 0);
  const sales = nz(-(sums.s.period + ob('s')));
  const purchases = nz(sums.p.period + ob('p'));
  const directIncomes = nz(-(sums.di.period + ob('di')));
  const directExpenses = nz(sums.de.period + ob('de'));
  let openingStock: Paise | null = null;
  let closingStock: Paise | null = null;
  if (integrated) {
    const v = computeStockValuation(db, { from: period.from, to: period.to, today });
    openingStock = v.totals.openingValue;
    closingStock = v.totals.closingValue;
  }
  const costOfSales = (openingStock ?? 0) + purchases + directExpenses - (closingStock ?? 0);
  const amount = sales + directIncomes - costOfSales;
  return {
    method: integrated ? 'stock_valuation' : 'purchases',
    sales,
    purchases,
    directIncomes,
    directExpenses,
    openingStock,
    closingStock,
    costOfSales: nz(costOfSales),
    amount: nz(amount),
    marginPercent: sales === 0 ? null : Math.round((amount / sales) * 10_000) / 100,
  };
}

// ───────────────────────────── Outstanding ─────────────────────────────

/** Receivables / payables from the outstanding engine (FIFO for non-bill-wise ledgers, like the screens). */
export function outstandingFigures(db: Db, today: string, side: OutstandingSide, asOf: string, dueDays = DUE_SOON_DAYS): DashboardOutstanding {
  const sign = sideSign(side);
  const buckets = makeBuckets(undefined, 'due_date');
  const amounts = buckets.map(() => 0);
  const until = addDays(asOf, dueDays);
  const out: DashboardOutstanding = {
    total: 0,
    overdue: 0,
    overdueBillCount: 0,
    overduePartyCount: 0,
    notDue: 0,
    advance: 0,
    onAccount: 0,
    partyCount: 0,
    ageing: [],
    dueSoon: { days: dueDays, until, amount: 0, count: 0 },
  };
  for (const p of sideParties(db, today, { side, asOf, nonBillWise: 'fifo' })) {
    if (p.balance === 0 && p.bills.length === 0) continue;
    out.partyCount += 1;
    out.total += p.balance * sign;
    out.onAccount += p.onAccount * sign;
    let partyOverdue = false;
    for (const b of p.bills) {
      const amt = b.pending * sign;
      const age = billAge(b, asOf, 'due_date');
      if (age === null) {
        if (b.refType === 'advance') out.advance += amt;
        else out.onAccount += amt;
        continue;
      }
      amounts[bucketIndex(age, buckets)] += amt;
      if (overdueDays(b, asOf) > 0) {
        out.overdue += amt;
        out.overdueBillCount += 1;
        partyOverdue = true;
      } else {
        out.notDue += amt;
        if (amt > 0 && b.dueDate && b.dueDate >= asOf && b.dueDate <= until) {
          out.dueSoon.amount += amt;
          out.dueSoon.count += 1;
        }
      }
    }
    if (partyOverdue) out.overduePartyCount += 1;
  }
  out.ageing = buckets.map((b, i): DashboardAgeingBucket => ({ index: b.index, label: b.label, minDays: b.minDays, maxDays: b.maxDays, amount: nz(amounts[i]) }));
  for (const k of ['total', 'overdue', 'notDue', 'advance', 'onAccount'] as const) out[k] = nz(out[k]);
  return out;
}

// ───────────────────────────── Cash & bank ─────────────────────────────

function cashBank(db: Db, cls: Classified, asOf: string, today: string): DashboardCashBank {
  const bal = closingBalances(db, { asOf, today, ledgerIds: cls.cashBankIds });
  const row = (l: LedgerRow, od: boolean): DashboardBalanceRow => {
    const digits = (l.bank_account_no ?? '').replace(/\D/g, '');
    return { ledgerId: l.id, name: l.name, balance: nz(bal.get(l.id) ?? 0), isOverdraft: od, accountTail: digits.length >= 4 ? digits.slice(-4) : null };
  };
  const byName = (a: DashboardBalanceRow, b: DashboardBalanceRow): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.ledgerId - b.ledgerId;
  const cash = cls.cash.map((l) => row(l, false)).sort(byName);
  const banks = cls.banks.map((l) => row(l, l.od)).sort((a, b) => Number(a.isOverdraft) - Number(b.isOverdraft) || byName(a, b));
  return {
    cashTotal: nz(cash.reduce((s, r) => s + r.balance, 0)),
    cash,
    bankTotal: nz(banks.reduce((s, r) => s + r.balance, 0)),
    banks,
  };
}

// ───────────────────────────── GST ─────────────────────────────

/** States whose quarterly (QRMP) GSTR-3B is due on the 22nd; the rest on the 24th (Notification 76/2020-CT). */
const QRMP_22ND_STATES = new Set(['22', '23', '24', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '25']);

/**
 * Due date of the tax for a month: monthly filers — GSTR-3B on the 20th of the next month; quarterly
 * (QRMP) filers — PMT-06 on the 25th for the first two months of a quarter, GSTR-3B on the 22nd / 24th
 * (by state) after the quarter's last month. Pure.
 */
export function gstDueDate(monthStart: string, frequency: 'monthly' | 'quarterly', stateCode: string): { dueDate: string; form: 'GSTR-3B' | 'PMT-06' } {
  const next = shiftMonths(startOfMonth(monthStart), 1);
  const day = (d: number): string => `${next.slice(0, 8)}${String(d).padStart(2, '0')}`;
  if (frequency === 'monthly') return { dueDate: day(20), form: 'GSTR-3B' };
  const m = Number(monthStart.slice(5, 7));
  const quarterEnd = m % 3 === 0; // Jun, Sep, Dec, Mar
  if (!quarterEnd) return { dueDate: day(25), form: 'PMT-06' };
  return { dueDate: day(QRMP_22ND_STATES.has(stateCode) ? 22 : 24), form: 'GSTR-3B' };
}

function gstCard(db: Db, asOf: string, today: string): DashboardGst | null {
  const company = loadCompany(db);
  if (!company.features.gst || company.registration !== 'regular') return null;
  const period = parsePeriodKey(monthPeriodKey(asOf));
  if (!period) return null;
  const docs = loadDocs(db, company, { from: period.from, to: period.to, today });
  const s = computeGstr3b(db, company, period, today, undefined, docs);
  const sum = (t: { igst: number; cgst: number; sgst: number; cess: number }): Paise => t.igst + t.cgst + t.sgst + t.cess;
  const outward = s.supplies.filter((r) => r.key === 'osup_det' || r.key === 'osup_zero');
  const rcm = s.supplies.find((r) => r.key === 'isup_rev');
  const due = gstDueDate(period.from, company.config.gst.filingFrequency, company.stateCode);
  return {
    period: period.key,
    label: formatMonth(monthKey(period.from)),
    from: period.from,
    to: period.to,
    dueDate: due.dueDate,
    dueForm: due.form,
    filingFrequency: company.config.gst.filingFrequency,
    outputTax: nz(outward.reduce((t, r) => t + sum(r), 0)),
    reverseChargeTax: nz(rcm ? sum(rcm) : 0),
    inputTax: nz(sum(s.itc.net)),
    netPayable: nz(s.payment.rows.reduce((t, r) => t + r.cash + r.rcmLiability, 0)),
    creditCarriedForward: nz(sum(s.payment.setOff.creditBalance)),
    documentCount: docs.filter((d) => d.inBooks).length,
  };
}

/** e-invoice natures (as gst/einvoice.ts) and inward natures (never need an outward e-way bill). */
const EINVOICE_NATURES = ['b2b', 'sez_wpay', 'sez_lut', 'export_wpay', 'export_lut', 'deemed_export'];
const INWARD_NATURES = ['inward_b2b', 'inward_rcm', 'inward_unregistered', 'inward_composition', 'import_goods', 'import_services', 'inward_sez', 'inward_nil_exempt'];

function compliance(db: Db, features: DashboardFeatures, gstAllowed: boolean, range: DateRange, today: string): DashboardCompliance {
  const out: DashboardCompliance = { einvoicePending: null, ewayPending: null, from: range.from, to: range.to };
  if (!features.gst || !gstAllowed) return out;
  const base = { from: range.from, to: range.to, today };
  if (features.einvoice) {
    out.einvoicePending =
      db.value<number>(
        `SELECT COUNT(*) FROM vouchers v
          WHERE v.base_type IN ('sales', 'credit_note', 'debit_note') AND v.date >= :from AND v.date <= :to AND ${BOOKS_FILTER('v')}
            AND v.gst_nature IN (SELECT value FROM json_each(:natures))
            AND (v.irn IS NULL OR v.irn = '') AND (v.irn_status IS NULL OR v.irn_status IN ('', 'pending'))`,
        { ...base, natures: JSON.stringify(EINVOICE_NATURES) },
      ) ?? 0;
  }
  if (features.ewayBill) {
    const threshold = getConfig(db).gst.ewayThresholdPaise;
    out.ewayPending =
      db.value<number>(
        `SELECT COUNT(*) FROM (
           SELECT v.id FROM vouchers v JOIN gst_lines g ON g.voucher_id = v.id
            WHERE v.base_type IN ('sales', 'credit_note') AND v.date >= :from AND v.date <= :to AND ${BOOKS_FILTER('v')}
              AND (v.gst_nature IS NULL OR v.gst_nature NOT IN (SELECT value FROM json_each(:inward)))
              AND (v.eway_bill_no IS NULL OR v.eway_bill_no = '')
              AND g.supply_type = 'goods' AND g.taxability = 'taxable'
            GROUP BY v.id
           HAVING SUM(g.taxable_value + g.igst + g.cgst + g.sgst + g.cess) > :threshold)`,
        { ...base, inward: JSON.stringify(INWARD_NATURES), threshold },
      ) ?? 0;
  }
  return out;
}

// ───────────────────────────── Top customers / items ─────────────────────────────

const share = (amount: Paise, total: Paise): number | null => (total > 0 ? Math.round((amount / total) * 10_000) / 100 : null);

function topCustomers(db: Db, cls: Classified, period: DateRange, periodSales: Paise, today: string): DashboardTopCustomer[] {
  return db
    .all<{ id: number; name: string; net: number; n: number }>(
      `SELECT v.party_ledger_id AS id, l.name AS name, -SUM(le.amount) AS net,
              COUNT(DISTINCT CASE WHEN v.base_type = 'sales' THEN v.id END) AS n
         FROM ledger_entries le
         JOIN vouchers v ON v.id = le.voucher_id
         JOIN ledgers l ON l.id = v.party_ledger_id
        WHERE le.ledger_id IN (SELECT value FROM json_each(:sales))
          AND le.date >= :from AND le.date <= :to AND ${BOOKS_FILTER('le')}
          AND v.party_ledger_id NOT IN (SELECT value FROM json_each(:cashBank))
        GROUP BY v.party_ledger_id
       HAVING -SUM(le.amount) > 0
        ORDER BY net DESC, l.name COLLATE NOCASE, v.party_ledger_id
        LIMIT ${TOP_N}`,
      { sales: JSON.stringify(cls.trading.get('s') ?? []), cashBank: JSON.stringify(cls.cashBankIds), from: period.from, to: period.to, today },
    )
    .map((r) => ({ ledgerId: r.id, name: r.name, amount: r.net, invoiceCount: r.n, sharePercent: share(r.net, periodSales) }));
}

function topItems(db: Db, period: DateRange, periodSales: Paise, today: string): DashboardTopItem[] {
  return db
    .all<{ id: number; name: string; unit: string | null; net: number; sold: number }>(
      `SELECT ie.item_id AS id, si.name AS name, u.symbol AS unit,
              SUM(CASE WHEN v.base_type = 'credit_note' THEN -ie.amount ELSE ie.amount END) AS net,
              SUM(CASE WHEN v.base_type = 'credit_note' THEN -1 ELSE 1 END * COALESCE(ie.billed_qty, ABS(ie.qty))) AS sold
         FROM vouchers v
         JOIN inventory_entries ie ON ie.voucher_id = v.id
         JOIN stock_items si ON si.id = ie.item_id
         LEFT JOIN units u ON u.id = si.unit_id
        WHERE v.base_type IN ('sales', 'credit_note') AND v.date >= :from AND v.date <= :to AND ${BOOKS_FILTER('v')}
        GROUP BY ie.item_id
       HAVING SUM(CASE WHEN v.base_type = 'credit_note' THEN -ie.amount ELSE ie.amount END) > 0
        ORDER BY net DESC, si.name COLLATE NOCASE, ie.item_id
        LIMIT ${TOP_N}`,
      { from: period.from, to: period.to, today },
    )
    .map((r) => ({ itemId: r.id, name: r.name, unit: r.unit ?? '', qty: Math.round(r.sold * 1e6) / 1e6, amount: r.net, sharePercent: share(r.net, periodSales) }));
}

// ───────────────────────────── Stock ─────────────────────────────

function lowStock(db: Db, asOf: string, today: string): { count: number; items: DashboardLowStockItem[] } {
  const items = db.all<{ id: number; name: string; unit: string | null; reorder: number }>(
    `SELECT si.id, si.name, u.symbol AS unit, si.reorder_level AS reorder
       FROM stock_items si LEFT JOIN units u ON u.id = si.unit_id
      WHERE si.is_active = 1 AND si.is_service = 0 AND si.reorder_level > 0`,
  );
  if (items.length === 0) return { count: 0, items: [] };
  const qty = stockByItem(db, { asOf, today, itemIds: items.map((i) => i.id) });
  const low: DashboardLowStockItem[] = [];
  for (const i of items) {
    const onHand = qty.get(i.id) ?? 0;
    if (onHand < i.reorder - 1e-9) {
      low.push({ itemId: i.id, name: i.name, unit: i.unit ?? '', onHand, reorderLevel: i.reorder, shortfall: Math.round((i.reorder - onHand) * 1e6) / 1e6 });
    }
  }
  // Most urgent first: least cover (on hand ÷ reorder level), then the larger shortfall.
  low.sort((a, b) => a.onHand / a.reorderLevel - b.onHand / b.reorderLevel || b.shortfall - a.shortfall || a.name.localeCompare(b.name));
  return { count: low.length, items: low.slice(0, LOW_STOCK_N) };
}

// ───────────────────────────── Vouchers ─────────────────────────────

function recentVouchers(db: Db): DashboardVoucherRow[] {
  return db
    .all<{
      id: number;
      date: string;
      number: string | null;
      type_name: string;
      base_type: VoucherBaseType;
      party: string | null;
      amount: number;
      is_cancelled: number;
      is_optional: number;
      is_post_dated: number;
    }>(
      `SELECT v.id, v.date, v.number, vt.name AS type_name, v.base_type, COALESCE(v.party_name, l.name) AS party,
              v.total_amount AS amount, v.is_cancelled, v.is_optional, v.is_post_dated
         FROM vouchers v
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         LEFT JOIN ledgers l ON l.id = v.party_ledger_id
        ORDER BY v.id DESC
        LIMIT ${RECENT_N}`,
    )
    .map((r) => ({
      id: r.id,
      date: r.date,
      number: r.number,
      typeName: r.type_name,
      baseType: r.base_type,
      partyName: r.party,
      amount: r.is_cancelled ? 0 : r.amount,
      isCancelled: r.is_cancelled === 1,
      isOptional: r.is_optional === 1,
      isPostDated: r.is_post_dated === 1,
    }));
}

function postDated(db: Db, cls: Classified, today: string): DashboardPdc {
  const heads = db.all<{ id: number; date: string; number: string | null; type_name: string; base_type: VoucherBaseType; party: string | null }>(
    `SELECT v.id, v.date, v.number, vt.name AS type_name, v.base_type, COALESCE(v.party_name, pl.name) AS party
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
      WHERE v.is_post_dated = 1 AND v.is_cancelled = 0 AND v.is_optional = 0 AND v.affects_books = 1 AND v.date > :today
      ORDER BY v.date, v.id`,
    { today },
  );
  const out: DashboardPdc = { count: 0, inflow: 0, outflow: 0, rows: [] };
  if (heads.length === 0) return out;
  // Cash/bank lines of those vouchers: net movement, the main bank line and its instrument number.
  const lines = new Map<number, Array<{ ledger_id: number; name: string; amount: number; instrument_no: string | null }>>();
  for (const l of db.all<{ voucher_id: number; ledger_id: number; name: string; amount: number; instrument_no: string | null }>(
    `SELECT le.voucher_id, le.ledger_id, l.name, le.amount, le.instrument_no
       FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
      WHERE le.voucher_id IN (SELECT value FROM json_each(:ids)) AND le.ledger_id IN (SELECT value FROM json_each(:cb))
      ORDER BY le.voucher_id, le.line_no`,
    { ids: JSON.stringify(heads.map((h) => h.id)), cb: JSON.stringify(cls.cashBankIds) },
  )) {
    const list = lines.get(l.voucher_id);
    if (list) list.push(l);
    else lines.set(l.voucher_id, [l]);
  }
  for (const h of heads) {
    const ls = lines.get(h.id) ?? [];
    const cb = ls.reduce((s, l) => s + l.amount, 0);
    if (cb === 0) continue; // no net cash/bank movement (a post-dated journal or contra)
    const main = ls.reduce((best, l) => (Math.abs(l.amount) > Math.abs(best.amount) ? l : best), ls[0]);
    const direction = cb > 0 ? 'in' : 'out';
    out.count += 1;
    if (direction === 'in') out.inflow += cb;
    else out.outflow -= cb;
    if (out.rows.length < PDC_N) {
      out.rows.push({
        id: h.id,
        date: h.date,
        number: h.number,
        typeName: h.type_name,
        baseType: h.base_type,
        partyName: h.party,
        amount: Math.abs(cb),
        direction,
        bankLedgerId: main.ledger_id,
        bankName: main.name,
        instrumentNo: ls.find((l) => l.instrument_no)?.instrument_no ?? null,
      });
    }
  }
  return out;
}

// ───────────────────────────── Summary ─────────────────────────────

const can = (s: Session, p: Permission): boolean => s.isOwner || s.permissions.has(p);

export interface SummaryDeps {
  db: Db;
  today: string;
  now: Date;
  session: Session;
}

// ───────────────────────────── Memo ─────────────────────────────
//
// A cold summary on a large company is dominated by the shared engines (the outstanding bill aggregate
// and the stock valuation replay — see README §Performance). The Gateway asks for the same summary
// again and again (every Esc back to it), so the last few results are kept per open database and
// reused while the data has not changed. The change key is SQLite's own counters: total_changes()
// (rows changed through this connection — every save, cancel, delete, import or settings change) and
// PRAGMA data_version (commits by any other connection). Any change, even one rolled back, simply
// invalidates. The working date and the caller's permission flags are part of the key; the backup age
// (clock time) is recomputed on every call.

type Cached = Omit<DashboardSummary, 'backup' | 'elapsedMs' | 'cached'>;
const MEMO = new WeakMap<Db, Map<string, Array<{ key: string; value: unknown }>>>();
const MEMO_SIZE = 6;

function changeKey(db: Db): string {
  return `${db.value<number>('SELECT total_changes()') ?? 0}:${db.value<number>('PRAGMA data_version') ?? 0}`;
}

/** Memo of one kind of result per database (most recent first, MEMO_SIZE entries). */
function memoised<T>(db: Db, kind: string, key: string, enabled: boolean, fn: () => T): { value: T; hit: boolean } {
  if (!enabled) return { value: fn(), hit: false };
  let kinds = MEMO.get(db);
  if (!kinds) MEMO.set(db, (kinds = new Map()));
  const list = kinds.get(kind) ?? [];
  const found = list.find((e) => e.key === key);
  if (found) return { value: found.value as T, hit: true };
  const value = fn();
  kinds.set(kind, [{ key, value }, ...list].slice(0, MEMO_SIZE));
  return { value, hit: false };
}

export function dashboardSummary(deps: SummaryDeps, input: DashboardSummaryInput, opts: { memo?: boolean } = {}): DashboardSummary {
  const started = performance.now();
  const { db, today, session } = deps;
  if (input.from > input.to) throw validation([{ path: 'to', message: 'The period ends before it starts. Choose an end date on or after the start date.' }]);
  const flags = { gp: can(session, 'reports.financial'), gst: can(session, 'gst.view') };
  const memo = opts.memo !== false;
  const change = changeKey(db);
  const key = JSON.stringify([input.asOf, input.from, input.to, today, flags.gp, flags.gst, change]);
  // Receivables / payables depend on asOf only: a period change (Alt+F2) reuses them.
  const outstanding = (side: OutstandingSide): DashboardOutstanding =>
    memoised(db, side, JSON.stringify([input.asOf, today, change]), memo, () => outstandingFigures(db, today, side, input.asOf)).value;
  const { value, hit } = memoised(db, 'summary', key, memo, () => compute(db, today, input, flags, outstanding));
  return { ...value, backup: backupInfo(db, deps.now), cached: hit, elapsedMs: Math.round(performance.now() - started) };
}

function compute(
  db: Db,
  today: string,
  input: DashboardSummaryInput,
  flags: { gp: boolean; gst: boolean },
  outstanding: (side: OutstandingSide) => DashboardOutstanding,
): Cached {
  const company = db.get<{ books_from: string; fy_start_month: number }>('SELECT books_from, fy_start_month FROM company WHERE id = 1');
  const booksFrom = company?.books_from ?? input.asOf;
  const fyStartMonth = company?.fy_start_month ?? 4;
  const f = getFeatures(db);
  const features: DashboardFeatures = {
    inventory: f.inventory,
    integrated: f.inventory && f.integrateInventory,
    gst: f.gst,
    billWise: f.billWise,
    einvoice: f.gst && f.einvoice,
    ewayBill: f.gst && f.ewayBill,
  };
  const ranges = dashboardRanges(input, fyStartMonth, booksFrom);
  const tree = loadGroupTree(db);
  const cls = classify(db.all<LedgerRow>('SELECT id, name, group_id, opening_balance, bank_account_no FROM ledgers'), tree);
  const sums = flowSums(db, cls, ranges, today);
  const sales = toFlow(sums.s, -1);
  const purchases = toFlow(sums.p, 1);
  return {
    asOf: input.asOf,
    today,
    booksFrom,
    ranges,
    features,
    hasVouchers: db.value<number>('SELECT 1 FROM vouchers LIMIT 1') !== undefined,
    sales,
    purchases,
    grossProfit: flags.gp ? grossProfit(db, sums, cls, ranges.period, booksFrom, features.integrated, today) : null,
    receivables: outstanding('receivable'),
    payables: outstanding('payable'),
    cashBank: cashBank(db, cls, input.asOf, today),
    gst: flags.gst ? gstCard(db, input.asOf, today) : null,
    topCustomers: topCustomers(db, cls, ranges.period, sales.period, today),
    topItems: features.inventory ? topItems(db, ranges.period, sales.period, today) : [],
    trend: trendMonths(db, cls, input.to, today),
    lowStock: features.inventory ? lowStock(db, input.asOf, today) : { count: 0, items: [] },
    compliance: compliance(db, features, flags.gst, ranges.ytd, today),
    recentVouchers: recentVouchers(db),
    postDated: postDated(db, cls, today),
  };
}

function backupInfo(db: Db, now: Date): DashboardBackup {
  const last = lastBackupAt(db);
  if (!last) return { lastBackupAt: null, daysSince: null };
  const ms = now.getTime() - Date.parse(last);
  return { lastBackupAt: last, daysSince: Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null };
}

/** Route adapter. */
export function summaryForCtx(ctx: CompanyCtx, input: DashboardSummaryInput): DashboardSummary {
  return dashboardSummary({ db: ctx.db, today: ctx.clock.today(), now: ctx.clock.now(), session: ctx.session }, input);
}

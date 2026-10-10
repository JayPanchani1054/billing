/**
 * Forex renderer logic — pure (tested in model.test.ts): labels, report rows and export tables.
 * Export conventions: rupee amounts are paise ('amount' / 'drcr' columns); foreign amounts are plain
 * numbers ('number' column with the currency's decimals), signed + debit / − credit.
 */
import { formatExchangeRate, formatForex, type ForexRateType } from '../../../../shared/forex.ts';
import type {
  ForexCurrency,
  ForexLedgerStatement,
  ForexOutstandingBill,
  ForexOutstandingResult,
  ForexRevaluationResult,
  ForexVoucherPreview,
} from '../../../../shared/types/forex.ts';
import type { Paise } from '../../../../shared/money.ts';

export const RATE_TYPE_LABEL: Readonly<Record<ForexRateType, string>> = {
  standard: 'Standard',
  selling: 'Selling',
  buying: 'Buying',
};

type Cell = string | number | null;
export interface ExportTable {
  columns: Array<{ header: string; kind?: 'text' | 'amount' | 'drcr' | 'date' | 'number'; width?: number; decimals?: number }>;
  rows: Cell[][];
  totals?: Cell[];
  notes?: string;
  landscape?: boolean;
}

export function currencyMap(list: readonly ForexCurrency[]): Map<number, ForexCurrency> {
  return new Map(list.map((c) => [c.id, c]));
}

/** '$ 1,250.00 Dr' — foreign amount with side, '' for zero. */
export function fxDrCr(amount: number, c: ForexCurrency | undefined): string {
  if (!c || amount === 0) return '';
  return `${formatForex(Math.abs(amount), c.decimalPlaces, c.symbol)} ${amount > 0 ? 'Dr' : 'Cr'}`;
}

export function rateText(rate: number | null): string {
  return rate === null || rate === 0 ? '' : `₹${formatExchangeRate(rate)}`;
}

/** Gain / loss wording of a signed posting to the gain/loss ledger (Dr + = loss). */
export function gainLossText(p: Paise, money: (x: Paise) => string): string {
  if (p === 0) return 'No exchange difference';
  return `${p > 0 ? 'Exchange loss' : 'Exchange gain'} ₹ ${money(Math.abs(p))}`;
}

/** Unrealised wording of a revaluation adjustment on an asset / liability (+ = gain). */
export function unrealisedText(p: Paise | null, money: (x: Paise) => string): string {
  if (p === null) return 'No closing rate';
  if (p === 0) return 'At the closing rate';
  return `${p > 0 ? 'Gain' : 'Loss'} ₹ ${money(Math.abs(p))}`;
}

// ───────────────────────────── Outstanding ─────────────────────────────

export interface OutstandingRow {
  key: string;
  level: number;
  isGroup: boolean;
  ledgerId: number;
  name: string;
  date: string | null;
  dueDate: string | null;
  overdueDays: number | null;
  currencyId: number;
  forex: number;
  inr: Paise;
  bookedRate: number | null;
  closingRate: number | null;
  revalued: Paise | null;
  difference: Paise | null;
}

export function outstandingRows(d: ForexOutstandingResult): OutstandingRow[] {
  const out: OutstandingRow[] = [];
  for (const p of d.parties) {
    out.push({
      key: `l:${p.ledgerId}`,
      level: 0,
      isGroup: p.bills.length > 0,
      ledgerId: p.ledgerId,
      name: p.ledgerName,
      date: null,
      dueDate: null,
      overdueDays: null,
      currencyId: p.currencyId,
      forex: p.forexBalance,
      inr: p.inrBalance,
      bookedRate: p.forexBalance === 0 ? null : Math.abs(p.inrBalance / 100 / p.forexBalance),
      closingRate: p.bills[0]?.closingRate ?? (p.revaluedBalance !== null && p.forexBalance !== 0 ? Math.abs(p.revaluedBalance / 100 / p.forexBalance) : null),
      revalued: p.revaluedBalance,
      difference: p.difference,
    });
    for (const b of p.bills) out.push(billRow(b));
  }
  return out;
}

function billRow(b: ForexOutstandingBill): OutstandingRow {
  return {
    key: `b:${b.ledgerId}:${b.billName}`,
    level: 1,
    isGroup: false,
    ledgerId: b.ledgerId,
    name: b.billName,
    date: b.billDate,
    dueDate: b.dueDate,
    overdueDays: b.overdueDays,
    currencyId: b.currencyId,
    forex: b.forexAmount,
    inr: b.amount,
    bookedRate: b.bookedRate || null,
    closingRate: b.closingRate,
    revalued: b.revaluedAmount,
    difference: b.difference,
  };
}

export function outstandingExport(d: ForexOutstandingResult): ExportTable {
  const cur = currencyMap(d.currencies);
  const rows = outstandingRows(d);
  return {
    landscape: true,
    columns: [
      { header: 'Party / bill', width: 30 },
      { header: 'Bill date', kind: 'date' },
      { header: 'Due date', kind: 'date' },
      { header: 'Overdue days', kind: 'number' },
      { header: 'Currency', width: 6 },
      { header: 'Foreign amount (+Dr / −Cr)', kind: 'number', decimals: 2 },
      { header: 'Booked rate', kind: 'number', decimals: 4 },
      { header: 'Carried in books (₹)', kind: 'drcr' },
      { header: 'Closing rate', kind: 'number', decimals: 4 },
      { header: 'At closing rate (₹)', kind: 'drcr' },
      { header: 'Unrealised gain (+) / loss (−) (₹)', kind: 'amount' },
    ],
    rows: rows.map((r) => [
      r.level === 0 ? r.name : `    ${r.name}`,
      r.date,
      r.dueDate,
      r.overdueDays,
      cur.get(r.currencyId)?.isoCode ?? cur.get(r.currencyId)?.symbol ?? '',
      r.forex,
      r.bookedRate,
      r.inr,
      r.closingRate,
      r.revalued,
      r.difference,
    ]),
    notes: `Closing rates: ${d.rateType} rate of the exchange-rate master on or before ${d.asOf}. A positive difference is an unrealised gain (receivable worth more / payable worth less).`,
  };
}

// ───────────────────────────── Ledger in both currencies ─────────────────────────────

export function ledgerExport(d: ForexLedgerStatement): ExportTable {
  const dp = d.currency.decimalPlaces;
  return {
    landscape: true,
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Particulars', width: 28 },
      { header: 'Voucher type', width: 14 },
      { header: 'No.', width: 10 },
      { header: `${d.currency.isoCode ?? d.currency.symbol} (+Dr / −Cr)`, kind: 'number', decimals: dp },
      { header: 'Rate', kind: 'number', decimals: 4 },
      { header: 'Rupees', kind: 'drcr' },
      { header: `Balance ${d.currency.symbol}`, kind: 'number', decimals: dp },
      { header: 'Balance ₹', kind: 'drcr' },
    ],
    rows: [
      [d.from, 'Opening balance', '', '', null, null, null, d.openingForex, d.openingInr],
      ...d.rows.map((r) => [r.date, r.particulars, r.voucherType, r.number ?? '', r.forexAmount, r.rate, r.amount, r.forexBalance, r.inrBalance] as Cell[]),
    ],
    totals: ['', 'Closing balance', '', '', null, null, null, d.closingForex, d.closingInr],
    notes:
      d.closingRate === null
        ? 'No closing rate in the exchange-rate master.'
        : `At the closing rate ₹${formatExchangeRate(d.closingRate)} the balance is worth ₹${((d.revaluedInr ?? 0) / 100).toFixed(2)}; unrealised ${(d.unrealised ?? 0) >= 0 ? 'gain' : 'loss'} ₹${(Math.abs(d.unrealised ?? 0) / 100).toFixed(2)}.`,
  };
}

// ───────────────────────────── Revaluation ─────────────────────────────

export function revaluationExport(d: ForexRevaluationResult): ExportTable {
  const rates = new Map(d.rates.map((r) => [r.currencyId, r]));
  return {
    landscape: true,
    columns: [
      { header: 'Ledger', width: 28 },
      { header: 'Bill', width: 14 },
      { header: 'Currency', width: 6 },
      { header: 'Foreign amount (+Dr / −Cr)', kind: 'number', decimals: 2 },
      { header: 'Carried in books (₹)', kind: 'drcr' },
      { header: 'Closing rate', kind: 'number', decimals: 4 },
      { header: 'At closing rate (₹)', kind: 'drcr' },
      { header: 'Adjustment (₹, +Dr / −Cr)', kind: 'drcr' },
    ],
    rows: d.lines.map((l) => [l.ledgerName, l.billName ?? 'Balance', rates.get(l.currencyId)?.symbol ?? '', l.forexAmount, l.bookedAmount, l.closingRate, l.revaluedAmount, l.adjustment]),
    totals: ['Net unrealised gain (+) / loss (−)', null, null, null, null, null, null, d.net],
    notes: `Closing ${d.rateType} rates as of ${d.asOf}: ${d.rates.map((r) => `${r.symbol} ${r.rate === null ? 'missing' : formatExchangeRate(r.rate)}${r.overridden ? ' (typed)' : ''}`).join(', ')}.`,
  };
}

/** Ledger journal lines the revaluation will post (preview): per ledger, Dr / Cr. */
export function revaluationJournalPreview(d: ForexRevaluationResult): Array<{ ledgerName: string; amount: Paise }> {
  const m = new Map<string, Paise>();
  for (const l of d.lines) m.set(l.ledgerName, (m.get(l.ledgerName) ?? 0) + l.adjustment);
  const out = [...m.entries()].filter(([, a]) => a !== 0).map(([ledgerName, amount]) => ({ ledgerName, amount }));
  if (d.net !== 0) out.push({ ledgerName: 'Forex gain/loss (unrealised)', amount: -d.net });
  return out;
}

// ───────────────────────────── Entry panel ─────────────────────────────

export interface EntrySummaryLine {
  key: string;
  label: string;
  value: string;
}

/** What the side panel of voucher entry shows from the server preview. */
export function entrySummary(p: ForexVoucherPreview | undefined, currencyOf: (id: number) => ForexCurrency | undefined, money: (x: Paise) => string): EntrySummaryLine[] {
  if (!p) return [];
  const out: EntrySummaryLine[] = [];
  if (p.currency && p.rate !== null && p.documentForex !== null) {
    out.push({ key: 'doc', label: 'Invoice value', value: `${formatForex(p.documentForex, p.currency.decimalPlaces, p.currency.symbol)} @ ₹${formatExchangeRate(p.rate)}` });
  }
  for (const e of p.entries) {
    const c = currencyOf(e.currencyId);
    out.push({
      key: `e:${e.source}:${e.lineIndex ?? 'p'}:${e.ledgerId}`,
      label: e.ledgerName,
      value: e.forexAmount === 0 ? `₹ ${money(Math.abs(e.amount))} ${e.amount >= 0 ? 'Dr' : 'Cr'} (rupees only)` : `${fxDrCr(e.forexAmount, c)} → ₹ ${money(Math.abs(e.amount))}`,
    });
  }
  for (const r of p.realised) {
    out.push({ key: `r:${r.ledgerId}:${r.billName}`, label: `Bill ${r.billName}`, value: `booked ₹ ${money(r.bookedAmount)}, now ₹ ${money(r.settledAmount)}` });
  }
  if (p.gainLoss !== 0) out.push({ key: 'gl', label: p.gainLossLedger?.name ?? 'Forex gain/loss', value: gainLossText(p.gainLoss, money) });
  return out;
}

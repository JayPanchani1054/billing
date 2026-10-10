/**
 * Forex renderer logic — pure (tested in model.test.ts): labels, report rows and export tables.
 * Export conventions: rupee amounts are paise ('amount' / 'drcr' columns); foreign amounts are plain
 * numbers ('number' column with the currency's decimals), signed + debit / − credit.
 */
import { formatExchangeRate, formatForex, paiseToForex, roundRate, sumForex, toMinor, type ForexRateType } from '../../../../shared/forex.ts';
import type {
  ForexCurrency,
  ForexLedgerStatement,
  ForexOutstandingBill,
  ForexOutstandingResult,
  ForexRevaluationResult,
  ForexVoucherPreview,
} from '../../../../shared/types/forex.ts';
import { formatMoney } from '../../../../shared/format.ts';
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
    // The same sentence as under the screen's grid: Indian grouping and Dr / Cr, never a bare minus.
    notes: ledgerFooterNote(d, (p) => formatMoney(p)),
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
export function revaluationJournalPreview(d: ForexRevaluationResult, gainLossLedgerName?: string | null): Array<{ ledgerName: string; amount: Paise }> {
  const m = new Map<string, Paise>();
  for (const l of d.lines) m.set(l.ledgerName, (m.get(l.ledgerName) ?? 0) + l.adjustment);
  const out = [...m.entries()].filter(([, a]) => a !== 0).map(([ledgerName, amount]) => ({ ledgerName, amount }));
  if (d.net !== 0) out.push({ ledgerName: gainLossLedgerName || 'Forex Gain/Loss', amount: -d.net });
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

/** Under the ledger in both currencies: the closing balance at the closing rate (unrealised). */
export function ledgerFooterNote(d: ForexLedgerStatement, money: (x: Paise) => string): string {
  const code = d.currency.isoCode ?? d.currency.symbol;
  if (d.closingForex === 0 && d.closingInr === 0) return 'Nothing is outstanding at the end of the period.';
  if (d.closingRate === null || d.revaluedInr === null) return `No closing rate for ${code} on or before the period end in Currencies › Rates of Exchange: the unrealised difference cannot be shown.`;
  const u = d.unrealised ?? 0;
  const at = `At the closing rate ₹${formatExchangeRate(d.closingRate)} per ${code} the balance is worth ₹ ${money(Math.abs(d.revaluedInr))} ${d.revaluedInr >= 0 ? 'Dr' : 'Cr'}`;
  // unrealised = revalued − carried, signed like a posting to the ledger: Dr + raises an asset / lowers a liability.
  return u === 0 ? `${at} — the same as in the books.` : `${at}: unrealised ${u > 0 ? 'gain' : 'loss'} ₹ ${money(Math.abs(u))}.`;
}

// ───────────────────────────── Revaluation inputs ─────────────────────────────

export interface RevaluationRateRow {
  currencyId: number;
  symbol: string;
  formalName: string;
  /** The master rate (null: none on or before the date). */
  masterRate: number | null;
  masterDate: string | null;
  /** What the user typed instead (null: use the master). */
  typed: number | null;
}

/** Rows of the closing-rate editor: the report's currencies with what the user typed. */
export function revaluationRateRows(d: ForexRevaluationResult | undefined, typed: ReadonlyMap<number, number>): RevaluationRateRow[] {
  if (!d) return [];
  return d.rates.map((r) => ({
    currencyId: r.currencyId,
    symbol: r.symbol,
    formalName: r.formalName,
    masterRate: r.masterRate !== undefined ? r.masterRate : r.overridden ? null : r.rate,
    masterDate: r.masterDate !== undefined ? r.masterDate : r.overridden ? null : r.rateDate,
    typed: typed.get(r.currencyId) ?? null,
  }));
}

/** The `rates` input of forex.revaluation.*: typed rates > 0 only, ordered by currency for a stable query key. */
export function rateOverrides(typed: ReadonlyMap<number, number>): Array<{ currencyId: number; rate: number }> {
  return [...typed.entries()]
    .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([currencyId, rate]) => ({ currencyId, rate }));
}

/**
 * Why the revaluation cannot be posted yet (null: it can). Every currency with a balance needs a
 * closing rate — `missingRates` already excludes the currencies typed for this run, so a rate typed for
 * one currency does not excuse another (the core refuses the same). `_typedCount` is kept for callers.
 */
export function revaluationBlocker(d: ForexRevaluationResult | undefined, _typedCount = 0): string | null {
  if (!d) return 'Loading…';
  if (d.missingRates.length > 0) {
    const names = d.rates.filter((r) => d.missingRates.includes(r.currencyId)).map((r) => r.formalName);
    return `No closing rate for ${names.join(', ')}: type it below or enter it in Currencies › Rates of Exchange.`;
  }
  if (d.lines.length === 0) return 'Nothing to revalue: every foreign-currency balance is already carried at the closing rate.';
  return null;
}

/** Default narration of the "Forex adjustment" journal. */
export function revaluationNarration(d: ForexRevaluationResult, dateText: (iso: string) => string): string {
  const rates = d.rates.filter((r) => r.rate !== null).map((r) => `${r.symbol} ₹${formatExchangeRate(r.rate as number)}`);
  return `Forex adjustment: foreign-currency balances restated at the closing ${d.rateType} rate as on ${dateText(d.asOf)}${rates.length ? ` (${rates.join(', ')})` : ''}.`;
}

// ───────────────────────────── Opening balance in the currency ─────────────────────────────

/** Rupees per unit implied by a rupee amount and its foreign amount (null when either is 0). */
export function impliedRate(inr: Paise, forex: number): number | null {
  if (inr === 0 || forex === 0) return null;
  return roundRate(Math.abs(inr / 100 / forex));
}

/** Foreign amount of a rupee amount at a rate, signed like the rupees (fill helper of the opening form). */
export function forexAtRate(inr: Paise, rate: number, dp: number): number {
  if (!(rate > 0) || inr === 0) return 0;
  return paiseToForex(inr, rate, dp);
}

/** What is wrong with an opening draft before it is sent (the core checks the same and more). */
export function openingIssues(
  openingInr: Paise,
  openingForex: number | null,
  bills: ReadonlyArray<{ billName: string; amount: Paise; forexAmount: number | null }>,
  dp: number,
): string[] {
  const out: string[] = [];
  const fx = openingForex ?? 0;
  if (openingInr === 0 && fx !== 0) out.push('Enter the rupee opening balance on the ledger first (Ledger › Opening balance).');
  if (openingInr !== 0 && fx !== 0 && Math.sign(openingInr) !== Math.sign(fx)) out.push('The opening balance in the currency must be on the same side (Dr / Cr) as the rupee opening balance.');
  for (const b of bills) {
    const bf = b.forexAmount ?? 0;
    if (b.amount !== 0 && bf !== 0 && Math.sign(b.amount) !== Math.sign(bf)) out.push(`Bill ${b.billName}: the foreign amount must be on the same side (Dr / Cr) as its rupee amount.`);
  }
  // Bills are sent (and must add up) once any of them has a foreign amount.
  if (bills.some((b) => (b.forexAmount ?? 0) !== 0)) {
    const total = sumForex(bills.map((b) => b.forexAmount ?? 0), dp);
    if (toMinor(total, dp) !== toMinor(fx, dp)) out.push(`The opening bills total ${total} but the opening balance in the currency is ${fx}.`);
  }
  return out;
}

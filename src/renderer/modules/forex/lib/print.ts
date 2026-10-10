/**
 * Foreign-currency block of a printed document — pure (tested in print.test.ts). The data
 * (PrintVoucherData.forex) is built by the core (src/core/modules/forex/print.ts); this decides what the
 * templates print from it:
 *
 *  - invoice layout (export / import invoice in a currency): one row per line and charge with the
 *    rate and amount in the currency next to the rupee amount, a row for GST (computed and payable in
 *    rupees; its value in the currency so the column adds up), the total in both currencies, the total
 *    in words in the currency and the rate note (Rule 34 CGST Rules: value converted at the rate of the
 *    date of supply; GST in INR — GSTR-1 EXPWP / EXPWOP carry the rupee values);
 *  - voucher layout (receipt / payment / journal touching a foreign-currency ledger): the foreign
 *    amount and rate of each such entry.
 */
import { formatExchangeRate, formatForex } from '../../../../shared/forex.ts';
import { formatMoney } from '../../../../shared/format.ts';
import type { PrintForex } from '../../../../shared/types/forex.ts';
import type { PrintVoucherData } from '../../../../shared/types/print.ts';

export interface ForexPrintRow {
  key: string;
  kind: 'line' | 'charge' | 'tax' | 'total';
  label: string;
  /** Rate per unit in the currency ('' when none). */
  rate: string;
  /** Amount in the currency (no symbol: the column header names the currency). */
  foreign: string;
  /** Rupee amount (no symbol). */
  rupees: string;
}

export interface ForexInvoiceBlock {
  /** 'USD' (ISO code, else the symbol). */
  code: string;
  title: string;
  rows: ForexPrintRow[];
  words: string | null;
  note: string;
}

const codeOf = (fx: PrintForex): string => fx.currency.isoCode ?? fx.currency.symbol;

/** The invoice table in the currency, or null when the document is not an invoice in a foreign currency. */
export function forexInvoiceBlock(doc: Pick<PrintVoucherData, 'layout' | 'lines' | 'charges' | 'totals' | 'forex'>): ForexInvoiceBlock | null {
  const fx = doc.forex;
  if (!fx || doc.layout !== 'invoice' || fx.rate === null || fx.total === null) return null;
  if (fx.lines.length !== doc.lines.length || fx.charges.length !== doc.charges.length) return null;
  const dp = fx.currency.decimalPlaces;
  const f = (n: number): string => formatForex(n, dp);
  const rows: ForexPrintRow[] = [];
  doc.lines.forEach((l, i) => {
    const x = fx.lines[i] as PrintForex['lines'][number];
    rows.push({ key: `l${i}`, kind: 'line', label: l.name, rate: x.rate === null ? '' : formatExchangeRate(x.rate), foreign: f(x.amount), rupees: formatMoney(l.amount) });
  });
  doc.charges.forEach((c, i) => {
    rows.push({ key: `c${i}`, kind: 'charge', label: c.name, rate: '', foreign: f(fx.charges[i] as number), rupees: formatMoney(c.amount) });
  });
  // GST (+ round-off / TCS): the rupee remainder of the document value; in the currency, what makes the column add up.
  const restInr = doc.totals.grandTotal - doc.lines.reduce((a, l) => a + l.amount, 0) - doc.charges.reduce((a, c) => a + c.amount, 0);
  if (restInr !== 0 || fx.tax !== 0) {
    rows.push({
      key: 'tax',
      kind: 'tax',
      label: doc.totals.tax !== 0 ? 'GST (computed and payable in rupees)' : 'Round-off',
      rate: '',
      foreign: f(fx.tax),
      rupees: formatMoney(restInr),
    });
  }
  rows.push({ key: 'total', kind: 'total', label: 'Total', rate: '', foreign: f(fx.total), rupees: formatMoney(doc.totals.grandTotal) });
  const code = codeOf(fx);
  return {
    code,
    title: `Amounts in ${fx.currency.formalName} (${code}) @ ₹${formatExchangeRate(fx.rate)} per ${code}`,
    rows,
    words: fx.totalInWords,
    note: fx.note,
  };
}

/** Voucher layout: '<ledger>: $ 1,250.00 @ ₹83.25' lines (entries kept in a foreign currency). */
export function forexVoucherLines(doc: Pick<PrintVoucherData, 'layout' | 'forex'>): string[] {
  const fx = doc.forex;
  if (!fx || (doc.layout === 'invoice' && fx.rate !== null && fx.total !== null)) return [];
  return fx.entries.map((e) => `${e.ledgerName}: ${e.text}`);
}

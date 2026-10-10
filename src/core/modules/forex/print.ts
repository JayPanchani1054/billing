/**
 * Foreign-currency block of a printed document (PrintVoucherData.forex), built by the print module
 * through this function.
 *
 * Invoice layout (export / import invoice): every line, charge and the total in the document currency
 * with the rate of exchange; GST stays in rupees (CGST Act s.12 / Rule 34 of the CGST Rules: the value
 * is converted at the rate of the date of supply; tax is computed and paid in INR). The document value
 * in the currency is the one stored with the voucher (what the buyer owes), and the line amounts are
 * the rupee values converted back — exact, because each rupee value was rounded from the typed foreign
 * amount. The tax column takes the rest, so the column adds up.
 *
 * Voucher layout (forex receipt / payment / journal): the foreign amount and rate of each entry.
 */
import { amountInWordsForex, formatExchangeRate, formatForex, paiseToForex, roundRate, sumForex } from '../../../shared/forex.ts';
import type { PrintForex } from '../../../shared/types/forex.ts';
import type { PrintVoucherData } from '../../../shared/types/print.ts';
import type { Db } from '../../db/db.ts';
import { voucherForex } from './service.ts';

export function forexPrintBlock(db: Db, data: Pick<PrintVoucherData, 'id' | 'layout' | 'lines' | 'charges' | 'sample'>): PrintForex | null {
  if (data.sample || data.id <= 0) return null;
  const has = db.value<number>('SELECT 1 FROM vouchers WHERE id = :id AND currency_id IS NOT NULL UNION ALL SELECT 1 FROM ledger_entries WHERE voucher_id = :id AND currency_id IS NOT NULL LIMIT 1', { id: data.id });
  if (has === undefined) return null;
  const d = voucherForex(db, data.id);
  const currency = d.currency ?? d.entries[0]?.currency ?? null;
  if (!currency) return null;
  const dp = currency.decimalPlaces;
  const code = currency.isoCode ?? currency.symbol;
  const entries = d.entries.map((e) => ({
    ledgerName: e.ledgerName,
    forexAmount: e.forexAmount,
    rate: e.rate,
    text:
      e.forexAmount === 0
        ? 'Exchange adjustment (rupees only)'
        : `${formatForex(Math.abs(e.forexAmount), e.currency.decimalPlaces, e.currency.symbol)} @ ₹${formatExchangeRate(e.rate ?? 0)}`,
  }));
  const rate = d.rate;
  if (data.layout !== 'invoice' || rate === null || d.currency === null) {
    return {
      currency: { symbol: currency.symbol, isoCode: currency.isoCode, formalName: currency.formalName, decimalPlaces: dp },
      rate,
      lines: [],
      charges: [],
      tax: 0,
      total: null,
      totalInWords: null,
      note: entries.some((e) => e.forexAmount !== 0) ? `Amounts in ${code} converted at the rates shown; the books are kept in rupees.` : '',
      entries,
    };
  }
  const lines = data.lines.map((l) => ({
    rate: l.rate === null ? null : roundRate(l.rate / rate),
    amount: paiseToForex(l.amount, rate, dp),
  }));
  const charges = data.charges.map((c) => paiseToForex(c.amount, rate, dp));
  const total = d.documentForex ?? sumForex([...lines.map((l) => l.amount), ...charges], dp);
  const tax = sumForex([total, -sumForex([...lines.map((l) => l.amount), ...charges], dp)], dp);
  return {
    currency: { symbol: currency.symbol, isoCode: currency.isoCode, formalName: currency.formalName, decimalPlaces: dp },
    rate,
    lines,
    charges,
    tax,
    total,
    totalInWords: amountInWordsForex(total, dp, currency.formalName),
    note: `Amounts in ${code}. Rupee equivalents at ₹${formatExchangeRate(rate)} per ${code}; GST is computed and payable in rupees.`,
    entries,
  };
}

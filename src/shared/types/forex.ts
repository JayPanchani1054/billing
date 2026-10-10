/**
 * DTOs of the forex module (src/core/modules/forex): multi-currency vouchers, bills, realised and
 * unrealised exchange differences. Money is INR paise (signed Dr + / Cr − where a field says so);
 * foreign amounts are numbers in the currency's major unit rounded to its decimal places (see
 * src/shared/forex.ts); rates are rupees per one unit of the foreign currency.
 */
import type { ForexRateType } from '../forex.ts';
import type { Paise } from '../money.ts';

export type { ForexRateType } from '../forex.ts';

// ───────────────────────────── Voucher input (VoucherInput.forex) ─────────────────────────────

/**
 * Voucher-level currency and rate of exchange.
 *  - Invoice modes (export sales / import purchases, notes): the document currency. Required when the
 *    party ledger is kept in a foreign currency (and refused for a rupee party). Item `forexRate` /
 *    `forexAmount` and ledger-line `forexAmount` are in this currency; the INR values posted are
 *    converted at `rate`. GST is always computed on the INR values.
 *  - Ledger mode (payment, receipt, journal, contra, notes as plain lines): the default rate of lines
 *    in this currency that carry no `exchangeRate` of their own.
 */
export interface VoucherForexInput {
  currencyId: number;
  /** Rupees per one unit of the currency (> 0, at most 6 decimals). */
  rate: number;
  /** Which master rate the rate came from (information only; the rate typed is what posts). */
  rateType?: ForexRateType;
}

// ───────────────────────────── Settings ─────────────────────────────

export interface ForexSettings {
  /**
   * Ledger realised exchange differences (bill settled at another rate) are posted to. null → the
   * system ledger 'Forex Gain/Loss' (Indirect Expenses; a gain is a credit), created on first use.
   */
  gainLossLedgerId: number | null;
  /** Ledger for unrealised differences (revaluation journal). null → the realised ledger. */
  unrealisedLedgerId: number | null;
  /** Rate column of the exchange-rate master used for period-end revaluation (default standard). */
  revaluationRateType: ForexRateType;
}

export interface ForexSettingsView extends ForexSettings {
  /** Ledger actually used (resolved; null until the system ledger is created). */
  gainLossLedger: { id: number; name: string } | null;
  unrealisedLedger: { id: number; name: string } | null;
}

// ───────────────────────────── Context for entry screens ─────────────────────────────

export interface ForexCurrency {
  id: number;
  symbol: string;
  formalName: string;
  isoCode: string | null;
  decimalPlaces: number;
  isBase: boolean;
}

export interface ForexRateSuggestion {
  currencyId: number;
  date: string;
  rateType: ForexRateType;
  /** Rate on or before the date of the requested type (falls back to standard, then any), else null. */
  rate: number | null;
  /** Date of the master row used. */
  rateDate: string | null;
  standard: number | null;
  selling: number | null;
  buying: number | null;
}

/** Ledgers kept in a foreign currency (for entry screens). */
export interface ForexLedgerCurrency {
  ledgerId: number;
  currencyId: number;
  ledgerName: string;
}

export interface ForexContext {
  enabled: boolean;
  base: ForexCurrency | null;
  currencies: ForexCurrency[];
  ledgers: ForexLedgerCurrency[];
  settings: ForexSettingsView;
}

// ───────────────────────────── Voucher preview / detail ─────────────────────────────

export interface ForexEntryView {
  /** The invoice party, or an input ledger line (ledger mode: `lineIndex` into VoucherInput.ledgers). */
  source: 'party' | 'line';
  lineIndex: number | null;
  ledgerId: number;
  ledgerName: string;
  currencyId: number;
  /** Signed like the entry; 0 = INR-only exchange adjustment. */
  forexAmount: number;
  /** Rate of exchange the line was entered at (null for an INR-only adjustment). */
  rate: number | null;
  /** INR posted (signed). */
  amount: Paise;
  bills: Array<{ refType: string; billName: string | null; amount: Paise; forexAmount: number }>;
}

/** One realised difference (a bill settled at another rate than it was booked at). */
export interface ForexRealisedLine {
  ledgerId: number;
  ledgerName: string;
  billName: string;
  forexAmount: number;
  /** INR the bill was carried at for that foreign amount. */
  bookedAmount: Paise;
  /** INR of the same foreign amount at this voucher's rate. */
  settledAmount: Paise;
  /** Signed posting to the gain/loss ledger: Dr + = loss, Cr − = gain. */
  difference: Paise;
}

export interface ForexVoucherPreview {
  /** Document currency (invoice modes) or the voucher-level currency, else null. */
  currency: ForexCurrency | null;
  rate: number | null;
  /** Invoice modes: the document value in the foreign currency (unsigned), else null. */
  documentForex: number | null;
  /** Invoice modes: forex value of each item / ledger line, aligned with input items / ledgers. */
  itemForex: Array<number | null>;
  ledgerForex: Array<number | null>;
  entries: ForexEntryView[];
  realised: ForexRealisedLine[];
  /** Σ realised differences (signed: Dr + = loss). */
  gainLoss: Paise;
  gainLossLedger: { id: number; name: string } | null;
}

// ───────────────────────────── Bills / outstanding ─────────────────────────────

export interface ForexPendingBill {
  billName: string;
  billDate: string;
  dueDate: string | null;
  /** INR still carried on the bill (signed: Dr + receivable, Cr − payable). */
  amount: Paise;
  /** Foreign amount still pending (signed like amount). */
  forexAmount: number;
  /** INR ÷ forex (the rate the remaining bill is carried at), 0 when forex is 0. */
  bookedRate: number;
  source: 'opening' | 'voucher';
  voucherId: number | null;
}

export interface ForexOutstandingInput {
  asOf: string;
  /** receivable: Sundry Debtors side (Dr balances); payable: Cr; all: both. */
  kind?: 'receivable' | 'payable' | 'all';
  ledgerId?: number;
  currencyId?: number;
  rateType?: ForexRateType;
}

export interface ForexOutstandingBill extends ForexPendingBill {
  ledgerId: number;
  ledgerName: string;
  currencyId: number;
  overdueDays: number | null;
  /** Closing rate as of the date (null when the master has no rate). */
  closingRate: number | null;
  /** INR of the pending forex at the closing rate (null without a rate). */
  revaluedAmount: Paise | null;
  /** revalued − carried (signed; + = the asset grew / the liability shrank: an unrealised gain on a receivable is +). */
  difference: Paise | null;
}

export interface ForexOutstandingParty {
  ledgerId: number;
  ledgerName: string;
  currencyId: number;
  forexBalance: number;
  inrBalance: Paise;
  revaluedBalance: Paise | null;
  difference: Paise | null;
  bills: ForexOutstandingBill[];
}

export interface ForexOutstandingResult {
  asOf: string;
  rateType: ForexRateType;
  currencies: ForexCurrency[];
  parties: ForexOutstandingParty[];
  /** Per currency totals. */
  totals: Array<{ currencyId: number; forex: number; inr: Paise; revalued: Paise | null; difference: Paise | null }>;
}

// ───────────────────────────── Ledger statement in both currencies ─────────────────────────────

export interface ForexLedgerInput {
  ledgerId: number;
  from: string;
  to: string;
}

export interface ForexLedgerRow {
  voucherId: number;
  date: string;
  voucherType: string;
  baseType: string;
  number: string | null;
  particulars: string;
  narration: string | null;
  /** Signed. */
  forexAmount: number | null;
  rate: number | null;
  amount: Paise;
  forexBalance: number;
  inrBalance: Paise;
}

export interface ForexLedgerStatement {
  ledgerId: number;
  ledgerName: string;
  currency: ForexCurrency;
  from: string;
  to: string;
  openingForex: number;
  openingInr: Paise;
  rows: ForexLedgerRow[];
  totals: { forexDr: number; forexCr: number; inrDr: Paise; inrCr: Paise };
  closingForex: number;
  closingInr: Paise;
  /** Closing balance in forex at the closing rate on `to` (null without a rate) and the difference. */
  closingRate: number | null;
  revaluedInr: Paise | null;
  unrealised: Paise | null;
}

// ───────────────────────────── Revaluation (unrealised gain / loss) ─────────────────────────────

export interface ForexRateOverride {
  currencyId: number;
  rate: number;
}

export interface ForexRevaluationInput {
  asOf: string;
  rateType?: ForexRateType;
  /** Rates to use instead of the master's (e.g. the RBI / FEDAI closing rate typed at period end). */
  rates?: ForexRateOverride[];
}

export interface ForexRevaluationLine {
  ledgerId: number;
  ledgerName: string;
  /** Bill-wise ledgers: one line per pending bill; others: one line for the ledger (billName null). */
  billName: string | null;
  currencyId: number;
  forexAmount: number;
  /** INR carried in the books for that foreign amount (signed). */
  bookedAmount: Paise;
  closingRate: number;
  revaluedAmount: Paise;
  /** revalued − booked, signed like a ledger posting to the party (Dr + increases the asset). */
  adjustment: Paise;
}

export interface ForexRevaluationResult {
  asOf: string;
  rateType: ForexRateType;
  rates: Array<{ currencyId: number; symbol: string; formalName: string; rate: number | null; rateDate: string | null; overridden: boolean }>;
  /** Currencies with balances but no rate: their lines are left out. */
  missingRates: number[];
  lines: ForexRevaluationLine[];
  /** Σ adjustments (signed, party side): + = net unrealised gain. */
  net: Paise;
  /** Earlier revaluation journals dated on or after the books' start. */
  posted: Array<{ voucherId: number; number: string | null; date: string; asOf: string }>;
}

export interface ForexRevaluationPostInput extends ForexRevaluationInput {
  /** Journal date (default asOf). */
  date?: string;
  /** Journal voucher type (default the first active Journal type). */
  voucherTypeId?: number;
  narration?: string;
  /** Post although a revaluation as of the same date exists. */
  allowRepeat?: boolean;
}

export interface ForexRevaluationPostResult {
  voucherId: number;
  number: string | null;
  lines: number;
  net: Paise;
}

// ───────────────────────────── Openings ─────────────────────────────

export interface ForexOpeningInput {
  ledgerId: number;
  /** Opening balance in the currency (signed like the INR opening balance). */
  openingForex: number;
  /** Bill-wise ledgers: foreign amount of each opening bill (signed like the bill). */
  bills?: Array<{ billName: string; forexAmount: number }>;
}

export interface ForexOpeningView {
  ledgerId: number;
  ledgerName: string;
  currency: ForexCurrency;
  openingInr: Paise;
  openingForex: number;
  bills: Array<{ billName: string; billDate: string; amount: Paise; forexAmount: number }>;
}

// ───────────────────────────── Saved voucher (view / print) ─────────────────────────────

export interface ForexVoucherDetail {
  voucherId: number;
  /** Document currency (foreign-currency invoice / voucher-level currency), else null. */
  currency: ForexCurrency | null;
  rate: number | null;
  /** Invoice: value in the document currency (unsigned), else null. */
  documentForex: number | null;
  /** Item lines in the document currency, by input order (null when the line has none). */
  items: Array<{ forexRate: number | null; forexAmount: number | null }>;
  /** Invoice ledger lines in the document currency, by input order. */
  ledgers: Array<{ forexAmount: number | null }>;
  /** Entries of foreign-currency ledgers (posting order). */
  entries: Array<{
    lineNo: number;
    ledgerId: number;
    ledgerName: string;
    currency: ForexCurrency;
    forexAmount: number;
    rate: number | null;
    amount: Paise;
    bills: Array<{ refType: string; billName: string | null; amount: Paise; forexAmount: number }>;
  }>;
  /** Realised exchange difference posted by this voucher (signed, Dr + = loss) and its ledger. */
  gainLoss: Paise;
  gainLossLedger: { id: number; name: string } | null;
}

// ───────────────────────────── Print (PrintVoucherData.forex) ─────────────────────────────

/** Foreign-currency block of a printed document (export / import invoice, forex receipt / payment). */
export interface PrintForex {
  currency: { symbol: string; isoCode: string | null; formalName: string; decimalPlaces: number };
  /** Rate of exchange of the document (rupees per unit); null for a voucher with per-line rates. */
  rate: number | null;
  /** Invoice layout: aligned with PrintVoucherData.lines — rate per unit and amount in the currency. */
  lines: Array<{ rate: number | null; amount: number }>;
  /** Aligned with PrintVoucherData.charges. */
  charges: number[];
  /** GST (and other amounts payable by the party) in the currency, so the column adds up to `total`. */
  tax: number;
  /** Document value in the currency (what the party owes / is owed), or null. */
  total: number | null;
  totalInWords: string | null;
  /** Printed under the totals: currency, rate and that GST is in rupees. */
  note: string;
  /** Voucher layout: foreign amounts of the entries kept in a foreign currency, in posting order. */
  entries: Array<{ ledgerName: string; forexAmount: number; rate: number | null; text: string }>;
}

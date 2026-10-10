/**
 * Multi-currency arithmetic (forex module). Pure functions shared by core and renderer.
 *
 * Conventions:
 *  - A foreign amount is a number in the currency's MAJOR unit (1250.5 = $1,250.50), always rounded to
 *    the currency's decimal places (0–4) half away from zero. Signed like ledger amounts where it
 *    belongs to an entry (Dr +, Cr −).
 *  - A rate of exchange is rupees per ONE unit of the foreign currency (83.25 = ₹83.25 per $1), kept to
 *    at most RATE_DECIMALS decimal places.
 *  - Conversions are done in integer arithmetic (BigInt), so ₹ = round(forex × rate) is exact to the
 *    paisa for every amount a company can hold — no binary floating-point noise at .5 boundaries.
 */
import { allocate, roundPaise, type Paise } from './money.ts';
import { numberToWordsInternational } from './words.ts';

/** Decimal places a rate of exchange may have. */
export const RATE_DECIMALS = 6;
const RATE_SCALE = 10 ** RATE_DECIMALS;

/** Which rate of the exchange-rate master a voucher uses by default. */
export type ForexRateType = 'standard' | 'selling' | 'buying';
export const FOREX_RATE_TYPES: readonly ForexRateType[] = ['standard', 'selling', 'buying'];

function pow10(dp: number): number {
  return 10 ** Math.max(0, Math.min(4, Math.trunc(dp)));
}

/** Foreign amount → integer minor units (cents), half away from zero: toMinor(12.345, 2) = 1235. */
export function toMinor(amount: number, dp: number): number {
  return roundPaise(amount * pow10(dp));
}

/** Round a foreign amount to the currency's decimals: roundForex(12.345, 2) = 12.35. */
export function roundForex(amount: number, dp: number): number {
  const r = toMinor(amount, dp) / pow10(dp);
  return r === 0 ? 0 : r;
}

/** Rate snapped to RATE_DECIMALS as a scaled integer (83.25 → 83250000). */
export function scaledRate(rate: number): number {
  return roundPaise(rate * RATE_SCALE);
}

/** Round a rate to RATE_DECIMALS. */
export function roundRate(rate: number): number {
  return scaledRate(rate) / RATE_SCALE;
}

/** round(n / d) half away from zero, BigInt. */
function divRound(n: bigint, d: bigint): bigint {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/**
 * INR paise of a foreign amount at a rate: forexToPaise(1000, 2, 83.25) = 8325000 (₹83,250.00).
 * Signed (the sign of `amount`).
 */
export function forexToPaise(amount: number, dp: number, rate: number): Paise {
  const minor = BigInt(toMinor(amount, dp));
  const r = BigInt(scaledRate(rate));
  // paise = minor / 10^dp × rate × 100 = minor × r × 100 / (10^dp × RATE_SCALE)
  const out = Number(divRound(minor * r * 100n, BigInt(pow10(dp)) * BigInt(RATE_SCALE)));
  return out === 0 ? 0 : out;
}

/** Foreign amount of INR paise at a rate, rounded to the currency's decimals (signed). */
export function paiseToForex(paise: Paise, rate: number, dp: number): number {
  const r = scaledRate(rate);
  if (r === 0) return 0;
  // forex minor = paise / 100 / rate × 10^dp = paise × RATE_SCALE × 10^dp / (100 × r)
  const minor = Number(divRound(BigInt(paise) * BigInt(RATE_SCALE) * BigInt(pow10(dp)), 100n * BigInt(r)));
  const out = minor / pow10(dp);
  return out === 0 ? 0 : out;
}

/** Split a foreign amount over weights so the parts add up exactly (largest remainder, in minor units). */
export function allocateForex(total: number, weights: readonly number[], dp: number): number[] {
  return allocate(toMinor(total, dp), weights).map((m) => (m === 0 ? 0 : m / pow10(dp)));
}

/** Add foreign amounts exactly (in minor units). */
export function sumForex(values: readonly number[], dp: number): number {
  let s = 0;
  for (const v of values) s += toMinor(v, dp);
  return s === 0 ? 0 : s / pow10(dp);
}

/**
 * INR booked for part of a bill: the bill holds `billPaise` for `billForex`; `forexPart` of it is
 * settled. Settling the whole remaining forex takes the whole remaining INR (no residue is left on a
 * bill whose foreign amount is cleared).
 */
export function bookedPaise(billPaise: Paise, billForex: number, forexPart: number, dp: number): Paise {
  const whole = toMinor(billForex, dp);
  const part = toMinor(forexPart, dp);
  if (whole === 0) return 0;
  if (Math.abs(part) >= Math.abs(whole)) return billPaise;
  const out = Number(divRound(BigInt(billPaise) * BigInt(Math.abs(part)), BigInt(Math.abs(whole))));
  return out === 0 ? 0 : out;
}

/** Effective rate of an INR / forex pair (0 when the forex is 0), rounded to RATE_DECIMALS. */
export function effectiveRate(paise: Paise, forex: number): number {
  if (forex === 0) return 0;
  return roundRate(Math.abs(paise / 100 / forex));
}

/** Pick a rate of a rate row by type, falling back to standard, then any rate present. */
export function pickRate(row: { standard: number | null; selling: number | null; buying: number | null } | null, type: ForexRateType): number | null {
  if (!row) return null;
  const want = row[type];
  if (want !== null && want > 0) return want;
  for (const t of ['standard', 'buying', 'selling'] as const) {
    const v = row[t];
    if (v !== null && v > 0) return v;
  }
  return null;
}

/**
 * Default rate type of a voucher (banking convention, as in TallyPrime's "selling / buying voucher
 * rate"): foreign currency coming IN (sales, receipts, credit notes reversing a sale) is converted at the
 * bank's BUYING rate; going OUT (purchases, payments, debit notes) at its SELLING rate; journals and
 * contras at the standard rate. The user can always type another rate on the voucher.
 */
export function defaultRateType(baseType: string): ForexRateType {
  if (baseType === 'sales' || baseType === 'receipt' || baseType === 'credit_note') return 'buying';
  if (baseType === 'purchase' || baseType === 'payment' || baseType === 'debit_note') return 'selling';
  return 'standard';
}

function groupWestern(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Foreign amount for display (international grouping): formatForex(1234567.5, 2, '$') = '$ 1,234,567.50'.
 * `absolute` drops the sign (Dr/Cr shown by the caller).
 */
export function formatForex(amount: number, dp: number, symbol?: string | null, opts: { absolute?: boolean } = {}): string {
  const places = Math.max(0, Math.min(4, Math.trunc(dp)));
  const minor = toMinor(amount, places);
  const abs = Math.abs(minor);
  const f = pow10(places);
  const whole = groupWestern(String(Math.floor(abs / f)));
  const frac = places > 0 ? `.${String(abs % f).padStart(places, '0')}` : '';
  const body = `${whole}${frac}`;
  const signed = !opts.absolute && minor < 0 ? `-${body}` : body;
  return symbol ? (signed.startsWith('-') ? `-${symbol} ${signed.slice(1)}` : `${symbol} ${signed}`) : signed;
}

/** Signed foreign amount → '1,250.00 Dr' / '1,250.00 Cr' ('' for zero). */
export function formatForexDrCr(amount: number, dp: number, symbol?: string | null): string {
  if (toMinor(amount, dp) === 0) return '';
  return `${formatForex(amount, dp, symbol, { absolute: true })} ${amount > 0 ? 'Dr' : 'Cr'}`;
}

/** Rate for display: up to RATE_DECIMALS, at least 2 decimals: 83.25 → '83.25', 83.2567 → '83.2567'. */
export function formatExchangeRate(rate: number): string {
  const s = roundRate(rate).toFixed(RATE_DECIMALS).replace(/0+$/, '');
  const [i, f = ''] = s.split('.');
  return `${groupWestern(i)}.${f.padEnd(2, '0')}`;
}

/**
 * Parse a typed foreign amount ('1,250.50', '-12', '$ 10'); null when not a number. Not rounded.
 */
export function parseForex(text: string): number | null {
  const t = text.trim().replace(/^[^\d.+-]+/, '').replace(/[,\s]/g, '');
  if (t === '' || t.length > 40 || !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Amount in words for a foreign-currency invoice, cheque style (no sub-unit names are kept in the
 * currency master): amountInWordsForex(1250.5, 2, 'US Dollar') = 'US Dollar One Thousand Two Hundred
 * Fifty and 50/100 Only'.
 */
export function amountInWordsForex(amount: number, dp: number, currencyName: string): string {
  const places = Math.max(0, Math.min(4, Math.trunc(dp)));
  const minor = Math.abs(toMinor(amount, places));
  const f = pow10(places);
  const whole = Math.floor(minor / f);
  const frac = minor % f;
  const minus = amount < 0 && minor !== 0 ? 'Minus ' : '';
  const fracText = places > 0 && frac > 0 ? ` and ${String(frac).padStart(places, '0')}/${f}` : '';
  return `${minus}${currencyName} ${numberToWordsInternational(whole)}${fracText} Only`;
}

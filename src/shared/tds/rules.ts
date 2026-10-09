/**
 * TDS / TCS statutory rules that are pure functions of dates and amounts: PAN / TAN format, the
 * income-tax year, deposit due dates, interest u/s 201(1A) / 206C(7), quarterly statement due dates
 * and late fee u/s 234E. Shared by core and renderer. Money is integer paise.
 *
 * Sources (Income-tax Act 1961 / Income-tax Rules 1962, as in force for FY 2025-26):
 *  - Deposit: Rule 30(2) — TDS by the 7th of the following month; for tax deducted in March, by 30 April.
 *    Rule 37CA — TCS by the 7th of the following month (March included: 7 April).
 *  - Interest s.201(1A): 1% per month or part of a month from the date tax was deductible to the date it
 *    is deducted; 1.5% per month or part from the date of deduction to the date of payment. s.206C(7)
 *    (TCS): 1% per month or part from the date collectible to the date paid. "Month or part" is counted
 *    in calendar months, both end months included (the way TRACES computes it).
 *  - Statements: Rule 31A (24Q/26Q/27Q) — 31 Jul, 31 Oct, 31 Jan, 31 May; Rule 31AA (27EQ) — 15 Jul,
 *    15 Oct, 15 Jan, 15 May.
 *  - s.234E: ₹200 for every day the statement is late, not exceeding the tax deductible/collectible.
 * The Income-tax Act 2025 (from 1-Apr-2026, "tax year") carries these forward in substance; verify the
 * dates against the Rules notified under it before relying on them for tax year 2026-27 onwards.
 */
import { addDays, diffDays, parts, toIso } from '../dates.ts';
import type { Paise } from '../money.ts';
import type { DeducteeType, PanStatus, TdsKind } from '../types/tds.ts';

/** PAN: 5 letters, 4 digits, 1 letter; the 4th letter is the holder's status. */
export const PAN_RE = /^[A-Z]{3}[ABCEFGHJLPT][A-Z][0-9]{4}[A-Z]$/;
/** TAN: 4 letters, 5 digits, 1 letter. */
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

export function normalizePan(pan: string | null | undefined): string {
  return (pan ?? '').trim().toUpperCase();
}

/** 'PANNOTAVBL' (the placeholder used in statements) counts as missing. */
export function panStatus(pan: string | null | undefined): PanStatus {
  const p = normalizePan(pan);
  if (p === '' || p === 'PANNOTAVBL' || p === 'PANAPPLIED' || p === 'PANINVALID') return 'missing';
  return PAN_RE.test(p) ? 'valid' : 'invalid';
}

/** Deductee type suggested by the 4th character of a valid PAN (C company, P/H individual/HUF, F/E firm/LLP). */
export function deducteeTypeFromPan(pan: string | null | undefined): DeducteeType | null {
  const p = normalizePan(pan);
  if (!PAN_RE.test(p)) return null;
  const c = p[3];
  if (c === 'C') return 'company';
  if (c === 'P' || c === 'H') return 'individual';
  if (c === 'F' || c === 'E') return 'firm';
  return 'others';
}

export const DEDUCTEE_LABEL: Readonly<Record<DeducteeType, string>> = {
  company: 'Company',
  individual: 'Individual / HUF',
  firm: 'Firm / LLP',
  others: 'Others (AOP, BOI, trust, …)',
};

// ───────────────────────────── Income-tax year ─────────────────────────────

export interface TaxYear {
  /** 2025 for FY 2025-26. */
  startYear: number;
  start: string;
  end: string;
  /** '2025-26' */
  label: string;
}

/** Income-tax financial year (always April → March, whatever the company's books year). */
export function taxYearOf(iso: string): TaxYear {
  const { y, m } = parts(iso);
  const startYear = m >= 4 ? y : y - 1;
  return taxYear(startYear);
}

export function taxYear(startYear: number): TaxYear {
  return { startYear, start: toIso(startYear, 4, 1), end: toIso(startYear + 1, 3, 31), label: `${startYear}-${String(startYear + 1).slice(-2)}` };
}

/** 'YYYY-MM' of a date. */
export function periodOf(iso: string): string {
  return iso.slice(0, 7);
}

/** First and last day of a 'YYYY-MM' period. */
export function periodRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const from = toIso(y, m, 1);
  const to = addDays(toIso(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), -1);
  return { from, to };
}

export type Quarter = 1 | 2 | 3 | 4;

/** Quarter of the income-tax year (Apr–Jun = 1). */
export function quarterOf(iso: string): Quarter {
  const { m } = parts(iso);
  return (Math.floor(((m - 4 + 12) % 12) / 3) + 1) as Quarter;
}

export function quarterRange(startYear: number, q: Quarter): { from: string; to: string } {
  const firstMonth = 4 + (q - 1) * 3; // 4, 7, 10, 13
  const y = firstMonth > 12 ? startYear + 1 : startYear;
  const m = firstMonth > 12 ? firstMonth - 12 : firstMonth;
  const from = toIso(y, m, 1);
  const last = periodRange(`${y}-${String(m + 2).padStart(2, '0')}`).to;
  return { from, to: last };
}

// ───────────────────────────── Deposit due date ─────────────────────────────

/** Due date to deposit tax deducted / collected on `iso` (Rule 30 / Rule 37CA). */
export function depositDueDate(kind: TdsKind, iso: string): string {
  const { y, m } = parts(iso);
  if (kind === 'tds' && m === 3) return toIso(y, 4, 30);
  return m === 12 ? toIso(y + 1, 1, 7) : toIso(y, m + 1, 7);
}

/** Due date for a 'YYYY-MM' period. */
export function periodDueDate(kind: TdsKind, period: string): string {
  return depositDueDate(kind, `${period}-01`);
}

// ───────────────────────────── Interest ─────────────────────────────

/**
 * Months "or part of a month" from `from` to `to`, counted in calendar months with both end months
 * included (15-Jan → 10-Feb = 2). 0 when `to` is before `from`.
 */
export function interestMonths(from: string, to: string): number {
  if (to < from) return 0;
  const a = parts(from);
  const b = parts(to);
  return (b.y * 12 + b.m) - (a.y * 12 + a.m) + 1;
}

/** amount × ratePerMonth% × months, rounded to the rupee (interest is paid in whole rupees). */
export function interestAmount(amount: Paise, ratePerMonth: number, months: number): Paise {
  if (amount <= 0 || months <= 0) return 0;
  return Math.round((amount * ratePerMonth * months) / 100 / 100) * 100;
}

/**
 * Interest for late deposit of tax deducted on `deductedOn`, paid (or still unpaid) on `paidOn`:
 * TDS s.201(1A)(ii) 1.5% / TCS s.206C(7) 1% per month or part, from the deduction/collection date to
 * the payment date — only when paid after the due date.
 */
export function lateDepositInterest(kind: TdsKind, amount: Paise, deductedOn: string, paidOn: string): { months: number; rate: number; interest: Paise } {
  const due = depositDueDate(kind, deductedOn);
  const rate = kind === 'tds' ? 1.5 : 1;
  if (paidOn <= due) return { months: 0, rate, interest: 0 };
  const months = interestMonths(deductedOn, paidOn);
  return { months, rate, interest: interestAmount(amount, rate, months) };
}

/** Interest s.201(1A)(i): 1% per month or part from the date tax was deductible to the date deducted (or `asOf`). */
export function nonDeductionInterest(amount: Paise, deductibleOn: string, deductedOn: string): { months: number; interest: Paise } {
  const months = interestMonths(deductibleOn, deductedOn);
  return { months, interest: interestAmount(amount, 1, months) };
}

// ───────────────────────────── Quarterly statements ─────────────────────────────

export type TdsForm = '26Q' | '27Q' | '27EQ';
export const TDS_FORMS: readonly TdsForm[] = ['26Q', '27Q', '27EQ'];

export const FORM_LABEL: Readonly<Record<TdsForm, string>> = {
  '26Q': '26Q — TDS on payments to residents (other than salary)',
  '27Q': '27Q — TDS on payments to non-residents',
  '27EQ': '27EQ — TCS',
};

/** Due date of a quarterly statement (Rule 31A / 31AA). */
export function statementDueDate(form: TdsForm, startYear: number, q: Quarter): string {
  const day = form === '27EQ' ? 15 : 31;
  if (q === 1) return toIso(startYear, 7, day);
  if (q === 2) return toIso(startYear, 10, day);
  if (q === 3) return toIso(startYear + 1, 1, day);
  return toIso(startYear + 1, 5, day);
}

/** s.234E: ₹200 per day of delay (filed on, or still not filed at `asOf`), capped at the tax of the statement. */
export function lateFee234E(dueDate: string, filedOrAsOf: string, cap: Paise): { days: number; fee: Paise } {
  const days = Math.max(0, diffDays(dueDate, filedOrAsOf));
  return { days, fee: Math.min(days * 200_00, Math.max(0, cap)) };
}

// ───────────────────────────── Amounts ─────────────────────────────

/** Tax on `base` at `rate`% — rounded to the nearest rupee (default) or to the paisa. */
export function taxOn(base: Paise, rate: number, roundToRupee = true): Paise {
  if (base <= 0 || rate <= 0) return 0;
  const exact = (base * rate) / 100;
  return roundToRupee ? Math.round(exact / 100) * 100 : Math.round(exact);
}

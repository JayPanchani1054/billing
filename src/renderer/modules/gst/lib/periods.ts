/**
 * Return-period choices for the GST screens (pure; see periods.test.ts).
 *
 * 'gst.periods' lists months (and quarters for quarterly filers) newest first. GSTR-1 / GSTR-3B pick
 * one key; GSTR-9 picks a GST financial year ('2026-27').
 */
import type { GstPeriodsResult, ReturnPeriod } from '../../../../shared/types/gst-returns.ts';

export interface PeriodOption {
  value: string;
  label: string;
}

export interface PeriodOptionGroup {
  /** 'FY 2026-27'. */
  label: string;
  options: PeriodOption[];
}

/** 'Apr 2026 · 12 documents', 'Q1 (Apr–Jun) 2026-27 · current', 'May 2026 · no entries'. */
export function periodOptionLabel(p: ReturnPeriod): string {
  const docs = p.outwardCount + p.inwardCount;
  const bits = [p.label];
  if (p.isCurrent) bits.push('current');
  bits.push(docs === 0 ? 'no entries' : `${docs} document${docs === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/**
 * Options grouped by GST financial year, newest first. Quarterly filers get the quarters first in
 * each year (the return they file) and then the months (IFF / review).
 */
export function periodOptionGroups(r: GstPeriodsResult): PeriodOptionGroup[] {
  const byFy = new Map<string, { quarters: PeriodOption[]; months: PeriodOption[] }>();
  for (const p of r.periods) {
    const g = byFy.get(p.fy) ?? { quarters: [], months: [] };
    (p.kind === 'quarter' ? g.quarters : g.months).push({ value: p.key, label: periodOptionLabel(p) });
    byFy.set(p.fy, g);
  }
  return [...byFy.entries()].map(([fy, g]) => ({ label: `FY ${fy}`, options: [...g.quarters, ...g.months] }));
}

/** The period to open: the requested key when it exists, else the one most likely being filed now. */
export function initialPeriodKey(r: GstPeriodsResult | undefined, requested?: string | null): string | null {
  if (!r || r.periods.length === 0) return null;
  const has = (k: string | null | undefined): k is string => !!k && r.periods.some((p) => p.key === k);
  if (has(requested)) return requested;
  if (has(r.suggested)) return r.suggested;
  if (has(r.current)) return r.current;
  const preferred = r.periods.find((p) => (r.filingFrequency === 'quarterly' ? p.kind === 'quarter' : p.kind === 'month'));
  return (preferred ?? r.periods[0]).key;
}

export function findPeriod(r: GstPeriodsResult | undefined, key: string | null): ReturnPeriod | null {
  if (!r || !key) return null;
  return r.periods.find((p) => p.key === key) ?? null;
}

/** Previous / next period of the same kind (for PgUp / PgDn); null at the ends. */
export function stepPeriod(r: GstPeriodsResult | undefined, key: string | null, dir: -1 | 1): string | null {
  const cur = findPeriod(r, key);
  if (!r || !cur) return null;
  const same = r.periods.filter((p) => p.kind === cur.kind); // newest first
  const i = same.findIndex((p) => p.key === cur.key);
  const j = i - dir; // older = higher index
  return j >= 0 && j < same.length ? same[j].key : null;
}

/** GST financial years present in the period list, newest first. */
export function fyList(r: GstPeriodsResult | undefined): string[] {
  if (!r) return [];
  const seen: string[] = [];
  for (const p of r.periods) if (!seen.includes(p.fy)) seen.push(p.fy);
  return seen.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Last day of a GST financial year label ('2026-27' → '2027-03-31'). */
export function fyEnd(fy: string): string {
  return `${Number(fy.slice(0, 4)) + 1}-03-31`;
}

/** GSTR-9 default: the latest year that has ended by the working date, else the newest year. */
export function initialFy(r: GstPeriodsResult | undefined, workingDate: string, requested?: string | null): string | null {
  const years = fyList(r);
  if (years.length === 0) return null;
  if (requested && years.includes(requested)) return requested;
  return years.find((fy) => fyEnd(fy) < workingDate) ?? years[0];
}

const lastDayOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The return-period key of a date range when it is exactly one month ('042026') or one GST quarter
 * ('2026-27-Q1' = 1-Apr to 30-Jun 2026); null for any other range.
 */
export function periodKeyForRange(from: string, to: string): string | null {
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (!f || !t || f[3] !== '01') return null;
  const fy = Number(f[1]);
  const fm = Number(f[2]);
  const ty = Number(t[1]);
  const tm = Number(t[2]);
  if (Number(t[3]) !== lastDayOfMonth(ty, tm)) return null;
  if (fy === ty && fm === tm) return `${f[2]}${f[1]}`;
  const span = (ty - fy) * 12 + (tm - fm);
  if (span !== 2 || (fm - 1) % 3 !== 0) return null;
  // GST year starts in April: Apr–Jun Q1, Jul–Sep Q2, Oct–Dec Q3, Jan–Mar Q4 (of the previous April's year).
  const startYear = fm >= 4 ? fy : fy - 1;
  const q = fm >= 4 ? (fm - 4) / 3 + 1 : 4;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}-Q${q}`;
}

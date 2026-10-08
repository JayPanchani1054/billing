/**
 * Statement-line ↔ book-entry matching: a pure, deterministic scoring engine (no DB).
 *
 * Eligibility: the same signed amount (bank deposit + ↔ debit to the bank ledger; withdrawal − ↔ credit) and
 * a statement date from (voucher/cheque date − 2 days) to (voucher date + window). Cheques whose number appears
 * in the statement may be presented up to 92 days later. An entry that already carries a bank date (entered by
 * hand) only matches a line within 2 days of that bank date.
 *
 * Score (0–100):  amount 50
 *               + date 25 − 3/day late (− 8/day early), floor 0
 *               + cheque/UTR/reference no. found in the statement 30 (last digits only: 15)
 *               + party-name tokens found in the narration up to 15 (share of the name's significant words)
 *               + instrument kind agrees (NEFT/RTGS/IMPS/UPI/cheque/ATM/card in the narration) 5
 *               + hand-entered bank date equal to the statement date 20 (within 2 days: 10)
 * A pair is applied automatically when score ≥ threshold (70) and it beats every competing pair (same line or
 * same entry, not taken by an applied match) by ≥ 10 points. The displayed score is capped at 100; ordering and
 * the 10-point lead use the uncapped sum, so a reference-backed pair is not called ambiguous next to a plain one. Pairs are taken in descending score with
 * deterministic tie-breaks, one-to-one.
 */
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { MatchReason } from '../../../shared/types/banking.ts';
import type { InstrumentType } from '../../../shared/types/vouchers.ts';
import { dayDiff, squash, tokens } from './values.ts';

export interface MatchLine {
  id: number;
  txnDate: string;
  amount: Paise;
  description: string;
  reference: string;
}

export interface MatchEntry {
  id: number;
  /** Voucher date. */
  date: string;
  /** Signed book amount on the bank ledger. */
  amount: Paise;
  instrumentType: string | null;
  instrumentNo: string | null;
  instrumentDate: string | null;
  bankDate: string | null;
  /** Other side of the voucher (party / expense ledger name). */
  particulars: string;
}

export interface MatchOptions {
  /** Days after the voucher date (default 7). */
  dateWindowDays: number;
  /** Days before the voucher (or cheque) date (default 2). */
  earlyToleranceDays: number;
  /** Minimum score to apply automatically (default 70). */
  threshold: number;
  /** Lead over the best competing pair needed to apply automatically (default 10). */
  margin: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { dateWindowDays: 7, earlyToleranceDays: 2, threshold: 70, margin: 10 };

export const POINTS = {
  amount: 50,
  dateMax: 25,
  latePerDay: 3,
  earlyPerDay: 8,
  reference: 30,
  referencePartial: 15,
  partyMax: 15,
  instrument: 5,
  bankDateSame: 20,
  bankDateNear: 10,
} as const;

/** CTS cheques are valid for 3 months: a cheque whose number is in the statement may be presented that late. */
export const CHEQUE_WINDOW_DAYS = 92;

export interface ScoredPair {
  lineId: number;
  entryId: number;
  lineDate: string;
  entryDate: string;
  score: number;
  /** Statement date − voucher date (days). */
  dayGap: number;
  reasons: MatchReason[];
  /**
   * Sum of the points before the cap at 100. Ordering and the ambiguity margin use it, so a candidate backed
   * by its UTR / cheque number still beats a merely plausible one when both reach 100.
   */
  rawScore: number;
}

/** Words that say nothing about who the party is. */
const STOP_WORDS = new Set([
  'LTD', 'LIMITED', 'PVT', 'PRIVATE', 'THE', 'AND', 'CO', 'COMPANY', 'LLP', 'INC', 'MS', 'INDIA', 'CORP', 'CORPORATION',
  'ENTERPRISES', 'ENTERPRISE', 'TRADERS', 'TRADING', 'SONS', 'BROS', 'BROTHERS', 'ACCOUNT', 'BANK', 'MR', 'MRS', 'SHRI',
  'SMT', 'AGENCY', 'AGENCIES', 'INDUSTRIES', 'SERVICES', 'SOLUTIONS', 'STORE', 'STORES', 'FIRM', 'GROUP',
]);

/** Instrument kind named in a bank narration ('NEFT-…', 'BY CLG', 'ATM WDL', 'UPI/…'), or null. */
export function instrumentFromNarration(text: string): InstrumentType | null {
  const t = text.toUpperCase();
  if (/\bNEFT\b/.test(t)) return 'neft';
  if (/\bRTGS\b/.test(t)) return 'rtgs';
  if (/\b(IMPS|MMT)\b/.test(t)) return 'imps';
  if (/\bUPI\b/.test(t)) return 'upi';
  if (/\b(CHQ|CHEQUE|CLG|CTS|CLEARING|MICR|INWARD CLG|OUTWARD CLG)\b/.test(t)) return 'cheque';
  if (/\bDD\b|DEMAND DRAFT/.test(t)) return 'dd';
  if (/\b(ATM|CASH|CSH|SELF)\b/.test(t)) return 'cash';
  if (/\b(POS|ECOM|CARD|VISA|RUPAY|MASTERCARD)\b/.test(t)) return 'card';
  return null;
}

/** 'full' when the instrument/reference number is in the statement line, 'partial' for its last digits only. */
export function referenceHit(instrumentNo: string | null, line: Pick<MatchLine, 'reference' | 'description'>): 'full' | 'partial' | null {
  if (!instrumentNo) return null;
  const inst = squash(instrumentNo);
  if (inst.length < 3) return null;
  const text = `${line.reference} ${line.description}`;
  if (/^\d+$/.test(inst)) {
    const stripped = inst.replace(/^0+/, '');
    if (stripped.length < 3) return null;
    const runs = (text.match(/\d+/g) ?? []).map((r) => r.replace(/^0+/, ''));
    if (runs.some((r) => r === stripped || (stripped.length >= 8 && r.includes(stripped)))) return 'full';
    if (stripped.length >= 10 && runs.some((r) => r.includes(stripped.slice(-6)))) return 'partial';
    return null;
  }
  const hay = squash(text);
  if (hay.includes(inst)) return 'full';
  if (inst.length >= 10 && hay.includes(inst.slice(-8))) return 'partial';
  return null;
}

/** Significant words of a party name found in the narration (prefix matches for truncated names). */
export function partyHit(particulars: string, line: Pick<MatchLine, 'reference' | 'description'>): { matched: string[]; total: number } {
  const words = tokens(particulars).filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  if (words.length === 0) return { matched: [], total: 0 };
  const narration = tokens(`${line.description} ${line.reference}`);
  const joined = words.join('');
  if (joined.length >= 6 && squash(line.description).includes(joined)) return { matched: words, total: words.length };
  const matched = words.filter((w) => narration.some((n) => n === w || (n.length >= 4 && w.startsWith(n)) || (w.length >= 4 && n.startsWith(w))));
  return { matched, total: words.length };
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Score one line against one entry; null when the pair is not eligible. */
export function scorePair(line: MatchLine, entry: MatchEntry, opts: MatchOptions = DEFAULT_MATCH_OPTIONS): ScoredPair | null {
  if (line.amount !== entry.amount || line.amount === 0) return null;
  const gap = dayDiff(entry.date, line.txnDate);
  const earliest = entry.instrumentDate !== null && entry.instrumentDate < entry.date ? entry.instrumentDate : entry.date;
  if (dayDiff(earliest, line.txnDate) < -opts.earlyToleranceDays) return null;
  const ref = referenceHit(entry.instrumentNo, line);
  let bankDatePoints = 0;
  if (entry.bankDate !== null) {
    const d = Math.abs(dayDiff(entry.bankDate, line.txnDate));
    if (d > 2) return null;
    bankDatePoints = d === 0 ? POINTS.bankDateSame : POINTS.bankDateNear;
  }
  const isCheque = entry.instrumentType === 'cheque' || entry.instrumentType === 'dd';
  const window = isCheque && ref === 'full' ? Math.max(opts.dateWindowDays, CHEQUE_WINDOW_DAYS) : opts.dateWindowDays;
  if (gap > window && bankDatePoints === 0) return null;

  const reasons: MatchReason[] = [{ code: 'amount', points: POINTS.amount, text: `Same amount ${formatMoney(Math.abs(line.amount), { symbol: true })}` }];
  let score = POINTS.amount;
  const datePoints = Math.max(0, gap >= 0 ? POINTS.dateMax - POINTS.latePerDay * gap : POINTS.dateMax - POINTS.earlyPerDay * -gap);
  score += datePoints;
  reasons.push({
    code: 'date',
    points: datePoints,
    text: gap === 0 ? 'Same date as the voucher' : gap > 0 ? `${plural(gap, 'day')} after the voucher date` : `${plural(-gap, 'day')} before the voucher date`,
  });
  if (ref) {
    const pts = ref === 'full' ? POINTS.reference : POINTS.referencePartial;
    score += pts;
    reasons.push({
      code: 'reference',
      points: pts,
      text: ref === 'full' ? `Cheque/ref. no. ${entry.instrumentNo} is in the statement` : `Last digits of ref. no. ${entry.instrumentNo} are in the statement`,
    });
  }
  const party = partyHit(entry.particulars, line);
  if (party.matched.length > 0) {
    const pts = Math.round((POINTS.partyMax * party.matched.length) / party.total);
    score += pts;
    reasons.push({ code: 'party', points: pts, text: `Narration names ${entry.particulars} (${party.matched.join(', ')})` });
  }
  const kind = instrumentFromNarration(`${line.description} ${line.reference}`);
  if (kind !== null && kind === entry.instrumentType) {
    score += POINTS.instrument;
    reasons.push({ code: 'instrument', points: POINTS.instrument, text: `Statement shows ${kind.toUpperCase()} like the voucher` });
  }
  if (bankDatePoints > 0) {
    score += bankDatePoints;
    reasons.push({ code: 'bank_date', points: bankDatePoints, text: bankDatePoints === POINTS.bankDateSame ? 'Bank date already entered for this date' : 'Bank date already entered within 2 days' });
  }
  return { lineId: line.id, entryId: entry.id, lineDate: line.txnDate, entryDate: entry.date, score: Math.min(100, score), dayGap: gap, reasons, rawScore: score };
}

/** Deterministic order: raw score ↓, |day gap| ↑, statement date ↑, line id ↑, voucher date ↑, entry id ↑. */
export function comparePairs(a: ScoredPair, b: ScoredPair): number {
  return (
    b.rawScore - a.rawScore ||
    Math.abs(a.dayGap) - Math.abs(b.dayGap) ||
    (a.lineDate < b.lineDate ? -1 : a.lineDate > b.lineDate ? 1 : 0) ||
    a.lineId - b.lineId ||
    (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) ||
    a.entryId - b.entryId
  );
}

/** Every eligible pair, best first. */
export function scoreAll(lines: readonly MatchLine[], entries: readonly MatchEntry[], opts: MatchOptions = DEFAULT_MATCH_OPTIONS): ScoredPair[] {
  const byAmount = new Map<number, MatchEntry[]>();
  for (const e of entries) {
    const list = byAmount.get(e.amount);
    if (list) list.push(e);
    else byAmount.set(e.amount, [e]);
  }
  const pairs: ScoredPair[] = [];
  for (const l of lines) {
    for (const e of byAmount.get(l.amount) ?? []) {
      const p = scorePair(l, e, opts);
      if (p) pairs.push(p);
    }
  }
  return pairs.sort(comparePairs);
}

export interface PendingLine {
  lineId: number;
  reason: 'ambiguous' | 'low_score';
  /** Best first, at most 3, excluding entries taken by applied matches. */
  candidates: ScoredPair[];
}

export interface Assignment {
  applied: ScoredPair[];
  pending: PendingLine[];
  /** Lines with no eligible entry left. */
  withoutCandidates: number[];
}

/** One-to-one assignment by descending score; only confident, unambiguous pairs are applied. */
export function assignMatches(lines: readonly MatchLine[], entries: readonly MatchEntry[], opts: MatchOptions = DEFAULT_MATCH_OPTIONS): Assignment {
  const pairs = scoreAll(lines, entries, opts);
  const byLine = new Map<number, ScoredPair[]>();
  const byEntry = new Map<number, ScoredPair[]>();
  const add = (map: Map<number, ScoredPair[]>, key: number, p: ScoredPair): void => {
    const list = map.get(key);
    if (list) list.push(p);
    else map.set(key, [p]);
  };
  for (const p of pairs) {
    add(byLine, p.lineId, p);
    add(byEntry, p.entryId, p);
  }
  const doneLines = new Set<number>();
  const doneEntries = new Set<number>();
  const applied: ScoredPair[] = [];
  for (const p of pairs) {
    if (p.score < opts.threshold) break; // sorted: nothing further can qualify
    if (doneLines.has(p.lineId) || doneEntries.has(p.entryId)) continue;
    let alt = 0;
    for (const q of byLine.get(p.lineId) ?? []) if (q !== p && !doneEntries.has(q.entryId)) alt = Math.max(alt, q.rawScore);
    for (const q of byEntry.get(p.entryId) ?? []) if (q !== p && !doneLines.has(q.lineId)) alt = Math.max(alt, q.rawScore);
    if (p.rawScore - alt < opts.margin) continue;
    applied.push(p);
    doneLines.add(p.lineId);
    doneEntries.add(p.entryId);
  }
  const pending: PendingLine[] = [];
  const withoutCandidates: number[] = [];
  // Statement order (date, id) so the result does not depend on the order the lines were passed in.
  const ordered = [...lines].sort((a, b) => (a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1 : a.id - b.id));
  for (const l of ordered) {
    if (doneLines.has(l.id)) continue;
    const candidates = (byLine.get(l.id) ?? []).filter((q) => !doneEntries.has(q.entryId)).slice(0, 3);
    if (candidates.length === 0) withoutCandidates.push(l.id);
    else pending.push({ lineId: l.id, reason: candidates[0].score >= opts.threshold ? 'ambiguous' : 'low_score', candidates });
  }
  return { applied, pending, withoutCandidates };
}

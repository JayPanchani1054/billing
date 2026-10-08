/**
 * Pure logic of the auto-match review screen: tabs, the voucher kind and contra ledger proposed for an
 * unmatched statement line, which ledgers fit a kind, and building the bulk-create request.
 */
import type { LedgerClassName } from '../../../../shared/types/accounts.ts';
import type { CreateFromLineInput, FromLineKind, MatchReason, StatementLineStatus, StatementLineView } from '../../../../shared/types/banking.ts';

export type MatchTab = 'matched' | 'suggestions' | 'unmatched' | 'ignored';

/** Which tab a line belongs on (suggestions = unmatched lines the last auto-match found candidates for). */
export function tabOf(line: Pick<StatementLineView, 'id' | 'status'>, suggested: ReadonlySet<number>): MatchTab {
  if (line.status === 'matched' || line.status === 'created') return 'matched';
  if (line.status === 'ignored') return 'ignored';
  return suggested.has(line.id) ? 'suggestions' : 'unmatched';
}

export function countTabs(lines: readonly Pick<StatementLineView, 'id' | 'status'>[], suggested: ReadonlySet<number>): Record<MatchTab, number> {
  const c: Record<MatchTab, number> = { matched: 0, suggestions: 0, unmatched: 0, ignored: 0 };
  for (const l of lines) c[tabOf(l, suggested)]++;
  return c;
}

const CASH_WORDS = /\b(ATM|CASH|CSH|SELF|CDM|CASH\s*DEP(OSIT)?|BY\s+CASH|TO\s+CASH)\b/i;
const TRANSFER_WORDS = /\b(SELF\s*TRANSFER|OWN\s*A\/?C|SWEEP|FD\s*(BOOKING|CLOSURE)|TRF\s+TO\s+OWN)\b/i;

/** Contra for cash withdrawn/deposited and transfers to own accounts; else Receipt (deposit) / Payment (withdrawal). */
export function defaultKind(line: Pick<StatementLineView, 'amount' | 'description'>): FromLineKind {
  if (CASH_WORDS.test(line.description) || TRANSFER_WORDS.test(line.description)) return 'contra';
  return line.amount > 0 ? 'receipt' : 'payment';
}

export function allowedKinds(amount: number): FromLineKind[] {
  return amount > 0 ? ['receipt', 'contra'] : ['payment', 'contra'];
}

export const KIND_LABEL: Record<FromLineKind, string> = { receipt: 'Receipt', payment: 'Payment', contra: 'Contra' };

export interface LedgerOption {
  id: number;
  name: string;
  alias?: string | null;
  groupName: string;
  classes: readonly LedgerClassName[];
}

/** Contra needs a Cash/Bank ledger (not the bank itself); Receipt/Payment need anything else. */
export function ledgerFitsKind(ledger: LedgerOption, kind: FromLineKind, bankLedgerId: number): boolean {
  if (ledger.id === bankLedgerId) return false;
  const cashBank = ledger.classes.includes('cash_bank');
  return kind === 'contra' ? cashBank : !cashBank;
}

const NOISE = new Set([
  'NEFT', 'RTGS', 'IMPS', 'UPI', 'CR', 'DR', 'BY', 'TO', 'TRF', 'TRANSFER', 'CHQ', 'CHEQUE', 'CLG', 'INW', 'INWARD', 'OUTWARD', 'MICR', 'CTS',
  'PAID', 'RECEIVED', 'FROM', 'THE', 'AND', 'LTD', 'LIMITED', 'PVT', 'PRIVATE', 'BANK', 'ACCOUNT', 'AC', 'NO', 'REF', 'INB', 'MB', 'IB',
  'PAYMENT', 'RECEIPT', 'TRADERS', 'TRADING', 'ENTERPRISES', 'STORES', 'STORE', 'SERVICES', 'INDIA', 'CO', 'COMPANY',
]);

const words = (s: string): string[] =>
  s
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((w) => w.length >= 3 && !NOISE.has(w));

/** Keyword families: a narration word → words a ledger name may use for the same thing. */
const SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['CHARGES', 'CHARGE', 'CHGS', 'CHRG', 'SMS', 'FEE', 'FEES', 'COMMISSION', 'GST'],
  ['INTEREST', 'INT', 'INTT'],
  ['SALARY', 'SALARIES', 'SAL', 'WAGES'],
  ['RENT', 'RENTAL'],
  ['ELECTRICITY', 'POWER', 'MSEDCL', 'BESCOM', 'TATAPOWER'],
  ['TELEPHONE', 'MOBILE', 'AIRTEL', 'JIO', 'BSNL', 'VODAFONE'],
];

function expand(ws: readonly string[]): Set<string> {
  const out = new Set(ws);
  for (const w of ws) for (const fam of SYNONYMS) if (fam.includes(w)) for (const f of fam) out.add(f);
  return out;
}

/**
 * The ledger whose name shares the most significant words with the narration (synonyms count: "SMS CHGS"
 * finds "Bank Charges"). Null when nothing matches or two ledgers tie.
 */
export function suggestLedger(line: Pick<StatementLineView, 'description' | 'amount'>, ledgers: readonly LedgerOption[], kind: FromLineKind, bankLedgerId: number): LedgerOption | null {
  const narration = expand(words(line.description));
  if (narration.size === 0) return null;
  let best: LedgerOption | null = null;
  let bestScore = 0;
  let tie = false;
  for (const l of ledgers) {
    if (!ledgerFitsKind(l, kind, bankLedgerId)) continue;
    const name = words(`${l.name} ${l.alias ?? ''}`);
    if (name.length === 0) continue;
    let hits = 0;
    for (const w of name) if (narration.has(w) || [...narration].some((n) => n.length >= 4 && w.length >= 4 && (n.startsWith(w) || w.startsWith(n)))) hits++;
    if (hits === 0) continue;
    const score = hits / name.length + hits;
    if (score > bestScore + 1e-9) {
      best = l;
      bestScore = score;
      tie = false;
    } else if (Math.abs(score - bestScore) <= 1e-9) tie = true;
  }
  return tie ? null : best;
}

export interface CreateDraft {
  kind: FromLineKind;
  contraLedgerId: number | null;
  narration: string;
}

/** The bulk request for the chosen lines; lines without a ledger are reported, nothing is sent for them. */
export function buildCreateItems(lineIds: readonly number[], drafts: ReadonlyMap<number, CreateDraft>): { items: CreateFromLineInput[]; missing: number[] } {
  const items: CreateFromLineInput[] = [];
  const missing: number[] = [];
  for (const id of lineIds) {
    const d = drafts.get(id);
    if (!d || d.contraLedgerId === null) {
      missing.push(id);
      continue;
    }
    const narration = d.narration.trim();
    items.push({ lineId: id, kind: d.kind, contraLedgerId: d.contraLedgerId, ...(narration ? { narration } : {}) });
  }
  return { items, missing };
}

export const STATUS_LABEL: Record<StatementLineStatus, string> = { unmatched: 'Unmatched', matched: 'Matched', created: 'Voucher created', ignored: 'Ignored' };
export const STATUS_TONE: Record<StatementLineStatus, 'neutral' | 'success' | 'info' | 'warning'> = {
  unmatched: 'warning',
  matched: 'success',
  created: 'info',
  ignored: 'neutral',
};

/** "Same amount · 1 day after the voucher date · Cheque/ref. no. 501 is in the statement". */
export function reasonsText(reasons: readonly MatchReason[]): string {
  return reasons.map((r) => r.text).join(' · ');
}

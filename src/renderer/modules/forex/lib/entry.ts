/**
 * Forex voucher-entry helpers — pure (tested in entry.test.ts). Used by the vouchers module's form ⇄
 * input mapping (lib/buildInput.ts) and the forex dialogs.
 *
 * Convention on the entry form: in an invoice kept in a foreign currency (VoucherForm.forex), the
 * amount fields of the grid hold the FOREIGN amount × 100 (like paise: $12.50 → 1250), so the grid,
 * its totals and the party bill-wise split work unchanged in the document currency. The server
 * converts to rupees at the rate (src/core/modules/forex/hook.ts).
 */
import { allocate, type Paise } from '../../../../shared/money.ts';
import { forexToPaise, roundForex, sumForex, toMinor } from '../../../../shared/forex.ts';
import type { BillAllocationInput, BillRefType } from '../../../../shared/types/vouchers.ts';

/** Foreign amount → the form's ×100 integer (2 decimals): 12.5 → 1250. */
export function encodeForex(amount: number): Paise {
  return toMinor(amount, 2);
}

/** The form's ×100 integer → foreign amount: 1250 → 12.5. */
export function decodeForex(value: Paise): number {
  const n = value / 100;
  return n === 0 ? 0 : n;
}

/** A foreign amount signed like the rupee amount of its line (0 stays 0; a 0-rupee line keeps the typed sign). */
export function signedForex(forex: number, rupees: Paise): number {
  const abs = Math.abs(forex);
  if (abs === 0) return 0;
  if (rupees === 0) return forex;
  return rupees < 0 ? -abs : abs;
}

/** Party bills of a foreign-currency invoice: each carries its foreign amount (from the ×100 amount when missing). */
export function forexBills(bills: readonly BillAllocationInput[]): BillAllocationInput[] {
  return bills.map((b) => (b.forexAmount !== undefined ? { ...b } : { ...b, forexAmount: decodeForex(b.amount) }));
}

// ───────────────────────────── Bill-wise in the currency ─────────────────────────────

export interface ForexBillDraft {
  refType: BillRefType;
  billName: string;
  /** Magnitude in the currency. */
  forexAmount: number | null;
  creditDays?: number;
}

export function draftTotal(drafts: readonly ForexBillDraft[], dp: number): number {
  return sumForex(drafts.map((d) => d.forexAmount ?? 0), dp);
}

/**
 * Allocations to send for a line of `forexTotal` (magnitude) at `rate`: rupee amounts split from the
 * line's rupees in proportion to the foreign amounts (largest remainder, so they add up exactly); the
 * server re-values bills settled at another rate (realised difference). `unit: 'encoded'` (invoice in
 * the currency) puts the foreign amount × 100 in `amount` instead.
 */
export function draftsToAllocations(drafts: readonly ForexBillDraft[], o: { dp: number; rate: number | null; unit: 'inr' | 'encoded' }): BillAllocationInput[] {
  const filled = drafts.filter((d) => (d.forexAmount ?? 0) > 0 && (d.refType === 'on_account' || d.billName.trim() !== ''));
  const fx = filled.map((d) => roundForex(d.forexAmount ?? 0, o.dp));
  let amounts: Paise[];
  if (o.unit === 'encoded') amounts = fx.map((x) => encodeForex(x));
  else {
    const total = sumForex(fx, o.dp);
    const inr = o.rate ? forexToPaise(total, o.dp, o.rate) : 0;
    amounts = allocate(inr, fx.map((x) => toMinor(x, o.dp)));
  }
  return filled.map((d, i) => {
    const out: BillAllocationInput = { refType: d.refType, amount: Math.abs(amounts[i] ?? 0), forexAmount: fx[i] };
    if (d.refType !== 'on_account') out.billName = d.billName.trim();
    if (d.creditDays !== undefined) out.creditDays = d.creditDays;
    return out;
  });
}

export function draftsFromAllocations(bills: readonly BillAllocationInput[] | null | undefined): ForexBillDraft[] {
  return (bills ?? []).map((b) => ({
    refType: b.refType,
    billName: b.billName ?? '',
    forexAmount: b.forexAmount ?? null,
    ...(b.creditDays !== undefined ? { creditDays: b.creditDays } : {}),
  }));
}

/** Rupees of a line: foreign magnitude × rate (exactly as the server computes it). */
export function lineRupees(forex: number, dp: number, rate: number | null): Paise {
  if (!rate || rate <= 0) return 0;
  return forexToPaise(Math.abs(forex), dp, rate);
}

/** Pending foreign-currency bill as the dialogs use it (subset of ForexPendingBill). */
export interface PendingForexBill {
  billName: string;
  billDate: string;
  dueDate: string | null;
  amount: Paise;
  forexAmount: number;
  bookedRate: number;
}

/** Bills an entry on `side` can settle: a Cr entry settles Dr (receivable) bills and vice versa. */
export function settleableForex<T extends PendingForexBill>(pending: readonly T[], side: 'dr' | 'cr'): T[] {
  return pending.filter((b) => (side === 'cr' ? b.forexAmount > 0 : b.forexAmount < 0));
}

/**
 * Tally "Agst Ref, oldest first": settle the oldest bills of the other side with `forexTotal`
 * (magnitude); what is left becomes On Account (or a New Ref named `newName` when given).
 */
export function autoForexFifo(pending: readonly PendingForexBill[], forexTotal: number, side: 'dr' | 'cr', dp: number, newName?: string): ForexBillDraft[] {
  const out: ForexBillDraft[] = [];
  let left = toMinor(forexTotal, dp);
  const f = 10 ** dp;
  const bills = [...settleableForex(pending, side)].sort((a, b) => (a.billDate < b.billDate ? -1 : a.billDate > b.billDate ? 1 : a.billName.localeCompare(b.billName)));
  for (const b of bills) {
    if (left <= 0) break;
    const take = Math.min(left, Math.abs(toMinor(b.forexAmount, dp)));
    if (take <= 0) continue;
    out.push({ refType: 'against', billName: b.billName, forexAmount: take / f });
    left -= take;
  }
  if (left > 0) out.push(newName ? { refType: 'new', billName: newName, forexAmount: left / f } : { refType: 'on_account', billName: '', forexAmount: left / f });
  return out;
}

/**
 * Estimated realised difference of settling `forex` of a bill at `rate` (signed like a posting to the
 * gain/loss ledger: + = loss, − = gain), as the server will compute it. `side` is the paying entry's side.
 */
export function estimatedDifference(bill: PendingForexBill, forex: number, rate: number, dp: number, side: 'dr' | 'cr'): Paise {
  if (!(rate > 0) || bill.forexAmount === 0) return 0;
  const whole = Math.abs(toMinor(bill.forexAmount, dp));
  const part = Math.min(Math.abs(toMinor(forex, dp)), whole);
  const booked = part === whole ? Math.abs(bill.amount) : Math.round((Math.abs(bill.amount) * part) / whole);
  const atRate = forexToPaise(part / 10 ** dp, dp, rate);
  const d = atRate - booked;
  // A Cr entry (receipt) getting more rupees than booked is a gain (Cr to gain/loss).
  return side === 'cr' ? -d : d;
}

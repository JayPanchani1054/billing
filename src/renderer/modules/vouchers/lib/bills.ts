/**
 * Bill-wise allocation helpers (pure; tested in bills.test.ts).
 *
 * Amounts in BillAllocationInput are positive magnitudes; the stored sign follows the ledger entry.
 * PendingBill.amount is signed: Dr + (receivable from the party), Cr − (payable to the party).
 */
import { addDays } from '../../../../shared/dates.ts';
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { BillAllocationInput, BillRefType, PendingBill } from '../../../../shared/types/vouchers.ts';

export const REF_TYPE_LABEL: Readonly<Record<BillRefType, string>> = {
  new: 'New Ref',
  against: 'Agst Ref',
  advance: 'Advance',
  on_account: 'On Account',
};

export function allocationTotal(bills: readonly BillAllocationInput[] | null | undefined): Paise {
  return (bills ?? []).reduce((a, b) => a + Math.abs(b.amount || 0), 0);
}

/** What is left to allocate (positive = still to allocate, negative = over-allocated). */
export function allocationRemaining(bills: readonly BillAllocationInput[] | null | undefined, entryAmount: Paise): Paise {
  return Math.abs(entryAmount) - allocationTotal(bills);
}

/** Bills an entry on `entrySide` settles: a Cr entry settles Dr (receivable) bills and vice versa. */
export function settleableBills(pending: readonly PendingBill[], entrySide: 'dr' | 'cr'): PendingBill[] {
  return pending.filter((b) => (entrySide === 'cr' ? b.amount > 0 : b.amount < 0));
}

/** Oldest first: bill date, then due date, then name (FIFO). */
export function fifoOrder(bills: readonly PendingBill[]): PendingBill[] {
  return [...bills].sort(
    (a, b) =>
      (a.billDate < b.billDate ? -1 : a.billDate > b.billDate ? 1 : 0) ||
      ((a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : (a.dueDate ?? '9999') > (b.dueDate ?? '9999') ? 1 : 0) ||
      a.billName.localeCompare(b.billName),
  );
}

/**
 * FIFO auto-allocation: settle the oldest opposite-side pending bills first ('against'), each up to its
 * pending amount; whatever is left becomes one `remainder` line (On Account by default; 'advance' needs
 * a bill name — `advanceName`).
 */
export function autoAllocateFifo(
  pending: readonly PendingBill[],
  entryAmount: Paise,
  entrySide: 'dr' | 'cr',
  options: { remainder?: 'on_account' | 'advance' | 'new'; remainderName?: string } = {},
): BillAllocationInput[] {
  let left = Math.abs(entryAmount);
  const out: BillAllocationInput[] = [];
  for (const b of fifoOrder(settleableBills(pending, entrySide))) {
    if (left <= 0) break;
    const take = Math.min(left, Math.abs(b.amount));
    if (take <= 0) continue;
    out.push({ refType: 'against', billName: b.billName, amount: take });
    left -= take;
  }
  if (left > 0) {
    const kind = options.remainder ?? 'on_account';
    if (kind === 'on_account' || !options.remainderName) out.push({ refType: 'on_account', amount: left });
    else out.push({ refType: kind, billName: options.remainderName, amount: left });
  }
  return out;
}

/** Due date of a new reference: voucher date + credit days (null without credit days). */
export function dueDateFor(date: string, creditDays: number | null | undefined): string | null {
  if (creditDays === null || creditDays === undefined || !Number.isFinite(creditDays) || creditDays <= 0) return null;
  return addDays(date, Math.round(creditDays));
}

/**
 * What the bill-wise dialog starts with: an entry that can settle pending bills of the other
 * side (a receipt from a customer who owes, a payment to a supplier) is allocated against the oldest
 * bills first, the rest On Account; an invoice party — or a ledger with nothing to settle — starts a
 * New Ref named after the voucher (purchase: the supplier's invoice no.) with the credit period.
 */
export function defaultAllocation(o: {
  pending: readonly PendingBill[];
  amount: Paise;
  side: 'dr' | 'cr';
  date: string;
  suggestedName: string;
  creditDays: number | null;
  invoiceParty: boolean;
}): BillAllocationInput[] {
  if (!o.invoiceParty && settleableBills(o.pending, o.side).length > 0) return autoAllocateFifo(o.pending, o.amount, o.side, { remainder: 'on_account' });
  const line: BillAllocationInput = { refType: 'new', billName: o.suggestedName, amount: Math.abs(o.amount) };
  const due = dueDateFor(o.date, o.creditDays);
  if (due && o.creditDays) {
    line.creditDays = o.creditDays;
    line.dueDate = due;
  }
  return [line];
}

export interface AllocationIssue {
  index: number | null;
  message: string;
}

/** Client checks before sending (the server repeats them): names, positive amounts, total = entry. */
export function checkAllocations(bills: readonly BillAllocationInput[], entryAmount: Paise): AllocationIssue[] {
  const issues: AllocationIssue[] = [];
  bills.forEach((b, i) => {
    if (b.refType !== 'on_account' && !(b.billName ?? '').trim()) issues.push({ index: i, message: 'Enter the bill name (invoice number) for this reference.' });
    if (!(b.amount > 0)) issues.push({ index: i, message: 'Enter an amount greater than zero.' });
  });
  const rem = allocationRemaining(bills, entryAmount);
  if (rem !== 0 && bills.length > 0) {
    issues.push({
      index: null,
      message: rem > 0 ? `Allocate the remaining amount (₹${formatMoney(rem)}) or add an On Account line.` : `The bills add up to more than the entry by ₹${formatMoney(-rem)}.`,
    });
  }
  return issues;
}

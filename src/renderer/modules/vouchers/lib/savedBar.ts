/**
 * Saved bar of voucher entry (pure; tested in savedBar.test.ts): after a voucher is CREATED the blank
 * form for the next one shows "✓ Saved Sales INV/26-27/0042 · ₹ 11,800.00 — [Print Alt+P]
 * [Share Alt+W] [Record payment] [×]". It goes away on the next save, on ×, or as soon as the new
 * voucher is touched. Record payment opens a Receipt (sales) / Payment (purchase) with the party filled
 * in — no posting of its own. The toast "Sales 1 saved" stays as it was (the bar is additional).
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import type { LedgerClassName } from '../../../../shared/types/accounts.ts';
import { voucherRefLabel } from './printing.ts';
import type { SavedVoucherRef } from './printing.ts';

/** Sharing a PDF needs Data › Export (same rule and words as the voucher view's Alt+W). */
export const SHARE_DENIED_HINT = 'Sharing needs the Data › Export permission.';

export interface SavedBarState extends SavedVoucherRef {
  /** Grand total in paise (rupees for a foreign-currency invoice: the server total). */
  amount: number;
  baseType: VoucherBaseType;
  /** The party of the saved voucher (invoice modes), else null. */
  partyId: number | null;
  /** The party ledger's classes (debtor / creditor / party …) when known. */
  partyClasses: readonly LedgerClassName[];
}

/** "Saved Sales INV/26-27/0042". */
export function savedBarTitle(s: Pick<SavedBarState, 'typeName' | 'number'>): string {
  return `Saved ${voucherRefLabel(s)}`;
}

/**
 * The money follow-up of a saved invoice: a Receipt for a sales invoice to a customer, a Payment for a
 * purchase from a supplier (a party ledger — not Cash of a cash sale). Null when there is none.
 */
export function recordPaymentTarget(s: Pick<SavedBarState, 'baseType' | 'partyId' | 'partyClasses'>): { baseType: 'receipt' | 'payment'; partyId: number } | null {
  if (s.partyId === null || !s.partyClasses.includes('party')) return null;
  if (s.baseType === 'sales') return { baseType: 'receipt', partyId: s.partyId };
  if (s.baseType === 'purchase') return { baseType: 'payment', partyId: s.partyId };
  return null;
}

/**
 * Whether the bar stays: it is dropped once the next voucher on the form is touched (typing replaces the
 * "what just happened" with "what you are doing"), or when another voucher is saved (replaced).
 */
export function savedBarVisible(bar: SavedBarState | null, formTouched: boolean): boolean {
  return bar !== null && !formTouched;
}

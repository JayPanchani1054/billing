/**
 * Saved bar of voucher entry (pure; tested in savedBar.test.ts): after a voucher is CREATED the blank
 * form for the next one shows ONE neutral line (2.1, SPEC-21 D20):
 *
 *   ✓ Saved Sales 33 · ₹ 27,140.00 · Asha Retail     Print · Share · Record payment     ×
 *
 * It goes away on the next save, on ×, or as soon as the new voucher is touched. Record payment opens a
 * Receipt (sales) / Payment (purchase) with the party filled in — no posting of its own. "Saved" is said
 * once: while the bar shows there is no "Sales 33 saved" toast (`barToast`); the toast's View action lives
 * on in the bar (the voucher reference opens the voucher). Alteration and converted documents (which
 * leave the screen) keep their toast.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatMoney } from '../../../../shared/format.ts';
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
  /** (2.1) The party's name, read back on the bar. */
  partyName?: string | null;
}

/** "Saved Sales INV/26-27/0042". */
export function savedBarTitle(s: Pick<SavedBarState, 'typeName' | 'number'>): string {
  return `Saved ${voucherRefLabel(s)}`;
}

/** (2.1) The words after "Saved <voucher>": " · ₹ 27,140.00 · Asha Retail". */
export function savedBarDetails(s: Pick<SavedBarState, 'amount' | 'partyName'>): string {
  return ` · ₹ ${formatMoney(s.amount)}${s.partyName ? ` · ${s.partyName}` : ''}`;
}

/**
 * (2.1, D20) The toast after creating a voucher while the Saved bar shows it: none — except the save's
 * information notes, which are not on the bar (one "Please note" toast). Without the bar (a converted
 * document going back to its list) the screen keeps its 2.0 "Sales 33 saved" toast.
 */
export function barToast(infos: readonly string[]): { title: string; message: string } | null {
  const message = infos.join(' ');
  return message ? { title: 'Please note', message } : null;
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

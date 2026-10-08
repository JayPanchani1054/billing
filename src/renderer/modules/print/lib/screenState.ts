/**
 * Pure state helpers for the print screens (tested in screenState.test.ts): option cycling, batch
 * selection, and the invoice print settings form (validation, dirty check, preview overrides).
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import type { InvoicePrintOptions, InvoicePrintOverrides } from '../../../../shared/types/print.ts';
import { PRINT_BATCH_MAX, PRINT_COPIES } from '../../../../shared/types/print.ts';
import { validateUpiId } from '../../../../shared/validators.ts';

/** Next value after `current` (wrapping). */
export function cycle<T>(values: readonly T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

// ───────────────────────────── Batch selection ─────────────────────────────

export function toggleId(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** All of `ids` selected → none; otherwise all (capped at PRINT_BATCH_MAX). */
export function toggleAll(selected: ReadonlySet<number>, ids: readonly number[]): Set<number> {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  return all ? new Set() : new Set(ids.slice(0, PRINT_BATCH_MAX));
}

/** Selected ids in list order (the order they print in), capped at PRINT_BATCH_MAX. */
export function orderedSelection(selected: ReadonlySet<number>, ids: readonly number[]): number[] {
  return ids.filter((id) => selected.has(id)).slice(0, PRINT_BATCH_MAX);
}

export interface BatchKindOption {
  value: string;
  label: string;
  baseTypes: VoucherBaseType[];
}

export const BATCH_KINDS: readonly BatchKindOption[] = [
  { value: 'sales', label: 'Sales invoices', baseTypes: ['sales'] },
  { value: 'notes', label: 'Credit / debit notes', baseTypes: ['credit_note', 'debit_note'] },
  { value: 'purchase', label: 'Purchases', baseTypes: ['purchase'] },
  { value: 'receipts', label: 'Receipts & payments', baseTypes: ['receipt', 'payment'] },
  { value: 'challans', label: 'Challans & orders', baseTypes: ['delivery_note', 'sales_order', 'purchase_order'] },
  { value: 'all', label: 'All vouchers', baseTypes: [] },
];

export function batchKind(value: string): BatchKindOption {
  return BATCH_KINDS.find((k) => k.value === value) ?? BATCH_KINDS[0];
}

// ───────────────────────────── Print settings form ─────────────────────────────

export type SettingsErrors = Partial<Record<keyof InvoicePrintOptions, string>>;

export function settingsErrors(o: InvoicePrintOptions): SettingsErrors {
  const e: SettingsErrors = {};
  if (o.copies.length === 0) e.copies = 'Choose at least one copy to print.';
  const upi = o.upiId.trim();
  if (o.showUpiQr && !upi) e.upiId = 'Enter the UPI ID that customers should pay to (e.g. shop@okhdfcbank), or turn off the UPI QR code.';
  else if (upi) {
    const err = validateUpiId(upi);
    if (err) e.upiId = `${err}.`;
  }
  if (o.signatoryLabel.trim().length > 100) e.signatoryLabel = 'Keep the signatory label under 100 characters.';
  if (o.declaration.length > 2000) e.declaration = 'The declaration is too long (2,000 characters at most).';
  if (o.terms.length > 4000) e.terms = 'Terms are too long (4,000 characters at most).';
  return e;
}

export function sameOptions(a: InvoicePrintOptions, b: InvoicePrintOptions): boolean {
  const keys = Object.keys(a) as Array<keyof InvoicePrintOptions>;
  return keys.every((k) => (Array.isArray(a[k]) ? JSON.stringify(a[k]) === JSON.stringify(b[k]) : a[k] === b[k]));
}

/** Copies in canonical order. */
export function normaliseOptions(o: InvoicePrintOptions): InvoicePrintOptions {
  return { ...o, copies: PRINT_COPIES.filter((c) => o.copies.includes(c)), upiId: o.upiId.trim(), signatoryLabel: o.signatoryLabel.trim() };
}

/**
 * Overrides for the live preview: the whole draft, minus values the server would reject while the user
 * is still typing (an incomplete UPI id, no copies).
 */
export function previewOverrides(o: InvoicePrintOptions): InvoicePrintOverrides {
  const n = normaliseOptions(o);
  const out: InvoicePrintOverrides = { ...n };
  if (n.upiId && validateUpiId(n.upiId)) {
    out.upiId = '';
    out.showUpiQr = false;
  }
  if (n.copies.length === 0) delete out.copies;
  out.declaration = n.declaration.slice(0, 2000);
  out.terms = n.terms.slice(0, 4000);
  out.signatoryLabel = n.signatoryLabel.slice(0, 100);
  return out;
}

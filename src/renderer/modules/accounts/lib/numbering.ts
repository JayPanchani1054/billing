/**
 * Voucher-type numbering: live preview of the numbers a scheme produces and the GST invoice-number
 * checks (≤ 16 characters, only A–Z a–z 0–9 / -, unique for the financial year). Mirrors core
 * `checkNumbering` (src/core/modules/accounts/voucherTypes.ts) and `formatVoucherNumber`
 * (src/core/modules/vouchers/numbering.ts) so the form can warn before saving.
 * Pure — tested in numbering.test.ts.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatIndianNumber } from '../../../../shared/format.ts';
import type { NumberingMethod, NumberingRestart, VoucherNumbering } from '../../../../shared/types/accounts.ts';

/** GST documents whose numbers go to GSTR-1 (same list as the core). */
export const GST_DOCUMENT_BASE_TYPES: readonly VoucherBaseType[] = ['sales', 'credit_note', 'debit_note'];
export const GST_DOC_NUMBER_MAX_LENGTH = 16;

export const METHOD_OPTIONS: ReadonlyArray<{ value: NumberingMethod; label: string; hint: string }> = [
  { value: 'automatic', label: 'Automatic', hint: 'The next number is given on save; it cannot be changed.' },
  { value: 'automatic_override', label: 'Automatic (can change)', hint: 'Suggested automatically; you may type another number.' },
  { value: 'manual', label: 'Manual', hint: 'You type every number yourself.' },
  { value: 'none', label: 'None', hint: 'Vouchers carry no number.' },
];

export const RESTART_OPTIONS: ReadonlyArray<{ value: NumberingRestart; label: string }> = [
  { value: 'yearly', label: 'Every financial year' },
  { value: 'monthly', label: 'Every month' },
  { value: 'never', label: 'Never' },
];

export function formatNumber(n: Pick<VoucherNumbering, 'prefix' | 'suffix' | 'width'>, seq: number): string {
  const body = n.width > 0 ? String(seq).padStart(n.width, '0') : String(seq);
  return `${n.prefix ?? ''}${body}${n.suffix ?? ''}`;
}

/**
 * Numbers shown in the live preview: the first two numbers of a numbering period.
 * null for manual numbering or no numbering (nothing is generated).
 */
export function numberingPreview(n: VoucherNumbering): { first: string; second: string } | null {
  if (n.method === 'none' || n.method === 'manual') return null;
  const start = Math.max(1, Math.floor(n.start || 1));
  return { first: formatNumber(n, start), second: formatNumber(n, start + 1) };
}

/** Plain-English description of when the numbers start again. */
export function restartText(r: NumberingRestart, fyLabel?: string): string {
  if (r === 'monthly') return 'Starts again on the 1st of every month.';
  if (r === 'never') return 'Never starts again — numbers keep running across years.';
  return `Starts again every financial year${fyLabel ? ` (next: ${fyLabel})` : ''}.`;
}

/** Characters that GST does not allow in a document number (deduplicated, in order). */
export function badCharacters(text: string): string[] {
  return [...new Set(text.replace(/[A-Za-z0-9/-]/g, ''))];
}

export interface NumberingIssue {
  /** Field path as the server reports it ('numbering.prefix' …). */
  path: 'numbering.prefix' | 'numbering.suffix' | 'numbering.restart' | 'numbering.method' | 'numbering';
  message: string;
}

/**
 * Same rules as the core: for sales / credit note / debit note of a GST company these are errors
 * (the save would be refused); otherwise warnings.
 */
export function checkNumbering(baseType: VoucherBaseType, n: VoucherNumbering, gstEnabled: boolean): { errors: NumberingIssue[]; warnings: string[] } {
  const gstDoc = GST_DOCUMENT_BASE_TYPES.includes(baseType);
  const strict = gstDoc && gstEnabled;
  const errors: NumberingIssue[] = [];
  const warnings: string[] = [];
  const flag = (path: NumberingIssue['path'], message: string): void => {
    if (strict) errors.push({ path, message });
    else warnings.push(message);
  };
  const prefix = n.prefix ?? '';
  const suffix = n.suffix ?? '';
  for (const [path, label, text] of [
    ['numbering.prefix', 'prefix', prefix],
    ['numbering.suffix', 'suffix', suffix],
  ] as const) {
    const bad = badCharacters(text);
    if (bad.length > 0) {
      const shown = bad.map((c) => (c === ' ' ? 'a space' : `'${c}'`)).join(', ');
      flag(path, `The ${label} contains ${shown}. GST invoice numbers may contain only letters, digits, '/' and '-'.`);
    }
  }
  if (n.method === 'automatic' || n.method === 'automatic_override') {
    const room = GST_DOC_NUMBER_MAX_LENGTH - prefix.length - suffix.length;
    const digits = Math.max(n.width, String(n.start).length);
    if (digits > room) {
      flag(
        'numbering.prefix',
        `Voucher numbers would be ${prefix.length + digits + suffix.length} characters long (prefix ${prefix.length} + number ${digits} + suffix ${suffix.length}). ` +
          'GST invoice numbers can have at most 16 characters: shorten the prefix or suffix, or reduce the zero padding.',
      );
    } else if (gstDoc && room < 6) {
      warnings.push(
        `Voucher numbers will be longer than 16 characters after no. ${formatIndianNumber(10 ** room - 1, 0)}. GST invoice numbers can have at most 16 characters; consider a shorter prefix or suffix.`,
      );
    }
  }
  if (gstDoc && gstEnabled) {
    if (n.restart === 'monthly' && n.method !== 'manual' && n.method !== 'none') {
      errors.push({
        path: 'numbering.restart',
        message:
          'Numbers would restart every month with the same prefix, so invoice numbers would repeat within the financial year. ' +
          'GST requires a number to be unique for the whole financial year: restart yearly (or never).',
      });
    }
    if (n.method === 'manual') warnings.push('Manual numbering: make sure every number is unique within the financial year (GST requirement).');
    if (n.method === 'none') errors.push({ path: 'numbering.method', message: 'GST invoices, credit notes and debit notes must carry a serial number: choose automatic or manual numbering.' });
  }
  return { errors, warnings };
}

/** Length of the longest number for a width/start (for the "12 of 16 characters" meter). */
export function numberLength(n: VoucherNumbering): number {
  const digits = Math.max(n.width, String(Math.max(1, n.start)).length);
  return (n.prefix ?? '').length + digits + (n.suffix ?? '').length;
}

/** Ledger side a voucher type's default ledger must be on (null = not applicable). Mirrors the core. */
export function defaultLedgerSide(baseType: VoucherBaseType): 'sales' | 'purchase' | null {
  if (['sales', 'credit_note', 'sales_order', 'delivery_note', 'rejection_in'].includes(baseType)) return 'sales';
  if (['purchase', 'debit_note', 'purchase_order', 'receipt_note', 'rejection_out'].includes(baseType)) return 'purchase';
  return null;
}

export function isInvoiceBase(baseType: VoucherBaseType): boolean {
  return baseType === 'sales' || baseType === 'purchase' || baseType === 'credit_note' || baseType === 'debit_note';
}

/** Base types that move stock (default godown makes sense). */
export function movesStock(baseType: VoucherBaseType): boolean {
  return !['payment', 'receipt', 'contra', 'journal', 'memorandum', 'reversing_journal'].includes(baseType);
}

export const BASE_TYPE_LABELS: Readonly<Record<VoucherBaseType, string>> = {
  sales: 'Sales',
  purchase: 'Purchase',
  payment: 'Payment',
  receipt: 'Receipt',
  contra: 'Contra',
  journal: 'Journal',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  sales_order: 'Sales Order',
  purchase_order: 'Purchase Order',
  delivery_note: 'Delivery Note',
  receipt_note: 'Receipt Note',
  rejection_in: 'Rejections In',
  rejection_out: 'Rejections Out',
  stock_journal: 'Stock Journal',
  physical_stock: 'Physical Stock',
  memorandum: 'Memorandum',
  reversing_journal: 'Reversing Journal',
};

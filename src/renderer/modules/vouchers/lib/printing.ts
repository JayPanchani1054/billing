/**
 * Printing from the voucher screens (pure, tested in printing.test.ts).
 *
 * - Voucher entry: Alt+P prints the voucher being altered, or — on a new voucher — the voucher just
 *   saved from this screen ("Print Sales 12"), so a fresh invoice is one key away from the printer.
 * - Print after saving (voucher type or F12 › Invoice printing, see vouchers.entryContext): the
 *   preview opens with `autoPrint`, which sends it to the printer as soon as it is ready.
 * - Day Book / voucher lists: Ctrl+P prints the highlighted voucher (Alt+P prints the register).
 */

/** The voucher last created from an entry screen. */
export interface SavedVoucherRef {
  id: number;
  number: string | null;
  typeName: string;
}

/** "Sales 12" (or just the type name for a voucher without a number). */
export function voucherRefLabel(v: Pick<SavedVoucherRef, 'number' | 'typeName'>): string {
  return `${v.typeName} ${v.number ?? ''}`.replace(/\s+/g, ' ').trim();
}

/**
 * What Alt+P on the entry screen prints: the voucher under alteration, else the one just saved;
 * null (action hidden) on a new voucher before anything was saved.
 */
export function entryPrintTarget(alteringId: number | null, lastSaved: SavedVoucherRef | null): { id: number; label: string } | null {
  if (alteringId !== null) return { id: alteringId, label: 'Print' };
  if (lastSaved) return { id: lastSaved.id, label: `Print ${voucherRefLabel(lastSaved)}` };
  return null;
}

/** Params for 'print.voucher' after a save when the voucher prints after saving (else null). */
export function afterSavePrint(id: number, printAfterSave: boolean): { id: number; autoPrint: true } | null {
  return printAfterSave ? { id, autoPrint: true } : null;
}

/**
 * Second line of the "saved" toast: the amount, Alt+P, and any info warnings. `canPrint` false (no
 * print module registered) leaves the Alt+P hint out, as the action is hidden then.
 */
export function savedToastMessage(amount: string, infos: readonly string[], printOpens: boolean, canPrint = true): string {
  const print = printOpens ? ['Printing…'] : canPrint ? ['Alt+P to print'] : [];
  return [`₹ ${amount}`, ...print, ...infos].join(' · ');
}

/**
 * Statutory set-off of input tax credit against output tax (CGST Act s.49(5) and Rule 88A):
 *
 *   1. IGST credit → IGST liability first.
 *   2. Remaining IGST credit must be used up next (Rule 88A: before any CGST/SGST credit), against CGST
 *      and SGST "in any order and in any proportion". We use it first on the part of the CGST / SGST
 *      liability that the head's own credit cannot cover (CGST before SGST), then on the rest
 *      (CGST before SGST). With no own-head credit this is exactly "IGST → IGST, then CGST, then SGST";
 *      when own-head credit exists it avoids paying cash that a different proportion would save.
 *   3. CGST credit → CGST, then IGST. CGST credit can NEVER pay SGST/UTGST.
 *   4. SGST/UTGST credit → SGST, then IGST. SGST credit can NEVER pay CGST.
 *   5. Cess credit → cess only (and cess liability can be paid only from cess credit).
 * Whatever liability remains is paid in cash; whatever credit remains is carried forward.
 * Reverse-charge tax is never set off — callers pay it in cash separately.
 */
import type { Paise } from '../../../shared/money.ts';
import type { SetOffResult, TaxAmounts, TaxHead } from '../../../shared/types/gst-returns.ts';

const HEADS: readonly TaxHead[] = ['igst', 'cgst', 'sgst', 'cess'];

const zeroRow = (): Record<TaxHead, Paise> => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

export function setOff(liability: TaxAmounts, credit: TaxAmounts): SetOffResult {
  const L: Record<TaxHead, Paise> = zeroRow();
  const C: Record<TaxHead, Paise> = zeroRow();
  for (const h of HEADS) {
    L[h] = Math.max(0, liability[h]);
    C[h] = Math.max(0, credit[h]);
  }
  const utilisation: Record<TaxHead, Record<TaxHead, Paise>> = { igst: zeroRow(), cgst: zeroRow(), sgst: zeroRow(), cess: zeroRow() };

  const use = (from: TaxHead, to: TaxHead, cap = Number.MAX_SAFE_INTEGER): void => {
    const a = Math.min(C[from], L[to], Math.max(0, cap));
    if (a <= 0) return;
    utilisation[from][to] += a;
    C[from] -= a;
    L[to] -= a;
  };

  // 1. IGST credit → IGST.
  use('igst', 'igst');
  // 2. IGST credit → CGST / SGST shortfalls, then the rest (CGST before SGST).
  use('igst', 'cgst', L.cgst - C.cgst);
  use('igst', 'sgst', L.sgst - C.sgst);
  use('igst', 'cgst');
  use('igst', 'sgst');
  // 3. CGST credit → CGST, then IGST.
  use('cgst', 'cgst');
  use('cgst', 'igst');
  // 4. SGST credit → SGST, then IGST.
  use('sgst', 'sgst');
  use('sgst', 'igst');
  // 5. Cess.
  use('cess', 'cess');

  const paidByItc = zeroRow();
  for (const from of HEADS) for (const to of HEADS) paidByItc[to] += utilisation[from][to];
  return { utilisation, paidByItc, cash: { ...L }, creditBalance: { ...C } };
}

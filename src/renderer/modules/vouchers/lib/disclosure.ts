/**
 * What the voucher header shows inline and what waits in "More details" (Ctrl+I) — pure, tested in
 * disclosure.test.ts. Only the layout changes: every field stays in the form state and buildInput sends
 * exactly what it sent before (formState.ts / buildInput.ts are untouched by this).
 *
 * - Sales-side documents (sales, credit note, sales order, delivery note, rejection in, quotation,
 *   proforma) in an invoice or stock layout: "Reference no.", "Reference date" and (GST documents)
 *   "Reverse charge" live in More details and appear inline only once they hold a value (they then stay
 *   inline for the rest of this voucher, so clearing the text never makes the field vanish under the cursor).
 * - Purchase-side documents keep "Supplier invoice no. / date" and "Reverse charge" inline (input credit
 *   and GSTR-2B matching depend on them); payments / receipts keep their reference inline (they have no
 *   More details).
 * - Place of supply: a chip "Gujarat (24) · intra-state ✎" when it is derived (automatic and known);
 *   the existing select when it was chosen by hand, cannot be derived or would only be assumed (a
 *   party without a state, overseas) or has an error.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { stateName } from '../../../../shared/gst/states.ts';
import type { VoucherMode } from '../../../../shared/types/vouchers.ts';
import { defaultDirection } from './kinds.ts';

export interface HeaderDisclosure {
  /** Reference no. / date rendered in the header. */
  refInline: boolean;
  /** Reference no. / date offered in More details. */
  refInMore: boolean;
  /** Reverse charge switch rendered in the header. */
  rcInline: boolean;
  /** Reverse charge switch offered in More details. */
  rcInMore: boolean;
}

/** A sales-side document laid out with More details (any mode but the Dr/Cr voucher layout). */
export function isSalesSideDoc(baseType: VoucherBaseType, mode: VoucherMode, supplierRef: boolean): boolean {
  return !supplierRef && mode !== 'ledger' && defaultDirection(baseType) === 'outward';
}

export function headerDisclosure(a: {
  baseType: VoucherBaseType;
  mode: VoucherMode;
  /** The party's GST direction (a debit note to a customer is outward). */
  direction: 'outward' | 'inward';
  /** The document has a reference at all (entry screen `showRef`). */
  showRef: boolean;
  /** Purchase-side: "Supplier invoice no." */
  supplierRef: boolean;
  /** A GST invoice / note of a GST company in an invoice layout. */
  gstDoc: boolean;
  referenceNo: string;
  referenceDate: string | null;
  reverseCharge: boolean;
  /** A value was shown inline earlier in this voucher (keeps the fields inline). */
  pinned: boolean;
}): HeaderDisclosure {
  const salesSide = isSalesSideDoc(a.baseType, a.mode, a.supplierRef);
  const refValue = a.referenceNo.trim() !== '' || a.referenceDate !== null;
  const refInline = a.showRef && (!salesSide || refValue || a.pinned);
  const refInMore = a.showRef && salesSide;
  const rcInMore = a.gstDoc && salesSide;
  // Purchase-side (inward) documents: always inline, as in 1.0. Anything else: once it holds a value.
  const rcInline = a.gstDoc && ((a.direction === 'inward' && !salesSide) || a.reverseCharge || (salesSide && a.pinned));
  return { refInline, refInMore, rcInline, rcInMore };
}

/** True once a disclosed field holds a value (the screen pins them inline from then on). */
export function disclosedHasValue(f: { referenceNo: string; referenceDate: string | null; reverseCharge: boolean }): boolean {
  return f.referenceNo.trim() !== '' || f.referenceDate !== null || f.reverseCharge;
}

export interface PlaceOfSupplyChip {
  /** "Gujarat (24) · intra-state" — the chip text (the screen adds the ✎). */
  label: string;
  code: string;
}

/**
 * True when the place of supply of an outward document would only be ASSUMED: a party is chosen but
 * neither it nor the consignee has a state, so the engine falls back to the company's state
 * (shared/gst/pos.ts). The select shows then, so the user sees and confirms it (SPEC 6.3 "no party
 * state"). Before a party is chosen the chip stays (no layout jump under the Enter chain).
 */
export function placeOfSupplyAssumed(a: { direction: 'outward' | 'inward'; partyChosen: boolean; partyStateCode: string | null | undefined; consigneeStateCode: string | null | undefined }): boolean {
  return a.direction === 'outward' && a.partyChosen && !(a.partyStateCode ?? '').trim() && !(a.consigneeStateCode ?? '').trim();
}

/**
 * The derived place of supply as a chip, or null when the select must show: chosen by hand (`chosen`
 * not ''), not derivable (`computed` null), only assumed (`assumed`, see placeOfSupplyAssumed), outside
 * India ('96'), or the field has an error.
 */
export function placeOfSupplyChip(a: { chosen: string; computed: string | null; interState: boolean | null; hasError: boolean; assumed?: boolean }): PlaceOfSupplyChip | null {
  if (a.hasError || a.assumed === true || a.chosen !== '' || a.computed === null || a.computed === '' || a.computed === '96' || a.interState === null) return null;
  const name = stateName(a.computed);
  if (!name) return null;
  return { label: `${name} (${a.computed}) · ${a.interState ? 'inter-state' : 'intra-state'}`, code: a.computed };
}

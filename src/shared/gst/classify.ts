/**
 * Invoice-level supply classification (GstNature) — decides which GSTR-1 / GSTR-3B table a
 * document lands in. Line-level taxability (nil/exempt/non-GST lines inside a B2B invoice) is
 * still reported per gst_line; this is the document's headline nature.
 */
import { B2CL_THRESHOLD_PAISE } from '../constants.ts';
import type { Paise } from '../money.ts';
import type { CompanyRegistrationType, GstNature, RegistrationType, SupplyDirection } from '../types/gst.ts';

export interface ClassifyContext {
  direction: SupplyDirection;
  companyRegistration: CompanyRegistrationType;
  partyRegistration: RegistrationType;
  interState: boolean;
  /** Document (or any of its lines) is under reverse charge. */
  reverseCharge?: boolean;
  /** Export / SEZ supply with payment of IGST (default: under LUT/bond). */
  exportWithPayment?: boolean;
  /** Default B2CL_THRESHOLD_PAISE (₹1,00,000). */
  b2clThresholdPaise?: Paise;
}

export interface ClassifyTotals {
  /** Total invoice value including tax and round-off. */
  invoiceValue: Paise;
  /** Every line with value is exempt / nil-rated / non-GST. */
  allNonTaxable: boolean;
  /** Taxable value of goods lines (decides import of goods vs services). */
  goodsValue?: Paise;
  servicesValue?: Paise;
}

/** Party types that hold a GSTIN/UIN and are reported as B2B. */
export function isRegisteredParty(reg: RegistrationType): boolean {
  return reg === 'regular' || reg === 'composition' || reg === 'uin' || reg === 'sez' || reg === 'deemed_export';
}

/**
 * Rules, in order:
 *   company unregistered → no_gst
 *   OUTWARD: company composition → composition_outward; overseas → export_wpay / export_lut;
 *     SEZ → sez_wpay / sez_lut; deemed export → deemed_export; all lines non-taxable → nil_exempt;
 *     registered party (regular / composition / UIN) → b2b;
 *     unregistered & inter-state & invoice value > threshold → b2cl; otherwise b2cs.
 *   INWARD: overseas → import_goods / import_services (by larger value, goods on a tie);
 *     SEZ → inward_sez; reverse charge → inward_rcm; unregistered/consumer → inward_unregistered;
 *     composition supplier → inward_composition; all non-taxable → inward_nil_exempt; else inward_b2b.
 * The B2CL threshold is strict: an invoice exactly at the threshold is B2CS.
 */
export function classifySupply(ctx: ClassifyContext, totals: ClassifyTotals): GstNature {
  if (ctx.companyRegistration === 'unregistered') return 'no_gst';
  const party = ctx.partyRegistration;

  if (ctx.direction === 'outward') {
    if (ctx.companyRegistration === 'composition') return 'composition_outward';
    if (party === 'overseas') return ctx.exportWithPayment ? 'export_wpay' : 'export_lut';
    if (party === 'sez') return ctx.exportWithPayment ? 'sez_wpay' : 'sez_lut';
    if (party === 'deemed_export') return 'deemed_export';
    if (totals.allNonTaxable) return 'nil_exempt';
    if (party === 'regular' || party === 'composition' || party === 'uin') return 'b2b';
    const threshold = ctx.b2clThresholdPaise ?? B2CL_THRESHOLD_PAISE;
    return ctx.interState && totals.invoiceValue > threshold ? 'b2cl' : 'b2cs';
  }

  if (party === 'overseas') return (totals.servicesValue ?? 0) > (totals.goodsValue ?? 0) ? 'import_services' : 'import_goods';
  if (party === 'sez') return 'inward_sez';
  if (ctx.reverseCharge) return 'inward_rcm';
  if (party === 'unregistered' || party === 'consumer') return 'inward_unregistered';
  if (party === 'composition') return 'inward_composition';
  if (totals.allNonTaxable) return 'inward_nil_exempt';
  return 'inward_b2b';
}

export const GST_NATURE_LABELS: Readonly<Record<GstNature, string>> = {
  b2b: 'B2B (registered buyer)',
  b2cl: 'B2C Large (inter-state)',
  b2cs: 'B2C Small',
  export_wpay: 'Export with payment of IGST',
  export_lut: 'Export under LUT / bond',
  sez_wpay: 'SEZ supply with payment of IGST',
  sez_lut: 'SEZ supply under LUT / bond',
  deemed_export: 'Deemed export',
  nil_exempt: 'Nil rated / exempt / non-GST',
  composition_outward: 'Bill of supply (composition)',
  no_gst: 'Not under GST',
  inward_b2b: 'Purchase from registered supplier',
  inward_rcm: 'Purchase under reverse charge',
  inward_unregistered: 'Purchase from unregistered supplier',
  inward_composition: 'Purchase from composition dealer',
  import_goods: 'Import of goods',
  import_services: 'Import of services',
  inward_sez: 'Purchase from SEZ',
  inward_nil_exempt: 'Nil rated / exempt purchase',
};

export function isOutwardNature(n: GstNature): boolean {
  return !n.startsWith('inward_') && !n.startsWith('import_');
}

/** Zero-rated supplies (exports and SEZ) — IGST at 0 under LUT, or refundable when paid. */
export function isZeroRatedNature(n: GstNature): boolean {
  return n === 'export_wpay' || n === 'export_lut' || n === 'sez_wpay' || n === 'sez_lut';
}

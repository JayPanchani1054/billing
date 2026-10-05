/**
 * GST domain types shared by the renderer (live invoice totals while typing) and the backend
 * (authoritative recomputation on save). Implemented in src/shared/gst/.
 *
 * All money is integer paise (`Paise`). Rates are REAL percentages (18 means 18%).
 */
import type { Paise } from '../money.ts';
import type { RoundOffMethod } from '../settings.ts';

// ───────────────────────────── Registration & classification ─────────────────────────────

/** GST registration type of a party (ledgers.gst_registration_type). */
export type RegistrationType =
  | 'regular'
  | 'composition'
  | 'unregistered'
  | 'consumer'
  | 'sez'
  | 'overseas'
  | 'deemed_export'
  | 'uin';

export const REGISTRATION_TYPES: readonly RegistrationType[] = [
  'regular',
  'composition',
  'unregistered',
  'consumer',
  'sez',
  'overseas',
  'deemed_export',
  'uin',
];

/** GST registration type of the company itself (company.gst_registration_type). */
export type CompanyRegistrationType = 'regular' | 'composition' | 'unregistered';

export type Taxability = 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';
export const TAXABILITIES: readonly Taxability[] = ['taxable', 'exempt', 'nil_rated', 'non_gst'];

export type SupplyKind = 'goods' | 'services';
export type SupplyDirection = 'outward' | 'inward';

/** Which duty heads an invoice uses. 'none' = the company charges no GST on this document. */
export type TaxMode = 'igst' | 'cgst_sgst' | 'cgst_utgst' | 'none';

/**
 * Invoice-level supply classification; drives the GSTR-1 / GSTR-3B tables.
 * Outward: b2b … no_gst. Inward: inward_b2b … inward_nil_exempt.
 */
export type GstNature =
  | 'b2b'
  | 'b2cl'
  | 'b2cs'
  | 'export_wpay'
  | 'export_lut'
  | 'sez_wpay'
  | 'sez_lut'
  | 'deemed_export'
  | 'nil_exempt'
  | 'composition_outward'
  | 'no_gst'
  | 'inward_b2b'
  | 'inward_rcm'
  | 'inward_unregistered'
  | 'inward_composition'
  | 'import_goods'
  | 'import_services'
  | 'inward_sez'
  | 'inward_nil_exempt';

export const GST_NATURES: readonly GstNature[] = [
  'b2b',
  'b2cl',
  'b2cs',
  'export_wpay',
  'export_lut',
  'sez_wpay',
  'sez_lut',
  'deemed_export',
  'nil_exempt',
  'composition_outward',
  'no_gst',
  'inward_b2b',
  'inward_rcm',
  'inward_unregistered',
  'inward_composition',
  'import_goods',
  'import_services',
  'inward_sez',
  'inward_nil_exempt',
];

/**
 * Suggested document title for an outward document:
 *  - 'tax_invoice'     regular dealer with at least one taxable line
 *  - 'bill_of_supply'  composition dealer, or only exempt/nil/non-GST lines (CGST Rule 49)
 *  - 'invoice'         company not registered under GST
 */
export type DocumentKind = 'tax_invoice' | 'bill_of_supply' | 'invoice';

// ───────────────────────────── Masters ─────────────────────────────

export interface GstState {
  /** Two-digit GST state code, e.g. '27'. */
  code: string;
  name: string;
  /** Alpha code used on the GST portal, e.g. 'MH'. */
  alpha: string;
  isUnionTerritory: boolean;
  /** UT without legislature → intra-state supplies attract CGST + UTGST instead of CGST + SGST. */
  utgst: boolean;
  /** Code no longer issued (merged/reorganised state); kept for old documents. */
  legacy: boolean;
  /** Pseudo-state (96 Other Countries, 97 Other Territory, 99 Centre Jurisdiction). */
  special: boolean;
}

export interface UqcEntry {
  /** GST Unique Quantity Code, e.g. 'KGS'. */
  code: string;
  description: string;
}

/**
 * Kind of GST identification number:
 *  - regular: normal taxpayer / composition / SEZ unit etc. (14th character 'Z')
 *  - uin:     UN bodies, embassies (…UN? / …ON?)
 *  - nri:     non-resident taxable person (…NR?)
 *  - oidar:   online services provider from outside India (99…OS?)
 *  - tds:     tax deductor (14th character 'D')
 *  - tcs:     e-commerce operator collecting tax (14th character 'C')
 */
export type GstinKind = 'regular' | 'uin' | 'nri' | 'oidar' | 'tds' | 'tcs';

export interface GstinValidation {
  valid: boolean;
  /** User-readable reason when invalid. */
  error?: string;
  /** Normalised (trimmed, upper-case) GSTIN. */
  gstin?: string;
  stateCode?: string;
  /** Embedded PAN (characters 3–12) when the GSTIN is PAN-based. */
  pan?: string;
  kind?: GstinKind;
  /** True for kinds other than 'regular' (accepted, but usually need special handling). */
  special?: boolean;
}

// ───────────────────────────── Place of supply ─────────────────────────────

export interface PlaceOfSupplyInput {
  direction: SupplyDirection;
  supplyKind: SupplyKind;
  /** Company's own state; used for inward supplies and as the fallback when the party has no state. */
  companyStateCode?: string;
  partyStateCode?: string | null;
  partyRegistration: RegistrationType;
  /** Ship-to / consignee state (goods). */
  consigneeStateCode?: string | null;
  /** Place of supply entered on the voucher — always wins when it is a known code. */
  explicit?: string | null;
}

export interface PlaceOfSupplyResult {
  /** State code, or '96' for supplies outside India. */
  code: string;
  /** Short explanation for the UI tooltip / audit. */
  reason: string;
}

// ───────────────────────────── Invoice engine ─────────────────────────────

export type ApportionMethod = 'none' | 'value' | 'quantity';

export interface InvoiceLineInput {
  /** Stable key chosen by the caller (row id); echoed back on ComputedLine. */
  key: string;
  kind: 'item' | 'ledger';
  description?: string;
  /** Quantity in the item's unit (item lines; optional on ledger lines). */
  qty?: number;
  /** Rupees per unit, exclusive of tax unless rateInclusiveOfTax. */
  rate?: number;
  /** Discount percent (0–100). */
  discountPct?: number;
  /** Gross line value in paise. Required for ledger lines; for item lines it overrides qty × rate. */
  amount?: Paise;
  /** qty × rate (or amount) already includes GST (and ad valorem / per-unit cess). */
  rateInclusiveOfTax?: boolean;
  taxability: Taxability;
  /** GST rate percent (IGST rate; CGST = SGST = half). */
  gstRate: number;
  /** Ad valorem compensation cess percent. */
  cessRate?: number;
  /** Specific (per-unit) cess in paise per unit of qty. */
  cessPerUnit?: Paise;
  hsnSac?: string;
  supplyKind: SupplyKind;
  /** GST UQC (e.g. 'KGS'); defaults to 'OTH' for goods and 'NA' for services. */
  uqc?: string;
  /**
   * Additional charge (freight, packing …) absorbed into the goods lines' taxable value,
   * split by value or by quantity. The charge line itself then has no taxable value of its own.
   */
  apportion?: ApportionMethod;
  /** Tax on this line is payable by the recipient (reverse charge). */
  reverseCharge?: boolean;
}

export interface InvoiceRoundOff {
  enabled: boolean;
  method: RoundOffMethod;
  /** Rounding unit in paise (100 = nearest rupee). */
  unit: number;
}

export interface InvoiceContext {
  direction: SupplyDirection;
  /** 'YYYY-MM-DD' — used for rate-change warnings. */
  invoiceDate: string;
  companyStateCode: string;
  companyRegistration: CompanyRegistrationType;
  /** Company is an SEZ unit/developer: all its outward supplies are inter-state. */
  companyIsSez?: boolean;
  partyRegistration: RegistrationType;
  partyStateCode?: string | null;
  /** Party GSTIN — only used for consistency warnings (checksum, state mismatch). */
  partyGstin?: string | null;
  consigneeStateCode?: string | null;
  /** Explicit place of supply (state code or '96'); wins over derivation. */
  placeOfSupply?: string | null;
  /** Export / SEZ supply with payment of IGST (true) or under LUT/bond (false, default). */
  exportWithPayment?: boolean;
  /** Whole document is under reverse charge. */
  reverseCharge?: boolean;
  roundOff?: InvoiceRoundOff;
  /** Inter-state B2C invoices strictly above this value are B2CL. Default B2CL_THRESHOLD_PAISE. */
  b2clThresholdPaise?: Paise;
}

export interface ComputedLine {
  key: string;
  kind: 'item' | 'ledger';
  description?: string;
  /** Value as entered: qty × rate (or amount). Tax-inclusive when `inclusive`. */
  gross: Paise;
  discount: Paise;
  /**
   * Additional-charge apportionment: + value received by a goods line, − value given away by an
   * apportioned charge line. Σ apportioned over the invoice is 0 when the charge is absorbed.
   */
  apportioned: Paise;
  /** Taxable (assessable) value after discount, apportionment and inclusive back-calculation. */
  taxableValue: Paise;
  /**
   * Amount to post to this line's own ledger (sales/purchase/charge): taxableValue − apportioned.
   * Σ postingAmount = Σ taxableValue.
   */
  postingAmount: Paise;
  /** Nominal GST rate (0 for exempt / nil-rated / non-GST lines). */
  rate: number;
  cessRate: number;
  /** Per-unit cess rate in paise (0 when none). */
  cessPerUnit: Paise;
  igst: Paise;
  cgst: Paise;
  /** SGST or UTGST. */
  sgst: Paise;
  cess: Paise;
  /** igst + cgst + sgst + cess. */
  tax: Paise;
  taxability: Taxability;
  hsnSac: string;
  supplyKind: SupplyKind;
  qty: number;
  uqc: string;
  /** Rate was tax-inclusive and was back-calculated. */
  inclusive: boolean;
  /** GST was actually charged/computed on this line (false for LUT, composition, unregistered supplier …). */
  taxCharged: boolean;
  reverseCharge: boolean;
  /** Tax is part of the amount payable to/by the party (false for reverse charge and imports). */
  taxPayableToParty: boolean;
  /** taxableValue + tax. */
  total: Paise;
}

export interface TaxBucket {
  taxability: Taxability;
  rate: number;
  cessRate: number;
  /** Whether tax was computed for this bucket (see ComputedLine.taxCharged). */
  taxCharged: boolean;
  taxableValue: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  tax: Paise;
}

export interface HsnRow {
  hsnSac: string;
  description?: string;
  uqc: string;
  /** Total quantity (goods only; services report 0). */
  qty: number;
  rate: number;
  taxableValue: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  /** taxableValue + all tax. */
  total: Paise;
}

export interface InvoiceTotals {
  /** Σ gross as entered (inclusive lines contribute their tax-inclusive value). */
  lineGross: Paise;
  discount: Paise;
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  /** igst + cgst + sgst + cess (including reverse-charge tax). */
  tax: Paise;
  /** Tax computed but not payable to/by the party (reverse charge, IGST on imports). */
  reverseChargeTax: Paise;
  /** taxable + tax − reverseChargeTax, before round-off. */
  invoiceValueBeforeRound: Paise;
  /** grandTotal − invoiceValueBeforeRound. */
  roundOff: Paise;
  /** Amount payable by / to the party (after round-off). */
  grandTotal: Paise;
  /** Same as grandTotal (kept for readability at call sites). */
  payableToParty: Paise;
}

export interface InvoiceComputation {
  placeOfSupply: string;
  posReason: string;
  /** Supplier's state (company for outward, party for inward). */
  supplierStateCode: string;
  interState: boolean;
  taxMode: TaxMode;
  nature: GstNature;
  documentKind: DocumentKind;
  /** Any line is under reverse charge (or import of services). */
  reverseCharge: boolean;
  lines: ComputedLine[];
  buckets: TaxBucket[];
  hsnSummary: HsnRow[];
  totals: InvoiceTotals;
  /** Non-blocking issues written for an accountant (shown next to the totals). */
  warnings: string[];
}

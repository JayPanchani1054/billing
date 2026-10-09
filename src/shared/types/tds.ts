/**
 * TDS / TCS (Income-tax Act 1961 Chapter XVII-B / XVII-BB; Income-tax Act 2025 ss. 393–394 from
 * 1-Apr-2026). DTOs of the tds module (src/core/modules/tds). Money is integer paise; rates are REAL
 * percent (1 means 1%).
 */
import type { Paise } from '../money.ts';

/** Tax deducted at source (we pay) or tax collected at source (we sell). */
export type TdsKind = 'tds' | 'tcs';
export const TDS_KINDS: readonly TdsKind[] = ['tds', 'tcs'];

/** Deductee / collectee type: drives the rate (194C 1% individual/HUF vs 2% others) and the return code. */
export type DeducteeType = 'company' | 'individual' | 'firm' | 'others';
export const DEDUCTEE_TYPES: readonly DeducteeType[] = ['company', 'individual', 'firm', 'others'];

/** How the threshold is tested: per FY (default) or per calendar month (194I rent from 1-Apr-2025). */
export type TdsAggregatePeriod = 'fy' | 'month';
/**
 * When the aggregate threshold is crossed: 'whole' deducts on the whole aggregate including earlier,
 * not yet deducted credits (194C/194J/194H/…); 'excess' deducts only on the amount above the threshold (194Q).
 */
export type TdsThresholdBasis = 'whole' | 'excess';

// ───────────────────────────── Masters ─────────────────────────────

/** One effective-dated rate row of a nature (tds_nature_rates). */
export interface TdsNatureRate {
  id?: number;
  applicableFrom: string;
  /** Rate for individuals / HUFs (%). */
  rateIndividual: number;
  /** Rate for companies (%). */
  rateCompany: number;
  /** Rate for firms, LLPs, AOP/BOI and others (%). */
  rateOthers: number;
  /** Rate when the deductee has no valid PAN (s.206AA / s.206CC). */
  rateNoPan: number;
  /** Single-transaction threshold (paise); null = none. Deduct when one credit/payment exceeds it. */
  thresholdSingle: Paise | null;
  /** Aggregate threshold per party per nature per period (paise); null = none. */
  thresholdAggregate: Paise | null;
  aggregatePeriod: TdsAggregatePeriod;
  thresholdBasis: TdsThresholdBasis;
  /** Base includes GST (TCS on the invoice value); TDS is on the value excluding GST (CBDT Circular 23/2017). */
  baseIncludesGst: boolean;
  note: string | null;
}

export interface TdsNature {
  id: number;
  guid: string;
  kind: TdsKind;
  /** Display name, e.g. "Payment to contractors". */
  name: string;
  /** Income-tax Act 1961 section as printed on returns, e.g. '194C', '194J(b)', '206C(1F)'. */
  section: string;
  /** Income-tax Act 2025 reference (user-editable; seeded as a hint only, see README). */
  section2025: string | null;
  /** Residents / non-residents (195): decides 26Q vs 27Q. */
  forNonResidents: boolean;
  /** Seeded by the app (still editable; cannot be deleted while used). */
  isSystem: boolean;
  isActive: boolean;
  /** Rates ordered by applicableFrom ascending. */
  rates: TdsNatureRate[];
  /** Rate row in force on the requested date (list/get with `asOf`). */
  current: TdsNatureRate | null;
  /** Ledgers / parties using it (list only). */
  usage?: number;
}

export interface TdsNatureSaveInput {
  id?: number;
  kind: TdsKind;
  name: string;
  section: string;
  section2025?: string;
  forNonResidents?: boolean;
  isActive?: boolean;
  rates: Array<Omit<TdsNatureRate, 'id'>>;
}

/** Lower / nil deduction certificate (s.197 / s.206C(9)). */
export interface TdsCertificate {
  number: string;
  /** Percent (0 = nil deduction). */
  rate: number;
  validFrom: string;
  validTo: string;
  /** Amount the certificate covers (paise); null = no limit. */
  limit: Paise | null;
  /** Nature it covers (null = every nature of the party). */
  natureId: number | null;
}

/** TDS/TCS details kept on a ledger (party, expense, fixed asset or sales ledger). */
export interface TdsLedgerDetails {
  ledgerId: number;
  ledgerName: string;
  groupName: string;
  /** 'party' (debtor/creditor/other deductee), 'expense' (expense / fixed asset / purchase), 'income' (sales / income — TCS). */
  role: 'party' | 'expense' | 'income';
  /** Expense / sales ledger: TDS/TCS applies to amounts posted to it. Party: the party is a deductee. */
  applicable: boolean;
  /** Expense / sales ledger: its nature; party: default nature. */
  natureId: number | null;
  deducteeType: DeducteeType | null;
  /** Non-resident (27Q). */
  nonResident: boolean;
  pan: string | null;
  panStatus: PanStatus;
  certificate: TdsCertificate | null;
  /** Legacy free-text section from the ledger master (before the tds module). */
  legacySection: string | null;
}

export interface TdsLedgerSaveInput {
  ledgerId: number;
  applicable: boolean;
  natureId?: number | null;
  deducteeType?: DeducteeType | null;
  nonResident?: boolean;
  pan?: string | null;
  certificate?: TdsCertificate | null;
}

export type PanStatus = 'valid' | 'missing' | 'invalid' | 'not_applicable';

/** Company-level TDS/TCS setup (settings key 'tds'). */
export interface TdsSettings {
  /** Tax deduction and collection account number (AAAA99999A). Company profile TAN when blank. */
  tan: string;
  deductorCategory: 'company' | 'firm' | 'individual' | 'others' | 'government';
  responsiblePerson: string;
  responsibleDesignation: string;
  /** Buyer's turnover exceeded ₹10 crore in the preceding FY → s.194Q applies to purchases of goods. */
  buyer194Q: boolean;
  /** Round TDS/TCS to the nearest rupee (default true). */
  roundToRupee: boolean;
}

// ───────────────────────────── Voucher integration ─────────────────────────────

/** Override of the computed TDS/TCS of one nature on a voucher. */
export interface VoucherTdsOverride {
  natureId: number;
  /** Amount to deduct/collect (paise, ≥ 0; 0 = do not deduct). */
  amount: Paise;
  /** Why the computed amount was changed (audit; shown in the exceptions report). */
  reason: string;
}

/** Challan details carried by a payment voucher that deposits TDS/TCS (ITNS 281). */
export interface VoucherTdsChallanInput {
  kind: TdsKind;
  /** Nature section deposited ('194C', '206C(1)'…). */
  section: string;
  /** Month of deduction/collection the challan pays for (YYYY-MM). */
  period: string;
  /** BSR code of the bank branch (7 digits). */
  bsrCode: string;
  /** Challan serial number (5 digits). */
  challanNo: string;
  depositDate: string;
  /** Minor head 200 (payable by taxpayer) or 400 (regular assessment / demand). */
  minorHead?: '200' | '400';
  tax: Paise;
  surcharge?: Paise;
  cess?: Paise;
  interest?: Paise;
  fee?: Paise;
  others?: Paise;
}

/** `VoucherInput.tds` (absent = automatic computation when TDS/TCS is on). */
export interface VoucherTdsInput {
  /** Payment (advance) or a journal without TDS-applicable lines: deduct under this nature on the party's gross. */
  natureId?: number;
  overrides?: VoucherTdsOverride[];
  challan?: VoucherTdsChallanInput;
}

export type TdsLineStatus = 'deducted' | 'below_threshold' | 'certificate' | 'overridden_nil' | 'no_party';

/** One computed TDS/TCS line of a voucher (preview and tds_lines). */
export interface TdsVoucherLine {
  kind: TdsKind;
  natureId: number;
  natureName: string;
  section: string;
  partyLedgerId: number | null;
  partyName: string | null;
  deducteeType: DeducteeType;
  pan: string | null;
  panStatus: PanStatus;
  /** This voucher's assessable amount for the nature (excl. GST for TDS). */
  assessable: Paise;
  /** Earlier credits of the period not yet subjected to deduction, taken in now (threshold crossed). */
  catchUp: Paise;
  /** Base the tax was computed on (assessable + catch-up, or the excess for 194Q). */
  base: Paise;
  rate: number;
  /** Computed amount before override. */
  computed: Paise;
  /** Amount posted. */
  amount: Paise;
  overridden: boolean;
  reason: string | null;
  status: TdsLineStatus;
  /** Duty ledger the amount is posted to (null in preview when it will be created on save). */
  payableLedgerId: number | null;
  payableLedgerName: string;
  /** Explanation for the accountant ("Aggregate ₹1,20,000 crossed ₹1,00,000 …"). */
  note: string;
}

/** `VoucherPreview.tds` */
export interface TdsVoucherPreview {
  lines: TdsVoucherLine[];
  /** Σ amount of TDS lines (deducted from the party). */
  tds: Paise;
  /** Σ amount of TCS lines (added to the invoice value). */
  tcs: Paise;
  /** Natures the user may pick for an advance payment / journal (active natures of the right kind). */
  challan: VoucherTdsChallanInput | null;
}

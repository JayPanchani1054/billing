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
  /**
   * Expense / sales ledger: TDS/TCS applies to amounts posted to it. Party: TDS is deducted from it /
   * TCS collected from it — on by default; off marks a party exempt (e.g. s.196, a transporter's
   * s.194C(6) declaration), and nothing is computed on its vouchers.
   */
  applicable: boolean;
  /** Expense / sales ledger: its nature; party: default nature. */
  natureId: number | null;
  deducteeType: DeducteeType | null;
  /** Non-resident (27Q). */
  nonResident: boolean;
  pan: string | null;
  panStatus: PanStatus;
  certificate: TdsCertificate | null;
  /** Customer who deducts TDS from our receipts: its TAN (Form 26AS match key). */
  deductorTan: string | null;
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
  deductorTan?: string | null;
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
  /**
   * (additive) Part of this credit already covered by an advance paid to the party under the nature
   * (counted — and taxed when liable — when it was paid); `assessable` is net of it. 0 when none.
   */
  advanceAdjusted?: Paise;
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
  /**
   * (additive, final wave) The bill this line belongs to: on a debit note (TDS) / credit note (TCS) the
   * bill whose tax it reverses in proportion (the line's amounts are then negative); on a TDS journal for
   * a bill booked gross, the bill the tax was deducted on. Absent otherwise.
   */
  billVoucherId?: number | null;
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

// ───────────────────────────── Reports ─────────────────────────────

export interface TdsComputationRow {
  key: string;
  kind: TdsKind;
  partyLedgerId: number | null;
  partyName: string;
  pan: string | null;
  panStatus: PanStatus;
  deducteeType: DeducteeType;
  natureId: number;
  natureName: string;
  section: string;
  /** Voucher lines. */
  count: number;
  /** Σ amounts credited / paid (assessable). */
  credited: Paise;
  /** Part of `credited` below the threshold when entered. */
  belowThreshold: Paise;
  /** Σ base the tax was computed on. */
  base: Paise;
  deducted: Paise;
  /** Cleared by challans deposited up to the period end. */
  deposited: Paise;
  balance: Paise;
}

export interface TdsComputationResult {
  rows: TdsComputationRow[];
  totals: { count: number; credited: Paise; belowThreshold: Paise; base: Paise; deducted: Paise; deposited: Paise; balance: Paise };
}

export interface TdsLineRow {
  id: number;
  voucherId: number;
  number: string | null;
  typeName: string;
  date: string;
  kind: TdsKind;
  section: string;
  natureName: string;
  partyLedgerId: number | null;
  partyName: string | null;
  pan: string | null;
  panStatus: PanStatus;
  assessable: Paise;
  catchUp: Paise;
  /** (additive) Part of the credit set off against an earlier advance (see TdsVoucherLine). */
  advanceAdjusted: Paise;
  base: Paise;
  rate: number;
  computed: Paise;
  amount: Paise;
  overridden: boolean;
  reason: string | null;
  status: TdsLineStatus;
  note: string | null;
  deposited: Paise;
  balance: Paise;
  dueDate: string | null;
}

export type TdsOutstandingStatus = 'due' | 'overdue' | 'paid' | 'paid_late' | 'excess' | 'nothing_due';

export interface TdsOutstandingRow {
  key: string;
  kind: TdsKind;
  section: string;
  /** YYYY-MM of deduction. */
  period: string;
  periodLabel: string;
  payableLedgerName: string;
  deducted: Paise;
  deposited: Paise;
  balance: Paise;
  dueDate: string;
  daysOverdue: number;
  status: TdsOutstandingStatus;
  /** Interest u/s 201(1A)(ii) (TDS, 1.5%/month) or 206C(7) (TCS, 1%/month) on late / unpaid deposits to the as-of date. */
  interest: Paise;
  /** Interest already paid with this month's challans. */
  interestPaid: Paise;
  lastDeposit: string | null;
  lines: number;
}

export interface TdsStatementRow {
  key: string;
  form: '26Q' | '27Q' | '27EQ';
  fyStart: number;
  quarter: 1 | 2 | 3 | 4;
  label: string;
  dueDate: string;
  filedOn: string | null;
  tokenNo: string | null;
  tax: Paise;
  lines: number;
  daysLate: number;
  /** s.234E: ₹200 per day, capped at the tax of the statement. */
  lateFee: Paise;
  status: 'due' | 'overdue' | 'filed' | 'filed_late';
}

export interface TdsOutstandingResult {
  asOf: string;
  kind: TdsKind;
  rows: TdsOutstandingRow[];
  statements: TdsStatementRow[];
  totals: { deducted: Paise; deposited: Paise; balance: Paise; interest: Paise; interestPaid: Paise; lateFee: Paise };
}

export interface TdsChallanRow {
  id: number;
  voucherId: number;
  number: string | null;
  kind: TdsKind;
  section: string;
  period: string;
  periodLabel: string;
  bsrCode: string;
  challanNo: string;
  depositDate: string;
  minorHead: string;
  bankName: string | null;
  tax: Paise;
  surcharge: Paise;
  cess: Paise;
  interest: Paise;
  fee: Paise;
  others: Paise;
  total: Paise;
  /** Deductions of its month this challan clears. */
  cleared: Paise;
  /** Tax deposited beyond the deductions of its month. */
  unconsumed: Paise;
  /** Deposited after the due date. */
  late: boolean;
}

export interface TdsChallanRegister {
  rows: TdsChallanRow[];
  totals: Record<string, Paise>;
}

export interface TdsReturnDeducteeRow {
  /** Serial of the challan in `challans` (null: not deposited). */
  challanSr: number | null;
  bsrCode: string | null;
  depositDate: string | null;
  challanNo: string | null;
  section: string;
  /** 01 company, 02 other than company. */
  deducteeCode: '01' | '02';
  /** 'PANNOTAVBL' when the deductee has no valid PAN. */
  pan: string;
  name: string;
  partyLedgerId: number | null;
  paymentDate: string;
  amountPaid: Paise;
  tax: Paise;
  deposited: Paise;
  deductionDate: string;
  rate: number;
  /** 'A' lower/nil deduction certificate (s.197), 'C' higher rate for no PAN, '' otherwise. */
  reasonCode: string;
  certificateNo: string | null;
  voucherId: number;
  voucherNumber: string | null;
}

export interface TdsReturnChallanRow {
  sr: number;
  voucherId: number;
  section: string;
  period: string;
  bsrCode: string;
  challanNo: string;
  depositDate: string;
  minorHead: string;
  tax: Paise;
  surcharge: Paise;
  cess: Paise;
  interest: Paise;
  fee: Paise;
  others: Paise;
  total: Paise;
  /** Σ deposited of the deductee rows linked to it. */
  allocated: Paise;
}

export interface TdsReturnData {
  form: '26Q' | '27Q' | '27EQ';
  fyStart: number;
  quarter: 1 | 2 | 3 | 4;
  from: string;
  to: string;
  tan: string;
  deductees: TdsReturnDeducteeRow[];
  challans: TdsReturnChallanRow[];
  totals: { amountPaid: Paise; tax: Paise; deposited: Paise; challanTotal: Paise };
  dueDate: string;
  filedOn: string | null;
  tokenNo: string | null;
  lateFee: Paise;
  daysLate: number;
  warnings: string[];
}

export type TdsExceptionType =
  | 'no_party'
  | 'no_pan'
  | 'invalid_pan'
  | 'below_threshold_deducted'
  | 'not_deducted'
  | 'short_deducted'
  | 'threshold_not_deducted';

export interface TdsExceptionRow {
  key: string;
  type: TdsExceptionType;
  severity: 'error' | 'warning';
  voucherId: number;
  number: string | null;
  typeName: string;
  date: string;
  partyLedgerId: number | null;
  partyName: string | null;
  section: string;
  amount: Paise;
  /** Tax not deducted / short deducted. */
  shortfall: Paise;
  /** Interest u/s 201(1A)(i) on the shortfall to the as-of date (estimate). */
  interest: Paise;
  message: string;
}

/** TDS deducted by customers: books (TDS Receivable) vs Form 26AS / AIS. */
export interface TdsReceivableRow {
  key: string;
  partyLedgerId: number | null;
  partyName: string;
  tan: string | null;
  books: Paise;
  form26as: Paise;
  /** Amount paid / credited per 26AS. */
  amountPaid: Paise;
  difference: Paise;
  status: 'matched' | 'mismatch' | 'books_only' | 'form26as_only';
}

export interface TdsReceivableResult {
  fyStart: number;
  receivableLedgers: Array<{ id: number; name: string }>;
  rows: TdsReceivableRow[];
  totals: { books: Paise; form26as: Paise; difference: Paise };
  imported: { rows: number; importedAt: string | null };
}

export interface TdsChallanSuggestion {
  kind: TdsKind;
  section: string;
  period: string;
  dueDate: string;
  unpaid: Paise;
  interest: Paise;
  lines: number;
  payableLedgerId: number | null;
  payableLedgerName: string;
}

export interface TdsChallanSaveInput {
  /** Alter this challan's payment voucher. */
  voucherId?: number;
  voucherTypeId?: number;
  date: string;
  bankLedgerId: number;
  narration?: string;
  challan: VoucherTdsChallanInput;
  acknowledgeWarnings?: boolean;
  expectedUpdatedAt?: string;
}

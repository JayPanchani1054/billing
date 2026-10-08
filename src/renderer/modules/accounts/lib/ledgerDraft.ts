/**
 * Ledger form model: the editable draft, conversion from LedgerDetail, Tally-like defaults when a
 * group is chosen, client validation (same messages as the core where they overlap) and the
 * LedgerSaveInput (full values on create; only changed fields on alter — patch semantics).
 * Pure — tested in ledgerDraft.test.ts.
 */
import type { GstDutyHead, GstTaxDirection } from '../../../../shared/constants.ts';
import { isStandardRate, isValidCessRate, isValidRate } from '../../../../shared/gst/rates.ts';
import type { Paise } from '../../../../shared/money.ts';
import type {
  AppropriateBy,
  IncludeInAssessable,
  ItcEligibility,
  LedgerClass,
  LedgerDetail,
  LedgerFields,
  LedgerTaxType,
} from '../../../../shared/types/accounts.ts';
import type { RegistrationType, SupplyKind, Taxability } from '../../../../shared/types/gst.ts';
import type { ApiInput } from '../../../app/api.ts';
import {
  isSacCode,
  normalizeIfsc,
  normalizePan,
  validateBankAccountNo,
  validateEmail,
  validateHsnSac,
  validateIfsc,
  validateMobile,
  validatePan,
  validatePincode,
  validateUpiId,
} from '../../../../shared/validators.ts';
import { gstinProblem, panProblem } from './gstin.ts';
import type { LedgerSections } from './ledgerSections.ts';
import { billDraftFrom, billsForSave, checkBills, sameBills, validateBills } from './openingBills.ts';
import type { BillDraft } from './openingBills.ts';

export interface LedgerDraft {
  name: string;
  alias: string;
  groupId: number | null;
  isActive: boolean;
  notes: string;
  openingBalance: Paise;
  currencyId: number | null;
  billWise: boolean;
  defaultCreditDays: number | null;
  creditLimit: Paise | null;
  interestEnabled: boolean;
  interestRate: number | null;
  costCentresApplicable: boolean;
  inventoryValuesAffected: boolean;
  mailingName: string;
  address: string;
  stateCode: string;
  country: string;
  pincode: string;
  contactPerson: string;
  phone: string;
  mobile: string;
  email: string;
  pan: string;
  registrationType: RegistrationType | '';
  gstin: string;
  isEcommerceOperator: boolean;
  bankAccountHolder: string;
  bankAccountNo: string;
  bankIfsc: string;
  bankName: string;
  bankBranch: string;
  bankUpiId: string;
  chequeBookEnabled: boolean;
  taxType: LedgerTaxType | '';
  gstDutyHead: GstDutyHead | '';
  gstTaxDirection: GstTaxDirection | '';
  gstApplicable: boolean;
  gstTaxability: Taxability;
  gstRate: number | null;
  cessRate: number | null;
  hsnSac: string;
  gstSupplyType: SupplyKind | '';
  isReverseCharge: boolean;
  itcEligibility: ItcEligibility | '';
  includeInAssessable: IncludeInAssessable | '';
  appropriateBy: AppropriateBy | '';
  tdsApplicable: boolean;
  tdsSection: string;
  openingBills: BillDraft[];
  /** Alter only: date from which changed GST details apply (null = correct the current details). */
  applicableFrom: string | null;
  allowNonStandardRate: boolean;
}

export function emptyLedgerDraft(initialName = '', groupId: number | null = null): LedgerDraft {
  return {
    name: initialName,
    alias: '',
    groupId,
    isActive: true,
    notes: '',
    openingBalance: 0,
    currencyId: null,
    billWise: false,
    defaultCreditDays: null,
    creditLimit: null,
    interestEnabled: false,
    interestRate: null,
    costCentresApplicable: false,
    inventoryValuesAffected: false,
    mailingName: '',
    address: '',
    stateCode: '',
    country: 'India',
    pincode: '',
    contactPerson: '',
    phone: '',
    mobile: '',
    email: '',
    pan: '',
    registrationType: '',
    gstin: '',
    isEcommerceOperator: false,
    bankAccountHolder: '',
    bankAccountNo: '',
    bankIfsc: '',
    bankName: '',
    bankBranch: '',
    bankUpiId: '',
    chequeBookEnabled: false,
    taxType: '',
    gstDutyHead: '',
    gstTaxDirection: '',
    gstApplicable: false,
    gstTaxability: 'taxable',
    gstRate: null,
    cessRate: null,
    hsnSac: '',
    gstSupplyType: '',
    isReverseCharge: false,
    itcEligibility: '',
    includeInAssessable: '',
    appropriateBy: '',
    tdsApplicable: false,
    tdsSection: '',
    openingBills: [],
    applicableFrom: null,
    allowNonStandardRate: false,
  };
}

const s = (v: string | null | undefined): string => v ?? '';

export function draftFromDetail(d: LedgerDetail): LedgerDraft {
  return {
    name: d.name,
    alias: s(d.alias),
    groupId: d.groupId,
    isActive: d.isActive,
    notes: s(d.notes),
    openingBalance: d.openingBalance,
    currencyId: d.currencyId,
    billWise: d.billWise,
    defaultCreditDays: d.defaultCreditDays,
    creditLimit: d.creditLimit,
    interestEnabled: d.interestEnabled,
    interestRate: d.interestRate,
    costCentresApplicable: d.costCentresApplicable,
    inventoryValuesAffected: d.inventoryValuesAffected,
    mailingName: s(d.mailingName),
    address: s(d.address),
    stateCode: s(d.stateCode),
    // Kept as stored: non-party ledgers have none, and showing 'India' would send it back as a change.
    country: s(d.country),
    pincode: s(d.pincode),
    contactPerson: s(d.contactPerson),
    phone: s(d.phone),
    mobile: s(d.mobile),
    email: s(d.email),
    pan: s(d.pan),
    registrationType: d.registrationType ?? '',
    gstin: s(d.gstin),
    isEcommerceOperator: d.isEcommerceOperator,
    bankAccountHolder: s(d.bankAccountHolder),
    bankAccountNo: s(d.bankAccountNo),
    bankIfsc: s(d.bankIfsc),
    bankName: s(d.bankName),
    bankBranch: s(d.bankBranch),
    bankUpiId: s(d.bankUpiId),
    chequeBookEnabled: d.chequeBookEnabled,
    taxType: d.taxType ?? '',
    gstDutyHead: d.gstDutyHead ?? '',
    gstTaxDirection: d.gstTaxDirection ?? '',
    gstApplicable: d.gstApplicable,
    gstTaxability: d.gstTaxability ?? 'taxable',
    gstRate: d.gstRate,
    cessRate: d.cessRate,
    hsnSac: s(d.hsnSac),
    gstSupplyType: d.gstSupplyType ?? '',
    isReverseCharge: d.isReverseCharge,
    itcEligibility: d.itcEligibility ?? '',
    includeInAssessable: d.includeInAssessable ?? '',
    appropriateBy: d.appropriateBy ?? '',
    tdsApplicable: d.tdsApplicable,
    tdsSection: s(d.tdsSection),
    openingBills: d.openingBills.map(billDraftFrom),
    applicableFrom: null,
    allowNonStandardRate: d.gstRate !== null && !isStandardRate(d.gstRate),
  };
}

export interface DefaultsContext {
  features: { billWise: boolean; inventory: boolean; gst: boolean };
  gstEnabled: boolean;
  companyStateCode: string | null;
}

/**
 * Tally-like defaults when a NEW ledger's group changes (same defaults the server applies to
 * fields it is not given, shown up-front so the user sees and can change them):
 * customers/suppliers keep bills (F11 bill-wise) and start in the company's state; Sales/Purchase
 * ledgers affect inventory and are GST-applicable, taxable, rate from the items.
 */
export function applyGroupDefaults(d: LedgerDraft, prev: LedgerClass | null, next: LedgerClass | null, ctx: DefaultsContext): LedgerDraft {
  if (!next) return d;
  const out = { ...d };
  const wasParty = prev?.isParty ?? false;
  const wasTrading = (prev?.isSales || prev?.isPurchase) ?? false;
  if (next.isParty && !wasParty) {
    out.billWise = ctx.features.billWise;
    if (!out.stateCode && out.registrationType !== 'overseas' && ctx.companyStateCode) out.stateCode = ctx.companyStateCode;
  }
  if (!next.isParty && wasParty && out.openingBills.length === 0) out.billWise = false;
  const trading = next.isSales || next.isPurchase;
  if (trading && !wasTrading) {
    out.inventoryValuesAffected = ctx.features.inventory;
    if (ctx.gstEnabled) {
      out.gstApplicable = true;
      out.gstTaxability = 'taxable';
    }
  }
  return out;
}

const blank = (v: string): boolean => v.trim() === '';

export interface ValidateContext {
  sections: LedgerSections;
  booksFrom: string;
  /** Final validation (on save) also flags partial GSTINs. */
  final: boolean;
}

/** Client-side problems keyed by LedgerSaveInput field path. Empty object = OK to send. */
export function validateLedgerDraft(d: LedgerDraft, ctx: ValidateContext): Record<string, string> {
  const e: Record<string, string> = {};
  const sec = ctx.sections;
  if (blank(d.name)) e.name = 'Enter the ledger name';
  else if (d.name.trim().length > 200) e.name = 'Use at most 200 characters';
  if (!blank(d.alias) && d.alias.trim().toLowerCase() === d.name.trim().toLowerCase()) e.alias = 'The alias is the same as the name — leave it blank';
  if (d.groupId === null) e.groupId = 'Choose the group this ledger belongs under (e.g. Sundry Debtors for a customer)';

  if (sec.party) {
    const g = gstinProblem(d, ctx.final);
    if (g) e[g.field] = g.message;
    if (!blank(d.pan)) {
      const p = validatePan(d.pan) ?? panProblem(d);
      if (p) e.pan = p;
    }
    const inIndia = (blank(d.country) || d.country.trim().toLowerCase() === 'india') && d.registrationType !== 'overseas';
    if (!blank(d.pincode) && inIndia) {
      const p = validatePincode(d.pincode);
      if (p) e.pincode = p;
    }
    if (!blank(d.email)) {
      const m = validateEmail(d.email);
      if (m) e.email = m;
    }
    if (!blank(d.mobile)) {
      const m = validateMobile(d.mobile);
      if (m) e.mobile = m;
    }
    if (d.defaultCreditDays !== null && (d.defaultCreditDays < 0 || d.defaultCreditDays > 3650)) e.defaultCreditDays = 'Credit period must be between 0 and 3650 days';
    if (d.creditLimit !== null && d.creditLimit < 0) e.creditLimit = 'Credit limit cannot be negative';
  }
  if (sec.interest && d.interestEnabled) {
    if (d.interestRate === null) e.interestRate = 'Enter the interest rate (% per annum), or turn off interest calculation';
    else if (d.interestRate < 0 || d.interestRate > 100) e.interestRate = 'Interest rate must be between 0 and 100% per annum';
  }
  if (sec.bank) {
    if (!blank(d.bankIfsc)) {
      const m = validateIfsc(d.bankIfsc);
      if (m) e.bankIfsc = m;
    }
    if (!blank(d.bankAccountNo)) {
      const m = validateBankAccountNo(d.bankAccountNo);
      if (m) e.bankAccountNo = m;
    }
    if (!blank(d.bankUpiId)) {
      const m = validateUpiId(d.bankUpiId);
      if (m) e.bankUpiId = m;
    }
  }
  if (sec.tax && d.taxType === 'GST' && d.gstDutyHead === '') e.gstDutyHead = 'Choose the GST duty head of this tax ledger: IGST, CGST, SGST/UTGST or Cess';
  if (sec.gstDetails && d.gstApplicable) {
    if (d.gstTaxability !== 'taxable') {
      if (d.gstRate !== null && d.gstRate !== 0) e.gstRate = 'An exempt, nil-rated or non-GST ledger has no GST rate. Clear the rate or set the taxability to Taxable.';
      if (d.cessRate !== null && d.cessRate !== 0) e.cessRate = 'Cess applies only to taxable supplies.';
    } else if (d.gstRate !== null) {
      if (!isValidRate(d.gstRate)) e.gstRate = 'GST rate must be between 0 and 100%';
      else if (!isStandardRate(d.gstRate) && !d.allowNonStandardRate) e.gstRate = `${d.gstRate}% is not a GST rate slab. Choose a slab, or tick "Non-standard rate" if a notification prescribes it.`;
    }
    if (d.cessRate !== null && !e.cessRate && !isValidCessRate(d.cessRate)) e.cessRate = 'Cess rate must be between 0 and 400%';
    if (!blank(d.hsnSac)) {
      const kind = d.gstSupplyType || (isSacCode(d.hsnSac.trim()) ? 'services' : 'goods');
      const m = validateHsnSac(d.hsnSac, kind);
      if (m) e.hsnSac = m;
    }
  }
  if (sec.billWise && d.billWise) {
    Object.assign(e, validateBills(d.openingBills, ctx.booksFrom));
    // Same rule as the core (bills, when entered, must add up to the opening balance) — caught here so
    // the grid says so before a round trip.
    const check = checkBills(d.openingBalance, d.openingBills);
    if (!check.balanced) e.openingBills = `${check.message} Correct a bill or the opening balance, or use "Put the difference in a bill".`;
  }
  return e;
}

const opt = (v: string): string | null => (v.trim() === '' ? null : v.trim());
const optEnum = <T extends string>(v: T | ''): T | null => (v === '' ? null : v);

/**
 * Every LedgerFields value the draft stands for.
 *
 * What is cleared when its section is hidden:
 * - bank, tax and GST rate details whenever the group does not allow them (the core would refuse
 *   or clear them anyway);
 * - party details only on create (on alter they are kept, as Tally does, so moving a ledger
 *   between groups never loses an address);
 * - nothing that is hidden only because an F11 feature (bill-wise, interest, cost centres,
 *   inventory, TDS, multi-currency) or the company's GST is off — turning a feature off must not
 *   wipe stored settings.
 */
export function fieldsFromDraft(d: LedgerDraft, sec: LedgerSections, mode: 'create' | 'alter' = 'create'): LedgerFields {
  const party = sec.party || mode === 'alter';
  const gstOk = sec.gstAllowed;
  const gst = gstOk && d.gstApplicable;
  const taxable = gst && d.gstTaxability === 'taxable';
  const inward = gst && sec.gstInwardAllowed;
  return {
    name: d.name.trim(),
    alias: opt(d.alias),
    groupId: d.groupId ?? 0,
    isActive: d.isActive,
    openingBalance: sec.openingBalance || mode === 'alter' ? d.openingBalance : 0,
    currencyId: d.currencyId,
    billWise: d.billWise,
    defaultCreditDays: party ? d.defaultCreditDays : null,
    creditLimit: party ? d.creditLimit : null,
    interestEnabled: d.interestEnabled,
    // On alter a switched-off rate / section is kept (Tally keeps it; the core does not need it cleared).
    interestRate: d.interestEnabled || mode === 'alter' ? d.interestRate : null,
    costCentresApplicable: d.costCentresApplicable,
    inventoryValuesAffected: d.inventoryValuesAffected,
    mailingName: party ? opt(d.mailingName) : null,
    address: party ? opt(d.address) : null,
    stateCode: party ? opt(d.stateCode) : null,
    country: party ? opt(d.country) : null,
    pincode: party ? opt(d.pincode) : null,
    contactPerson: party ? opt(d.contactPerson) : null,
    phone: party ? opt(d.phone) : null,
    mobile: party ? opt(d.mobile) : null,
    email: party ? opt(d.email) : null,
    pan: party && !blank(d.pan) ? normalizePan(d.pan) : null,
    registrationType: party ? optEnum(d.registrationType) : null,
    gstin: party && !blank(d.gstin) ? d.gstin.replace(/\s+/g, '').toUpperCase() : null,
    isEcommerceOperator: party ? d.isEcommerceOperator : false,
    bankAccountHolder: sec.bank ? opt(d.bankAccountHolder) : null,
    bankAccountNo: sec.bank ? opt(d.bankAccountNo.replace(/\s+/g, '')) : null,
    bankIfsc: sec.bank && !blank(d.bankIfsc) ? normalizeIfsc(d.bankIfsc) : null,
    bankName: sec.bank ? opt(d.bankName) : null,
    bankBranch: sec.bank ? opt(d.bankBranch) : null,
    bankUpiId: sec.bank ? opt(d.bankUpiId) : null,
    chequeBookEnabled: sec.bank ? d.chequeBookEnabled : false,
    taxType: sec.tax ? optEnum(d.taxType) : null,
    gstDutyHead: sec.tax && d.taxType === 'GST' ? optEnum(d.gstDutyHead) : null,
    gstTaxDirection: sec.tax && d.taxType === 'GST' ? optEnum(d.gstTaxDirection) : null,
    gstApplicable: gstOk ? d.gstApplicable : false,
    gstTaxability: gst ? d.gstTaxability : null,
    // A non-taxable ledger carries no rate; the core stores 0 for an explicit 0, so 0 is kept as 0.
    gstRate: taxable ? d.gstRate : gst && d.gstRate === 0 ? 0 : null,
    cessRate: taxable ? d.cessRate : gst && d.cessRate === 0 ? 0 : null,
    hsnSac: gst ? opt(d.hsnSac) : null,
    gstSupplyType: gst ? optEnum(d.gstSupplyType) : null,
    isReverseCharge: inward ? d.isReverseCharge : false,
    itcEligibility: inward ? optEnum(d.itcEligibility) : null,
    gstNatureOverride: null,
    includeInAssessable: gstOk ? optEnum(d.includeInAssessable) : null,
    // The form shows "Based on value" when nothing is chosen, so that is what is saved.
    appropriateBy: gstOk && (d.includeInAssessable === 'goods' || d.includeInAssessable === 'services') ? (optEnum(d.appropriateBy) ?? 'value') : null,
    tdsApplicable: d.tdsApplicable,
    tdsSection: d.tdsApplicable || mode === 'alter' ? opt(d.tdsSection) : null,
    notes: opt(d.notes),
  };
}

const GST_HISTORY_FIELDS: ReadonlyArray<keyof LedgerFields> = ['gstTaxability', 'gstRate', 'cessRate', 'hsnSac'];

/** What the 'accounts.ledger.save' route accepts (name/group/flags are never null on the wire). */
export type LedgerSaveRouteInput = ApiInput<'accounts.ledger.save'>;

export interface SaveBuild {
  input: LedgerSaveRouteInput;
  /** Server index → grid row index for opening-bill errors. */
  billIndexMap: number[];
  /** Alter: nothing changed. */
  unchanged: boolean;
}

/**
 * Build the save input. Create: every field (hidden sections cleared). Alter: only fields whose
 * value differs from `original` (an omitted field keeps its value on the server); opening bills
 * only when changed; `applicableFrom` only when a GST rate detail changed and GST stays on with
 * a rate (the server refuses it when the history would be removed).
 */
export function buildSaveInput(d: LedgerDraft, sec: LedgerSections, original: LedgerDetail | null): SaveBuild {
  const fields = fieldsFromDraft(d, sec, original ? 'alter' : 'create');
  const bills = d.billWise ? billsForSave(d.openingBills) : { input: [], serverIndexMap: [] };
  if (!original) {
    const input: LedgerSaveRouteInput = { ...fields };
    delete input.gstNatureOverride;
    if (bills.input.length > 0) input.openingBills = bills.input;
    if (d.allowNonStandardRate && fields.gstRate !== null && !isStandardRate(fields.gstRate)) input.allowNonStandardRate = true;
    return { input, billIndexMap: bills.serverIndexMap, unchanged: false };
  }
  const rec: Record<string, unknown> = { id: original.id };
  const input = rec as LedgerSaveRouteInput;
  for (const k of Object.keys(fields) as Array<keyof LedgerFields>) {
    if (k === 'gstNatureOverride') continue;
    const now = fields[k];
    const was = original[k] ?? null;
    if (now !== was) rec[k] = now;
  }
  if (!sameBills(bills.input, original.openingBills)) input.openingBills = bills.input;
  if (fields.gstRate !== null && !isStandardRate(fields.gstRate) && d.allowNonStandardRate) input.allowNonStandardRate = true;
  if (d.applicableFrom && historyDateApplies(d, sec, original)) input.applicableFrom = d.applicableFrom;
  const unchanged = Object.keys(rec).length === 1;
  return { input, billIndexMap: bills.serverIndexMap, unchanged };
}

/** GST details define a rate (core `definesRate`): GST applies and a rate or a non-taxable taxability is set. */
export function definesRate(f: Pick<LedgerFields, 'gstApplicable' | 'gstRate' | 'gstTaxability'>): boolean {
  return f.gstApplicable && (f.gstRate !== null || (f.gstTaxability !== null && f.gstTaxability !== 'taxable'));
}

/**
 * What a change of GST rate details means for the dated rate history:
 * - 'dated': the saved ledger and the new details both define a rate, so the change may apply from a
 *   date (earlier invoices keep the earlier details) — the form offers "applies from";
 * - 'removes': the new details define no rate (GST off, rate cleared → rate from items), so the core
 *   removes the history and refuses a date;
 * - 'first': the ledger had no rate before, so the new details apply to every date;
 * - 'none': no GST rate detail changed.
 */
export function gstHistoryEffect(d: LedgerDraft, sec: LedgerSections, original: LedgerDetail | null): 'none' | 'dated' | 'removes' | 'first' {
  if (!original || !gstDetailsChanged(d, sec, original)) return 'none';
  const after = fieldsFromDraft(d, sec, 'alter');
  if (!definesRate(after)) return definesRate(original) ? 'removes' : 'none';
  return definesRate(original) ? 'dated' : 'first';
}

/** The "applies from" date is meaningful (and sent) only for a dated change of an existing rate. */
export function historyDateApplies(d: LedgerDraft, sec: LedgerSections, original: LedgerDetail | null): boolean {
  return gstHistoryEffect(d, sec, original) === 'dated';
}

/** True when a GST rate detail (taxability, rate, cess, HSN/SAC) differs from the saved ledger. */
export function gstDetailsChanged(d: LedgerDraft, sec: LedgerSections, original: LedgerDetail | null): boolean {
  if (!original) return false;
  const f = fieldsFromDraft(d, sec, 'alter');
  return GST_HISTORY_FIELDS.some((k) => f[k] !== (original[k] ?? null));
}

/** Draft differs from where it started (for the dirty flag). */
export function isDraftDirty(d: LedgerDraft, baseline: LedgerDraft): boolean {
  const strip = (x: LedgerDraft): unknown => ({ ...x, openingBills: x.openingBills.map((b) => ({ ...b, key: '' })) });
  return JSON.stringify(strip(d)) !== JSON.stringify(strip(baseline));
}

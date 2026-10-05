/**
 * Ledger master rules: row ↔ DTO mapping, defaults, patch merge and the full validation of a ledger
 * before it is written (GST registration, identifiers, field placement by group, opening bills, GST
 * rate details). Used by ledgers.ts (save/bulk create) and groups.ts (moving a group must keep the
 * ledgers under it valid).
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr } from '../../../shared/format.ts';
import {
  GST_RATES,
  getState,
  isKnownStateCode,
  isStandardRate,
  isValidCessRate,
  isValidRate,
  normalizeStateCode,
  stateName,
  validateGstin,
} from '../../../shared/gst/index.ts';
import type { LedgerCode } from '../../../shared/constants.ts';
import type { LedgerClass, LedgerFields, LedgerSaveInput, OpeningBillInput } from '../../../shared/types/accounts.ts';
import type { RegistrationType } from '../../../shared/types/gst.ts';
import {
  isSacCode,
  normalizeIfsc,
  normalizeMobile,
  normalizePan,
  validateBankAccountNo,
  validateEmail,
  validateHsnSac,
  validateIfsc,
  validateMobile,
  validatePan,
  validatePincode,
  validateUpiId,
} from '../../../shared/validators.ts';
import type { BindValue, Db } from '../../db/db.ts';
import type { GroupTree } from './books.ts';
import { cleanCode, cleanText, type Issues } from './common.ts';

// ───────────────────────────── Row mapping ─────────────────────────────

export interface LedgerDbRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  group_id: number;
  reserved_code: LedgerCode | null;
  is_predefined: number;
  is_active: number;
  opening_balance: number;
  currency_id: number | null;
  maintain_bill_wise: number;
  default_credit_days: number | null;
  credit_limit: number | null;
  interest_enabled: number;
  interest_rate: number | null;
  cost_centres_applicable: number;
  inventory_values_affected: number;
  mailing_name: string | null;
  address: string | null;
  state_code: string | null;
  country: string | null;
  pincode: string | null;
  contact_person: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  pan: string | null;
  gst_registration_type: string | null;
  gstin: string | null;
  is_ecommerce_operator: number;
  bank_account_holder: string | null;
  bank_account_no: string | null;
  bank_ifsc: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  bank_upi_id: string | null;
  cheque_book_enabled: number;
  tax_type: string | null;
  gst_duty_head: string | null;
  gst_tax_direction: string | null;
  gst_applicable: string;
  gst_taxability: string | null;
  gst_rate: number | null;
  cess_rate: number | null;
  hsn_sac: string | null;
  gst_supply_type: string | null;
  is_reverse_charge: number;
  itc_eligibility: string | null;
  gst_nature_override: string | null;
  include_in_assessable: string | null;
  appropriate_by: string | null;
  tds_applicable: number;
  tds_section: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** DTO field → column. `gstApplicable` is stored as 'applicable' / 'not_applicable'. */
export const LEDGER_COLUMNS: ReadonlyArray<readonly [keyof LedgerFields, keyof LedgerDbRow]> = [
  ['name', 'name'],
  ['alias', 'alias'],
  ['groupId', 'group_id'],
  ['isActive', 'is_active'],
  ['openingBalance', 'opening_balance'],
  ['currencyId', 'currency_id'],
  ['billWise', 'maintain_bill_wise'],
  ['defaultCreditDays', 'default_credit_days'],
  ['creditLimit', 'credit_limit'],
  ['interestEnabled', 'interest_enabled'],
  ['interestRate', 'interest_rate'],
  ['costCentresApplicable', 'cost_centres_applicable'],
  ['inventoryValuesAffected', 'inventory_values_affected'],
  ['mailingName', 'mailing_name'],
  ['address', 'address'],
  ['stateCode', 'state_code'],
  ['country', 'country'],
  ['pincode', 'pincode'],
  ['contactPerson', 'contact_person'],
  ['phone', 'phone'],
  ['mobile', 'mobile'],
  ['email', 'email'],
  ['pan', 'pan'],
  ['registrationType', 'gst_registration_type'],
  ['gstin', 'gstin'],
  ['isEcommerceOperator', 'is_ecommerce_operator'],
  ['bankAccountHolder', 'bank_account_holder'],
  ['bankAccountNo', 'bank_account_no'],
  ['bankIfsc', 'bank_ifsc'],
  ['bankName', 'bank_name'],
  ['bankBranch', 'bank_branch'],
  ['bankUpiId', 'bank_upi_id'],
  ['chequeBookEnabled', 'cheque_book_enabled'],
  ['taxType', 'tax_type'],
  ['gstDutyHead', 'gst_duty_head'],
  ['gstTaxDirection', 'gst_tax_direction'],
  ['gstApplicable', 'gst_applicable'],
  ['gstTaxability', 'gst_taxability'],
  ['gstRate', 'gst_rate'],
  ['cessRate', 'cess_rate'],
  ['hsnSac', 'hsn_sac'],
  ['gstSupplyType', 'gst_supply_type'],
  ['isReverseCharge', 'is_reverse_charge'],
  ['itcEligibility', 'itc_eligibility'],
  ['gstNatureOverride', 'gst_nature_override'],
  ['includeInAssessable', 'include_in_assessable'],
  ['appropriateBy', 'appropriate_by'],
  ['tdsApplicable', 'tds_applicable'],
  ['tdsSection', 'tds_section'],
  ['notes', 'notes'],
];

const BOOLEAN_FIELDS: ReadonlySet<keyof LedgerFields> = new Set<keyof LedgerFields>([
  'isActive',
  'billWise',
  'interestEnabled',
  'costCentresApplicable',
  'inventoryValuesAffected',
  'isEcommerceOperator',
  'chequeBookEnabled',
  'gstApplicable',
  'isReverseCharge',
  'tdsApplicable',
]);

export const BANK_FIELDS = [
  'bankAccountHolder',
  'bankAccountNo',
  'bankIfsc',
  'bankName',
  'bankBranch',
  'bankUpiId',
  'chequeBookEnabled',
] as const satisfies ReadonlyArray<keyof LedgerFields>;

export const TAX_FIELDS = ['taxType', 'gstDutyHead', 'gstTaxDirection'] as const satisfies ReadonlyArray<keyof LedgerFields>;

/** GST details of sales/purchase/income/expense/fixed-asset ledgers. */
export const GST_DETAIL_FIELDS = [
  'gstApplicable',
  'gstTaxability',
  'gstRate',
  'cessRate',
  'hsnSac',
  'gstSupplyType',
  'isReverseCharge',
  'itcEligibility',
  'gstNatureOverride',
  'includeInAssessable',
  'appropriateBy',
] as const satisfies ReadonlyArray<keyof LedgerFields>;

/** Rate fields cleared when GST is not applicable on the ledger. */
const GST_RATE_FIELDS = ['gstTaxability', 'gstRate', 'cessRate', 'hsnSac', 'gstSupplyType', 'isReverseCharge', 'itcEligibility'] as const;

export function fieldsFromRow(r: LedgerDbRow): LedgerFields {
  const out = {} as Record<keyof LedgerFields, unknown>;
  for (const [field, col] of LEDGER_COLUMNS) {
    const value = r[col];
    if (field === 'gstApplicable') out[field] = value === 'applicable';
    else if (BOOLEAN_FIELDS.has(field)) out[field] = value === 1;
    else out[field] = value;
  }
  return out as unknown as LedgerFields;
}

/** Column → bind value for INSERT/UPDATE. */
export function rowParams(f: LedgerFields): Record<string, BindValue> {
  const out: Record<string, BindValue> = {};
  for (const [field, col] of LEDGER_COLUMNS) {
    const value = f[field];
    out[col] = field === 'gstApplicable' ? (value ? 'applicable' : 'not_applicable') : (value as BindValue);
  }
  return out;
}

export function defaultLedgerFields(): LedgerFields {
  return {
    name: '',
    alias: null,
    groupId: 0,
    isActive: true,
    openingBalance: 0,
    currencyId: null,
    billWise: false,
    defaultCreditDays: null,
    creditLimit: null,
    interestEnabled: false,
    interestRate: null,
    costCentresApplicable: false,
    inventoryValuesAffected: false,
    mailingName: null,
    address: null,
    stateCode: null,
    country: 'India',
    pincode: null,
    contactPerson: null,
    phone: null,
    mobile: null,
    email: null,
    pan: null,
    registrationType: null,
    gstin: null,
    isEcommerceOperator: false,
    bankAccountHolder: null,
    bankAccountNo: null,
    bankIfsc: null,
    bankName: null,
    bankBranch: null,
    bankUpiId: null,
    chequeBookEnabled: false,
    taxType: null,
    gstDutyHead: null,
    gstTaxDirection: null,
    gstApplicable: false,
    gstTaxability: null,
    gstRate: null,
    cessRate: null,
    hsnSac: null,
    gstSupplyType: null,
    isReverseCharge: false,
    itcEligibility: null,
    gstNatureOverride: null,
    includeInAssessable: null,
    appropriateBy: null,
    tdsApplicable: false,
    tdsSection: null,
    notes: null,
  };
}

/**
 * Merge a save input over the current fields (or defaults on create). Omitted keys keep their value;
 * null clears (booleans → false, opening balance → 0). Returns the keys the caller set explicitly.
 */
export function mergeLedgerInput(input: LedgerSaveInput, base: LedgerFields): { fields: LedgerFields; provided: Set<keyof LedgerFields> } {
  const fields = { ...base } as Record<keyof LedgerFields, unknown>;
  const provided = new Set<keyof LedgerFields>();
  const src = input as Record<string, unknown>;
  for (const [field] of LEDGER_COLUMNS) {
    if (!Object.hasOwn(src, field)) continue;
    const value = src[field];
    if (value === undefined) continue;
    provided.add(field);
    if (value === null) {
      if (BOOLEAN_FIELDS.has(field)) fields[field] = false;
      else if (field === 'openingBalance') fields[field] = 0;
      else if (field === 'name') fields[field] = '';
      else if (field === 'groupId') fields[field] = 0;
      else fields[field] = null;
    } else {
      fields[field] = value;
    }
  }
  return { fields: fields as unknown as LedgerFields, provided };
}

// ───────────────────────────── Placement rules ─────────────────────────────

export const bankFieldsAllowed = (c: LedgerClass): boolean => c.isBank;
export const taxFieldsAllowed = (c: LedgerClass): boolean => c.isDutyTax;
/** GST rate details: sales/purchase/income/expense ledgers, plus fixed assets (capital goods). */
export const gstDetailsAllowed = (c: LedgerClass): boolean => c.isIncome || c.isExpense || c.primaryCode === 'FIXED_ASSETS';
/** Inward-only GST fields (ITC eligibility, reverse charge). */
const inwardSide = (c: LedgerClass): boolean => c.isExpense || c.primaryCode === 'FIXED_ASSETS';

const isSet = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== '';

export const MSG_BANK_PLACEMENT = 'Bank details can be entered only for ledgers under Bank Accounts or Bank OD A/c';
export const MSG_TAX_PLACEMENT = 'Tax type, GST duty head and tax direction can be set only for ledgers under Duties & Taxes';
export const MSG_GST_PLACEMENT =
  'GST rate details can be set only for sales, purchase, income, expense or fixed-asset ledgers';

/**
 * Fields of `f` that its group does not allow (bank fields outside bank groups, tax fields outside
 * Duties & Taxes, GST rate details outside income/expense/fixed assets), with the reason.
 */
export function misplacedFields(f: LedgerFields, c: LedgerClass): Array<{ field: keyof LedgerFields; message: string }> {
  const out: Array<{ field: keyof LedgerFields; message: string }> = [];
  if (!bankFieldsAllowed(c)) for (const k of BANK_FIELDS) if (isSet(f[k])) out.push({ field: k, message: MSG_BANK_PLACEMENT });
  if (!taxFieldsAllowed(c)) for (const k of TAX_FIELDS) if (isSet(f[k])) out.push({ field: k, message: MSG_TAX_PLACEMENT });
  if (!gstDetailsAllowed(c)) for (const k of GST_DETAIL_FIELDS) if (isSet(f[k])) out.push({ field: k, message: MSG_GST_PLACEMENT });
  return out;
}

// ───────────────────────────── Validation ─────────────────────────────

export const REGISTRATION_LABELS: Readonly<Record<RegistrationType, string>> = {
  regular: 'Regular',
  composition: 'Composition',
  unregistered: 'Unregistered',
  consumer: 'Consumer',
  sez: 'SEZ',
  overseas: 'Overseas',
  deemed_export: 'Deemed Export',
  uin: 'UIN holder (UN body / embassy)',
};

/** Deemed-export recipients (EOU, advance-authorisation holders …) are registered: GSTR-1 table 6C needs their GSTIN. */
const NEEDS_GSTIN: ReadonlySet<RegistrationType> = new Set<RegistrationType>(['regular', 'composition', 'sez', 'uin', 'deemed_export']);
const NO_GSTIN: ReadonlySet<RegistrationType> = new Set<RegistrationType>(['consumer', 'unregistered']);

const stateText = (code: string): string => {
  const name = stateName(code);
  return name ? `${name} (${code})` : code;
};

export interface LedgerRuleContext {
  db: Db;
  /** null when creating. */
  id: number | null;
  /** Current values (alter) — null on create. */
  existing: LedgerFields | null;
  reservedCode: LedgerCode | null;
  tree: GroupTree;
  provided: ReadonlySet<keyof LedgerFields>;
  companyStateCode: string | null;
  booksFrom: string;
  allowNonStandardRate: boolean;
  /** Opening bills came with this save (false: the stored bills are being re-checked). */
  billsProvided: boolean;
  /**
   * Inventory is integrated with accounts (F11 inventory + integrateInventory): opening stock then comes
   * from the stock items, so Stock-in-Hand ledgers take no opening balance.
   */
  integratedInventory?: boolean;
}

/**
 * Normalise `f` in place (trim, upper-case codes, auto-fill state/PAN from the GSTIN, clear fields the
 * group does not allow when the caller did not set them) and add every rule violation to `issues`.
 * `bills` are normalised in place too.
 */
export function validateLedger(f: LedgerFields, bills: OpeningBillInput[], rc: LedgerRuleContext, issues: Issues): void {
  // ── Text normalisation ──
  f.name = (f.name ?? '').trim();
  f.alias = cleanText(f.alias);
  for (const k of ['mailingName', 'address', 'country', 'contactPerson', 'phone', 'bankAccountHolder', 'bankName', 'bankBranch', 'tdsSection', 'notes', 'email', 'bankUpiId'] as const) {
    f[k] = cleanText(f[k]);
  }
  f.pan = cleanCode(f.pan);
  f.gstin = cleanCode(f.gstin);
  f.bankIfsc = cleanCode(f.bankIfsc);
  f.bankAccountNo = cleanCode(f.bankAccountNo);
  f.hsnSac = cleanText(f.hsnSac)?.replace(/\s+/g, '') ?? null;
  f.pincode = cleanText(f.pincode)?.replace(/\s+/g, '') ?? null;
  f.mobile = cleanText(f.mobile);
  const rawState = cleanText(f.stateCode);
  f.stateCode = rawState === null ? null : normalizeStateCode(rawState) || rawState;

  // ── Name & alias ──
  if (f.name === '') issues.add('name', 'Ledger name is required');
  if (f.alias !== null && f.alias.toLowerCase() === f.name.toLowerCase()) f.alias = null;

  // ── Group ──
  const group = f.groupId ? rc.tree.byId.get(f.groupId) : undefined;
  if (!group) {
    issues.add('groupId', f.groupId ? 'The selected group does not exist' : 'Choose the group this ledger belongs to');
    return; // every other rule depends on the group
  }
  const cls = group.cls;

  // ── Reserved ledgers ──
  if (rc.reservedCode && rc.existing) {
    const ex = rc.existing;
    if (f.groupId !== ex.groupId) {
      const exGroup = rc.tree.byId.get(ex.groupId);
      issues.add('groupId', `'${ex.name}' is a reserved ledger and must stay under ${exGroup ? exGroup.name : 'its group'}`);
    }
    if (!f.isActive) issues.add('isActive', `'${ex.name}' is a reserved ledger and cannot be made inactive`);
    if (ex.taxType !== null || ex.gstDutyHead !== null) {
      for (const k of TAX_FIELDS) {
        if (f[k] !== ex[k]) {
          if (rc.provided.has(k)) issues.add(k, `The tax settings of the reserved ledger '${ex.name}' cannot be changed`);
          (f as unknown as Record<string, unknown>)[k] = ex[k];
        }
      }
    }
  }

  // ── Field placement by group ──
  // A value the caller entered (new, or changed) is reported; a value merely carried over from the
  // stored ledger (e.g. bank details after moving it out of Bank Accounts) is cleared.
  for (const m of misplacedFields(f, cls)) {
    if (rc.provided.has(m.field) && (!rc.existing || rc.existing[m.field] !== f[m.field])) {
      issues.add(m.field, m.message);
    } else {
      (f as unknown as Record<string, unknown>)[m.field] = BOOLEAN_FIELDS.has(m.field) ? false : null;
    }
  }

  // ── Opening stock with integrated inventory (Tally: the Stock-in-Hand opening is computed from items) ──
  if (rc.integratedInventory && group.codes.has('STOCK_IN_HAND') && f.openingBalance !== 0) {
    const entered = !rc.existing || rc.existing.openingBalance !== f.openingBalance || rc.existing.groupId !== f.groupId;
    if (entered) {
      issues.add(
        'openingBalance',
        'Inventory is integrated with accounts (F11), so the opening stock is the total of the stock items\' opening values. ' +
          'Enter opening quantities and rates in the stock items instead of an opening balance on this Stock-in-Hand ledger.',
      );
    }
  }

  validateParty(f, cls, rc, issues);
  validateIdentifiers(f, issues);
  if (taxFieldsAllowed(cls)) validateTaxFields(f, issues);
  if (gstDetailsAllowed(cls)) validateGstDetails(f, cls, rc, issues);
  validateCredit(f, issues);
  validateBills(f, bills, rc, issues);

  if (f.currencyId !== null && rc.db.value('SELECT 1 FROM currencies WHERE id = :id', { id: f.currencyId }) === undefined) {
    issues.add('currencyId', 'The selected currency does not exist');
  }
  checkLedgerNames(rc.db, f.name, f.alias, rc.id, issues, rc.existing);
}

function validateParty(f: LedgerFields, cls: LedgerClass, rc: LedgerRuleContext, issues: Issues): void {
  let gst = f.gstin ? validateGstin(f.gstin) : null;
  if (gst && !gst.valid) {
    issues.add('gstin', `${gst.error ?? 'GSTIN is invalid'}. Check the GSTIN printed on the party's invoice or registration certificate.`);
    gst = null;
  }
  if (gst?.gstin) f.gstin = gst.gstin;

  // A GSTIN entered now (new or changed) re-derives what was only carried over from the stored ledger:
  // state and PAN (unless entered together with it), and an 'unregistered'/'consumer' type.
  const gstinChanged = rc.provided.has('gstin') && f.gstin !== null && (rc.existing === null || rc.existing.gstin !== f.gstin);
  if (gstinChanged && gst?.valid && rc.existing) {
    if (!rc.provided.has('stateCode')) f.stateCode = null;
    if (!rc.provided.has('pan')) f.pan = null;
    if (!rc.provided.has('registrationType') && f.registrationType !== null && NO_GSTIN.has(f.registrationType)) f.registrationType = null;
  }
  // Removing the GSTIN of a 'regular' party (the type a GSTIN implies) makes it unregistered again, unless
  // a type was chosen in the same save. SEZ / composition / UIN parties still need a GSTIN (error below).
  if (rc.existing?.gstin && f.gstin === null && rc.provided.has('gstin') && !rc.provided.has('registrationType') && f.registrationType === 'regular') {
    f.registrationType = null;
  }

  if (f.registrationType === null) {
    if (f.gstin) f.registrationType = gst?.kind === 'uin' ? 'uin' : 'regular';
    else if (cls.isParty) f.registrationType = 'unregistered';
  }
  const reg = f.registrationType;
  const label = reg ? REGISTRATION_LABELS[reg] : '';

  if (reg && NEEDS_GSTIN.has(reg) && !f.gstin && !issues.has('gstin')) {
    issues.add('gstin', `A GSTIN is required for a ${label} party. Enter the party's GSTIN, or change the registration type to Unregistered or Consumer.`);
  }
  if (reg && NO_GSTIN.has(reg) && f.gstin) {
    issues.add('gstin', `An ${label.toLowerCase()} party cannot have a GSTIN. Remove the GSTIN, or change the registration type to Regular.`);
  }
  if (reg === 'overseas') {
    if (f.gstin) issues.add('gstin', 'Overseas parties do not have a GSTIN. Remove it, or choose the registration type the party holds in India.');
    if (f.stateCode === null) f.stateCode = '96';
    else if (f.stateCode !== '96') issues.add('stateCode', "The state of an overseas party must be '96 - Other Countries' (or left blank)");
  } else if (f.stateCode === '96') {
    issues.add('stateCode', "State 96 (Other Countries) is only for overseas parties. Set the registration type to Overseas or choose an Indian state.");
  }
  if (gst?.valid) {
    if (reg === 'uin' && gst.kind !== 'uin') issues.add('gstin', 'A UIN holder needs a UIN (e.g. 0717UNO00157UN5), not a regular GSTIN. Change the registration type to Regular if this is a GSTIN.');
    if (gst.kind === 'uin' && reg !== 'uin') issues.add('registrationType', 'This number is a UIN (UN body / embassy). Set the registration type to UIN holder.');
  }

  if (f.stateCode !== null && f.stateCode !== '96' && !isKnownStateCode(f.stateCode)) {
    issues.add('stateCode', `'${f.stateCode}' is not a GST state code. Choose the state from the list.`);
  }

  // GSTIN ↔ state / PAN consistency, with auto-fill.
  if (gst?.valid && gst.stateCode && reg !== 'overseas') {
    if (f.stateCode === null) f.stateCode = gst.stateCode;
    else if (f.stateCode !== gst.stateCode && isKnownStateCode(f.stateCode)) {
      issues.add(
        'gstin',
        `GSTIN ${gst.gstin} is registered in ${stateText(gst.stateCode)}, but the ledger's state is ${stateText(f.stateCode)}. Correct the GSTIN or the state.`,
      );
    }
    if (gst.pan) {
      if (f.pan === null) f.pan = gst.pan;
      else if (normalizePan(f.pan) !== gst.pan) issues.add('pan', `PAN ${f.pan} does not match the PAN inside the GSTIN (${gst.pan}). Correct the PAN or the GSTIN.`);
    }
  }

  // New party ledgers default to the company's state (as in Tally).
  if (rc.id === null && cls.isParty && f.stateCode === null && reg !== 'overseas' && rc.companyStateCode && getState(rc.companyStateCode)) {
    f.stateCode = rc.companyStateCode;
  }
}

function validateIdentifiers(f: LedgerFields, issues: Issues): void {
  if (f.pan !== null && !issues.has('pan')) {
    const e = validatePan(f.pan);
    if (e) issues.add('pan', e);
    else f.pan = normalizePan(f.pan);
  }
  // PIN codes are Indian; an overseas party's postal code (ZIP, postcode …) is not checked.
  const inIndia = (f.country === null || f.country.toLowerCase() === 'india') && f.registrationType !== 'overseas';
  if (f.pincode !== null && inIndia) {
    const e = validatePincode(f.pincode);
    if (e) issues.add('pincode', e);
  }
  if (f.email !== null) {
    const e = validateEmail(f.email);
    if (e) issues.add('email', e);
  }
  if (f.mobile !== null) {
    const e = validateMobile(f.mobile);
    if (e) issues.add('mobile', e);
    else f.mobile = normalizeMobile(f.mobile);
  }
  if (f.bankIfsc !== null) {
    const e = validateIfsc(f.bankIfsc);
    if (e) issues.add('bankIfsc', e);
    else f.bankIfsc = normalizeIfsc(f.bankIfsc);
  }
  if (f.bankAccountNo !== null) {
    const e = validateBankAccountNo(f.bankAccountNo);
    if (e) issues.add('bankAccountNo', e);
  }
  if (f.bankUpiId !== null) {
    const e = validateUpiId(f.bankUpiId);
    if (e) issues.add('bankUpiId', e);
  }
}

function validateTaxFields(f: LedgerFields, issues: Issues): void {
  if (f.taxType === null && (f.gstDutyHead !== null || f.gstTaxDirection !== null)) f.taxType = 'GST';
  if (f.taxType !== 'GST') {
    if (f.gstDutyHead !== null) issues.add('gstDutyHead', 'A GST duty head applies only to GST tax ledgers (tax type GST)');
    if (f.gstTaxDirection !== null) issues.add('gstTaxDirection', 'A tax direction applies only to GST tax ledgers (tax type GST)');
  } else if (f.gstDutyHead === null) {
    issues.add('gstDutyHead', 'Choose the GST duty head of this tax ledger: IGST, CGST, SGST/UTGST or Cess');
  }
}

function validateGstDetails(f: LedgerFields, cls: LedgerClass, rc: LedgerRuleContext, issues: Issues): void {
  if (!f.gstApplicable) {
    for (const k of GST_RATE_FIELDS) (f as unknown as Record<string, unknown>)[k] = k === 'isReverseCharge' ? false : null;
    return;
  }
  if (f.gstTaxability === null) f.gstTaxability = 'taxable';
  if (f.gstTaxability !== 'taxable') {
    if (f.gstRate !== null && f.gstRate !== 0) {
      issues.add('gstRate', `A ${f.gstTaxability.replace('_', '-')} ledger has no GST rate. Clear the rate or set the taxability to Taxable.`);
    } else if (f.gstRate !== null) f.gstRate = 0;
    if (f.cessRate !== null && f.cessRate !== 0) issues.add('cessRate', 'Cess applies only to taxable supplies. Clear the cess rate or set the taxability to Taxable.');
  }
  if (f.gstRate !== null && !issues.has('gstRate')) {
    if (!isValidRate(f.gstRate)) issues.add('gstRate', 'GST rate must be between 0 and 100%');
    else if (!isStandardRate(f.gstRate) && !rc.allowNonStandardRate) {
      issues.add(
        'gstRate',
        `${f.gstRate}% is not a GST rate slab (${GST_RATES.join(', ')}%). Choose a slab, or allow a non-standard rate if a notification prescribes it.`,
      );
    }
  }
  if (f.cessRate !== null && !issues.has('cessRate') && !isValidCessRate(f.cessRate)) issues.add('cessRate', 'Cess rate must be between 0 and 400%');
  if (f.hsnSac !== null) {
    if (f.gstSupplyType === null) f.gstSupplyType = isSacCode(f.hsnSac) ? 'services' : 'goods';
    const e = validateHsnSac(f.hsnSac, f.gstSupplyType);
    if (e) issues.add('hsnSac', e);
  }
  if (!inwardSide(cls)) {
    if (f.itcEligibility !== null) issues.add('itcEligibility', 'Input tax credit eligibility applies only to purchase, expense and fixed-asset ledgers');
    if (f.isReverseCharge) issues.add('isReverseCharge', 'Reverse charge applies only to purchase, expense and fixed-asset ledgers');
  }
}

function validateCredit(f: LedgerFields, issues: Issues): void {
  if (f.creditLimit !== null && f.creditLimit < 0) issues.add('creditLimit', 'Credit limit cannot be negative');
  if (f.defaultCreditDays !== null && (f.defaultCreditDays < 0 || f.defaultCreditDays > 3650))
    issues.add('defaultCreditDays', 'Credit period must be between 0 and 3650 days');
  if (f.interestRate !== null && (f.interestRate < 0 || f.interestRate > 100)) issues.add('interestRate', 'Interest rate must be between 0 and 100% per annum');
  if (f.interestEnabled && f.interestRate === null) issues.add('interestRate', 'Enter the interest rate (% per annum), or turn off interest calculation');
}

function validateBills(f: LedgerFields, bills: OpeningBillInput[], rc: LedgerRuleContext, issues: Issues): void {
  if (bills.length === 0) return;
  if (!f.billWise) {
    if (rc.billsProvided) issues.add('openingBills', 'Turn on bill-wise details for this ledger to enter opening bills');
    else issues.add('billWise', `This ledger has ${bills.length === 1 ? '1 opening bill' : `${bills.length} opening bills`}. Remove them before turning off bill-wise details.`);
    return;
  }
  const seen = new Set<string>();
  let sum = 0;
  bills.forEach((b, i) => {
    const p = `openingBills[${i}]`;
    b.billName = (b.billName ?? '').trim();
    b.dueDate = b.dueDate ?? null;
    if (b.billName === '') issues.add(`${p}.billName`, 'Bill reference is required');
    else if (seen.has(b.billName.toLowerCase())) issues.add(`${p}.billName`, `Bill '${b.billName}' is entered twice`);
    seen.add(b.billName.toLowerCase());
    if (b.billDate > rc.booksFrom) {
      issues.add(
        `${p}.billDate`,
        `Opening bills are bills outstanding when the books begin (${formatDate(rc.booksFrom)}); bill '${b.billName}' is dated ${formatDate(b.billDate)}`,
      );
    }
    if (b.dueDate !== null && b.dueDate < b.billDate) issues.add(`${p}.dueDate`, `Due date of bill '${b.billName}' is before its bill date`);
    if (b.amount === 0) issues.add(`${p}.amount`, `Enter the outstanding amount of bill '${b.billName}'`);
    sum += b.amount;
  });
  if (sum !== f.openingBalance) {
    const show = (p: number): string => (p === 0 ? '0.00' : formatDrCr(p));
    issues.add(
      'openingBills',
      `Opening bills add up to ₹ ${show(sum)} but the opening balance is ₹ ${show(f.openingBalance)} (difference ₹ ${show(f.openingBalance - sum)}). ` +
        'Adjust the bills or the opening balance so that they match (or remove all the bills to keep the whole opening balance on account).',
    );
  }
}

/** Name/alias must be unique among ledgers, and neither may equal another ledger's name or alias. */
export function checkLedgerNames(
  db: Db,
  name: string,
  alias: string | null,
  excludeId: number | null,
  issues: Issues,
  existing: Pick<LedgerFields, 'name' | 'alias'> | null = null,
): void {
  const clash = (value: string): { name: string; alias: string | null } | undefined =>
    db.get<{ name: string; alias: string | null }>(
      `SELECT name, alias FROM ledgers WHERE (name = :v OR alias = :v COLLATE NOCASE) AND id <> :ex LIMIT 1`,
      { v: value, ex: excludeId ?? 0 },
    );
  if (name !== '') {
    const c = clash(name);
    if (c) {
      issues.add(
        'name',
        c.name.toLowerCase() === name.toLowerCase()
          ? `A ledger named '${c.name}' already exists. Use a different name (e.g. add the city).`
          : `'${name}' is already the alias of ledger '${c.name}'. Use a different name.`,
      );
    }
  }
  if (alias !== null) {
    const c = clash(alias);
    if (c) {
      issues.add(
        'alias',
        c.name.toLowerCase() === alias.toLowerCase()
          ? `Alias '${alias}' is the name of another ledger. Choose a different alias.`
          : `Alias '${alias}' is already used by ledger '${c.name}'. Choose a different alias.`,
      );
    }
  }
  // Ledgers and groups share one name space (as in Tally): a ledger may not take a group's name or alias.
  // Checked for new or changed values only, so an old clash does not block unrelated edits.
  const same = (a: string | null | undefined, b: string | null): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
  for (const [path, value] of [['name', name], ['alias', alias]] as const) {
    if (!value || issues.has(path)) continue;
    if (existing && (same(existing.name, value) || same(existing.alias, value))) continue;
    const g = groupNameClash(db, value);
    if (g) issues.add(path, `'${value}' is already ${g.name.toLowerCase() === value.toLowerCase() ? 'the name' : 'an alias'} of the group '${g.name}'. Ledgers and groups need different names: choose another ${path}.`);
  }
}

/** A group whose name or alias equals `value` (case-insensitive). */
export function groupNameClash(db: Db, value: string): { name: string } | undefined {
  return db.get<{ name: string }>('SELECT name FROM groups WHERE name = :v OR alias = :v COLLATE NOCASE LIMIT 1', { v: value });
}

/** A ledger whose name or alias equals `value` (case-insensitive). */
export function ledgerNameClash(db: Db, value: string): { name: string } | undefined {
  return db.get<{ name: string }>('SELECT name FROM ledgers WHERE name = :v OR alias = :v COLLATE NOCASE LIMIT 1', { v: value });
}

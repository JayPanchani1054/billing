/**
 * Ledger form 2.1 (SPEC-21 §1.8, D23): which fields are Essentials — always on screen — and which sit
 * behind the "More details" line (Ctrl+I, Alt+F1), grouped under small section titles, and when that
 * line must open by itself. Pure — tested in ledgerEssentials.test.ts.
 *
 *   every ledger ........ Name, Under, Opening balance (+ the opening bills grid when bill-wise)
 *   customer / supplier . + GSTIN, PAN, State, Address, Mobile
 *   bank ................ + Account number, IFSC
 *   tax ledger .......... + Type of duty / tax (+ GST duty head and Used for when GST)
 *   sales / purchase .... + GST rate, HSN / SAC (+ "These GST details apply from" when a rate is replaced)
 *
 * Auto-reveal (ui/lib/disclosure.ts `shouldReveal`): More details opens by itself when any field inside
 * holds an error, or a value other than the usual one for the ledger's group (the defaults a new ledger of
 * that group starts with) — so an Alteration never hides data, and a new ledger never opens it merely
 * because of the group's defaults. A switch counts when it differs from its default ("Active" off).
 */
import type { LedgerClass } from '../../../../shared/types/accounts.ts';
import { revealingFields, shouldReveal } from '../../../ui/lib/disclosure.ts';
import type { FieldMap } from '../../../ui/lib/disclosure.ts';
import type { LedgerDraft } from './ledgerDraft.ts';
import type { LedgerSections } from './ledgerSections.ts';

/** A field of the ledger form = a key of the draft (the error keys of the form use the same names). */
export type LedgerField = keyof LedgerDraft;

/** The ui-preference key the form remembers its "More details" state under (`moreDetails`). */
export const LEDGER_FORM_KIND = 'ledger';

/** Sales and purchase ledgers carry their GST rate and HSN in the Essentials; other ledgers in More details. */
function tradingGst(cls: LedgerClass | null, s: LedgerSections): boolean {
  return s.gstDetails && cls !== null && (cls.isSales || cls.isPurchase);
}

/** The Essentials of this ledger, in screen order. */
export function essentialFields(cls: LedgerClass | null, s: LedgerSections, d: Pick<LedgerDraft, 'registrationType' | 'taxType'>): LedgerField[] {
  const out: LedgerField[] = ['name', 'groupId'];
  if (s.party) {
    if (d.registrationType !== 'overseas') out.push('gstin');
    out.push('pan', 'stateCode', 'address', 'mobile');
  }
  if (s.bank) out.push('bankAccountNo', 'bankIfsc');
  if (s.tax) {
    out.push('taxType');
    if (d.taxType === 'GST') out.push('gstDutyHead', 'gstTaxDirection');
  }
  if (tradingGst(cls, s)) out.push('gstRate', 'hsnSac', 'applicableFrom');
  out.push('openingBalance');
  if (s.billWise) out.push('openingBills');
  return out;
}

export interface MoreDetailsGroup {
  /** Section title inside More details (14/600). */
  title: string;
  /** Words for the closed line's summary ("aliases, contact, credit limit …"). */
  summary: string;
  fields: LedgerField[];
}

/** What sits behind "More details", by section (empty sections left out). */
export function moreDetailGroups(cls: LedgerClass | null, s: LedgerSections): MoreDetailsGroup[] {
  const groups: MoreDetailsGroup[] = [];
  const add = (title: string, summary: string, fields: LedgerField[]) => {
    if (fields.length > 0) groups.push({ title, summary, fields });
  };
  add('General', 'aliases', ['alias', 'moreAliases', 'isActive', ...(s.currency ? (['currencyId'] as LedgerField[]) : []), 'notes']);
  const credit: LedgerField[] = [];
  if (s.billWise) credit.push('billWise');
  if (s.party) credit.push('defaultCreditDays', 'creditLimit');
  if (s.interest) credit.push('interestEnabled', 'interestRate');
  add('Bills and credit', s.party ? 'credit limit' : 'bills', credit);
  if (s.party) {
    add('Contact', 'contact', ['mailingName', 'contactPerson', 'pincode', 'country', 'phone', 'email']);
    add('GST registration', 'registration type', ['registrationType', 'isEcommerceOperator']);
  }
  if (s.bank) add('Bank details', 'branch, UPI', ['bankAccountHolder', 'bankName', 'bankBranch', 'bankUpiId', 'chequeBookEnabled']);
  if (s.gstDetails) {
    const gst: LedgerField[] = ['gstApplicable', 'gstTaxability'];
    if (!tradingGst(cls, s)) gst.push('gstRate', 'hsnSac', 'applicableFrom');
    gst.push('cessRate', 'gstSupplyType');
    if (s.gstInward) gst.push('isReverseCharge', 'itcEligibility');
    if (s.gstCharges) gst.push('includeInAssessable', 'appropriateBy');
    add('GST details', 'GST', gst);
  }
  const other: LedgerField[] = [];
  if (s.costCentres) other.push('costCentresApplicable');
  if (s.inventoryValues) other.push('inventoryValuesAffected');
  if (s.tds) other.push('tdsApplicable', 'tdsSection');
  add('Other settings', s.tds ? 'TDS' : s.costCentres ? 'cost centres' : 'inventory', other);
  return groups;
}

/** Every field behind "More details". */
export function moreDetailFields(cls: LedgerClass | null, s: LedgerSections): LedgerField[] {
  return moreDetailGroups(cls, s).flatMap((g) => g.fields);
}

/** The closed line's summary: "aliases, credit limit, contact, registration type …". */
export function moreDetailsSummary(groups: readonly MoreDetailsGroup[]): string {
  const words = groups.map((g) => g.summary);
  return words.length > 4 ? `${words.slice(0, 4).join(', ')} …` : words.join(', ');
}

/**
 * The registration type a party gets by itself (a valid GSTIN → Regular, none → Unregistered or not set):
 * not "data" — anything else (composition, consumer, SEZ, overseas …) is.
 */
function automaticRegistration(d: Pick<LedgerDraft, 'gstin' | 'registrationType'>): boolean {
  const r = d.registrationType;
  if (r === '') return true;
  return d.gstin.trim() !== '' ? r === 'regular' : r === 'unregistered';
}

/**
 * The draft as the reveal rule reads it, against the group's `defaults`: a switch counts as a value when it
 * differs from its default (an inactive ledger, bill-wise turned off, GST applicable turned on); an automatic
 * registration type counts as empty; a GST rate of 0 % is a value (unlike "not set").
 */
export function revealValues(d: LedgerDraft, defaults: LedgerDraft): FieldMap {
  const out: Record<string, unknown> = { ...d, registrationType: automaticRegistration(d) ? '' : d.registrationType, gstRate: d.gstRate === null ? null : String(d.gstRate) };
  for (const k of Object.keys(d) as LedgerField[]) {
    const v = d[k];
    if (typeof v === 'boolean') out[k] = v !== defaults[k];
  }
  return out;
}

/** Error keys of the form (`openingBills[2].amount`, `aliases[0]`, `numbering.x`) → the field they belong to. */
export function errorFields(errors: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, msg] of Object.entries(errors)) {
    if (!msg) continue;
    const head = k.split(/[.[]/)[0];
    const field = head === 'aliases' ? 'moreAliases' : head;
    if (!(field in out)) out[field] = msg;
  }
  return out;
}

/**
 * True when "More details" must be open whatever the user chose: a field inside has an error, or a value
 * other than `defaults` (the class defaults of the ledger's group, see `classDefaults` in the screen).
 */
export function moreDetailsRevealed(cls: LedgerClass | null, s: LedgerSections, d: LedgerDraft, errors: Readonly<Record<string, string>>, defaults: LedgerDraft): boolean {
  return shouldReveal(moreDetailFields(cls, s), revealValues(d, defaults), errorFields(errors), { defaults: revealValues(defaults, defaults) });
}

/** The fields that keep More details open (for tests and the line's tooltip). */
export function revealingMoreDetails(cls: LedgerClass | null, s: LedgerSections, d: LedgerDraft, errors: Readonly<Record<string, string>>, defaults: LedgerDraft): string[] {
  return revealingFields(moreDetailFields(cls, s), revealValues(d, defaults), errorFields(errors), { defaults: revealValues(defaults, defaults) });
}

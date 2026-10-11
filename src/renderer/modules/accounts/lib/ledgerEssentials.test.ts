import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classOfGroup, indexGroups } from './groupClass.ts';
import { applyGroupDefaults, emptyLedgerDraft } from './ledgerDraft.ts';
import type { LedgerDraft } from './ledgerDraft.ts';
import {
  errorFields,
  essentialFields,
  LEDGER_FORM_KIND,
  moreDetailFields,
  moreDetailGroups,
  moreDetailsRevealed,
  moreDetailsSummary,
  revealingMoreDetails,
} from './ledgerEssentials.ts';
import { ledgerSections } from './ledgerSections.ts';
import type { SectionContext } from './ledgerSections.ts';
import { groupIdOf, predefinedTestGroups } from './testGroups.ts';

const groups = predefinedTestGroups();
const index = indexGroups(groups);
type Code = Parameters<typeof groupIdOf>[1];
const cls = (code: Code) => classOfGroup(index, groupIdOf(groups, code));
const CTX: SectionContext = {
  features: { billWise: true, interest: false, costCentres: false, inventory: true, integrateInventory: false, tds: false, multiCurrency: false, gst: true },
};
const sectionsOf = (code: Code, ctx: SectionContext = CTX) => ledgerSections(cls(code), ctx);
const DEFAULTS_CTX = { features: { billWise: true, inventory: true, gst: true }, gstEnabled: true, companyStateCode: '27' };

/** A new ledger of the group with the usual defaults (what the form starts with). */
function fresh(code: Code, patch: Partial<LedgerDraft> = {}): LedgerDraft {
  const id = groupIdOf(groups, code);
  return { ...applyGroupDefaults(emptyLedgerDraft('Sharma Traders', id), null, cls(code), DEFAULTS_CTX), ...patch };
}
const defaultsOf = (code: Code) => fresh(code, { name: '' });

describe('Essentials per kind of ledger (SPEC-21 §1.8)', () => {
  it('customer: Name, Under, GSTIN, PAN, State, Address, Mobile, Opening balance (+ bills grid)', () => {
    const d = fresh('SUNDRY_DEBTORS');
    assert.deepEqual(essentialFields(cls('SUNDRY_DEBTORS'), sectionsOf('SUNDRY_DEBTORS'), d), ['name', 'groupId', 'gstin', 'pan', 'stateCode', 'address', 'mobile', 'openingBalance', 'openingBills']);
    // A supplier is the same; an overseas party has no GSTIN field.
    assert.deepEqual(essentialFields(cls('SUNDRY_CREDITORS'), sectionsOf('SUNDRY_CREDITORS'), { ...d, registrationType: 'overseas' }).slice(0, 4), ['name', 'groupId', 'pan', 'stateCode']);
  });

  it('bank: + account number and IFSC; expense: only Name, Under, Opening balance', () => {
    assert.deepEqual(essentialFields(cls('BANK_ACCOUNTS'), sectionsOf('BANK_ACCOUNTS'), fresh('BANK_ACCOUNTS')), ['name', 'groupId', 'bankAccountNo', 'bankIfsc', 'openingBalance']);
    assert.deepEqual(essentialFields(cls('INDIRECT_EXPENSES'), sectionsOf('INDIRECT_EXPENSES'), fresh('INDIRECT_EXPENSES')), ['name', 'groupId', 'openingBalance']);
  });

  it('tax ledger: type of duty, and the GST duty head and direction once the type is GST', () => {
    const s = sectionsOf('DUTIES_TAXES');
    assert.deepEqual(essentialFields(cls('DUTIES_TAXES'), s, fresh('DUTIES_TAXES')), ['name', 'groupId', 'taxType', 'openingBalance']);
    assert.deepEqual(essentialFields(cls('DUTIES_TAXES'), s, fresh('DUTIES_TAXES', { taxType: 'GST' })), ['name', 'groupId', 'taxType', 'gstDutyHead', 'gstTaxDirection', 'openingBalance']);
  });

  it('sales / purchase: the GST rate and HSN are Essentials; for other income / expense ledgers they are in More details', () => {
    for (const code of ['SALES_ACCOUNTS', 'PURCHASE_ACCOUNTS'] as const) {
      const e = essentialFields(cls(code), sectionsOf(code), fresh(code));
      assert.deepEqual(e, ['name', 'groupId', 'gstRate', 'hsnSac', 'applicableFrom', 'openingBalance'], code);
      assert.ok(!moreDetailFields(cls(code), sectionsOf(code)).includes('gstRate'), code);
    }
    assert.ok(moreDetailFields(cls('INDIRECT_EXPENSES'), sectionsOf('INDIRECT_EXPENSES')).includes('gstRate'));
    // Without company GST there are no GST fields at all.
    const noGst: SectionContext = { ...CTX, gstEnabled: false };
    assert.ok(!essentialFields(cls('SALES_ACCOUNTS'), sectionsOf('SALES_ACCOUNTS', noGst), fresh('SALES_ACCOUNTS')).includes('gstRate'));
  });

  it('no field is both an Essential and in More details, and every group of More details has fields', () => {
    for (const code of ['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS', 'BANK_ACCOUNTS', 'BANK_OD', 'CASH_IN_HAND', 'DUTIES_TAXES', 'SALES_ACCOUNTS', 'PURCHASE_ACCOUNTS', 'INDIRECT_EXPENSES', 'DIRECT_INCOMES', 'FIXED_ASSETS', 'CAPITAL_ACCOUNT'] as const) {
      const s = sectionsOf(code, { features: { ...CTX.features, interest: true, costCentres: true, tds: true, multiCurrency: true } });
      const e = new Set(essentialFields(cls(code), s, fresh(code, { taxType: 'GST' })));
      const more = moreDetailFields(cls(code), s);
      assert.deepEqual(more.filter((f) => e.has(f)), [], code);
      assert.equal(new Set(more).size, more.length, `${code}: a field listed twice`);
      for (const g of moreDetailGroups(cls(code), s)) assert.ok(g.fields.length > 0 && g.title && g.summary, code);
    }
  });

  it('the closed line names what is inside, at most four words then …', () => {
    const s = sectionsOf('SUNDRY_DEBTORS');
    assert.equal(moreDetailsSummary(moreDetailGroups(cls('SUNDRY_DEBTORS'), s)), 'aliases, credit limit, contact, registration type');
    const all = sectionsOf('SUNDRY_DEBTORS', { features: { ...CTX.features, tds: true } });
    assert.match(moreDetailsSummary(moreDetailGroups(cls('SUNDRY_DEBTORS'), all)), / …$/);
    assert.equal(moreDetailsSummary(moreDetailGroups(cls('CASH_IN_HAND'), sectionsOf('CASH_IN_HAND'))), 'aliases');
  });

  it('the open state is remembered under the form kind "ledger"', () => {
    assert.equal(LEDGER_FORM_KIND, 'ledger');
  });
});

describe('More details reveals itself (value or error inside — R11)', () => {
  const party = (patch: Partial<LedgerDraft> = {}) => fresh('SUNDRY_DEBTORS', patch);
  const reveal = (d: LedgerDraft, errors: Record<string, string> = {}, code: Code = 'SUNDRY_DEBTORS') =>
    moreDetailsRevealed(cls(code), sectionsOf(code), d, errors, defaultsOf(code));

  it('a new ledger with only the group defaults stays collapsed (bill-wise on, state, country India)', () => {
    assert.equal(reveal(party()), false);
    assert.equal(reveal(party({ gstin: '27AAAPA0002A1Z5', pan: 'AAAPA0002A', registrationType: 'regular', address: 'Pune', mobile: '9876543210', openingBalance: 5000 })), false);
    assert.equal(reveal(fresh('SALES_ACCOUNTS'), {}, 'SALES_ACCOUNTS'), false, 'GST applicable + taxable + inventory are the defaults');
  });

  it('a value in a hidden field opens it: credit limit, contact, alias, an inactive ledger, a composition dealer', () => {
    assert.deepEqual(revealingMoreDetails(cls('SUNDRY_DEBTORS'), sectionsOf('SUNDRY_DEBTORS'), party({ creditLimit: 1_00_000_00 }), {}, defaultsOf('SUNDRY_DEBTORS')), ['creditLimit']);
    assert.equal(reveal(party({ email: 'a@b.in' })), true);
    assert.equal(reveal(party({ alias: 'ST' })), true);
    assert.equal(reveal(party({ isActive: false })), true);
    assert.equal(reveal(party({ registrationType: 'composition' })), true);
    assert.equal(reveal(party({ billWise: false })), true, 'bill-wise turned off differs from the group default');
    assert.equal(reveal(party({ country: 'Nepal' })), true);
  });

  it('the automatic registration type is not data: Regular with a GSTIN, Unregistered without', () => {
    assert.equal(reveal(party({ gstin: '27AAAPA0002A1Z5', registrationType: 'regular' })), false);
    assert.equal(reveal(party({ registrationType: 'unregistered' })), false);
    assert.equal(reveal(party({ registrationType: 'regular' })), true, 'Regular without a GSTIN is a choice (and an error the user must see)');
  });

  it('an error inside opens it (client or server key, nested keys included)', () => {
    assert.equal(reveal(party(), { email: 'Enter a valid e-mail address' }), true);
    assert.equal(reveal(party(), { 'aliases[1]': 'Duplicate alias' }), true);
    assert.equal(reveal(party(), { gstin: 'Check the GSTIN' }), false, 'an error on an Essential leaves it closed');
    assert.deepEqual(errorFields({ 'openingBills[2].amount': 'x', 'aliases[0]': 'y', pan: 'z', empty: '' }), { openingBills: 'x', moreAliases: 'y', pan: 'z' });
  });

  it('expense ledger: GST applicable or a 0 % rate is data; an untouched one stays closed', () => {
    const exp = (patch: Partial<LedgerDraft> = {}) => fresh('INDIRECT_EXPENSES', patch);
    assert.equal(reveal(exp(), {}, 'INDIRECT_EXPENSES'), false);
    assert.equal(reveal(exp({ gstApplicable: true }), {}, 'INDIRECT_EXPENSES'), true);
    assert.equal(reveal(exp({ gstRate: 0 }), {}, 'INDIRECT_EXPENSES'), true);
    // A sales ledger's own rate is an Essential: it never forces More details open.
    assert.equal(reveal(fresh('SALES_ACCOUNTS', { gstRate: 18, hsnSac: '7318' }), {}, 'SALES_ACCOUNTS'), false);
    assert.equal(reveal(fresh('SALES_ACCOUNTS', { cessRate: 1 }), {}, 'SALES_ACCOUNTS'), true);
  });
});

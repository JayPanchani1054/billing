import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LedgerDetail } from '../../../../shared/types/accounts.ts';
import { classOfGroup, indexGroups } from './groupClass.ts';
import { applyGroupDefaults, buildSaveInput, draftFromDetail, emptyLedgerDraft, gstDetailsChanged, isDraftDirty, validateLedgerDraft } from './ledgerDraft.ts';
import { ledgerSections } from './ledgerSections.ts';
import type { SectionContext } from './ledgerSections.ts';
import { groupIdOf, predefinedTestGroups } from './testGroups.ts';

const groups = predefinedTestGroups();
const index = indexGroups(groups);
const SALES = groupIdOf(groups, 'SALES_ACCOUNTS');
const DEBTORS = groupIdOf(groups, 'SUNDRY_DEBTORS');
const BANK = groupIdOf(groups, 'BANK_ACCOUNTS');
const CTX: SectionContext = {
  features: { billWise: true, interest: false, costCentres: false, inventory: true, integrateInventory: true, tds: false, multiCurrency: false, gst: true },
};
const sectionsFor = (groupId: number) => ledgerSections(classOfGroup(index, groupId), CTX);
const DEFAULTS = { features: { billWise: true, inventory: true, gst: true }, gstEnabled: true, companyStateCode: '27' };
const MH = '27AAPFU0939F1ZV';

function detail(over: Partial<LedgerDetail> = {}): LedgerDetail {
  const d = emptyLedgerDraft('Sharma Traders', DEBTORS);
  return {
    id: 42,
    guid: 'g',
    name: d.name,
    alias: null,
    groupId: DEBTORS,
    isActive: true,
    openingBalance: 0,
    currencyId: null,
    billWise: true,
    defaultCreditDays: 30,
    creditLimit: null,
    interestEnabled: false,
    interestRate: null,
    costCentresApplicable: false,
    inventoryValuesAffected: false,
    mailingName: null,
    address: null,
    stateCode: '27',
    country: 'India',
    pincode: null,
    contactPerson: null,
    phone: null,
    mobile: null,
    email: null,
    pan: null,
    registrationType: 'unregistered',
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
    groupName: 'Sundry Debtors',
    groupPath: ['Current Assets', 'Sundry Debtors'],
    primaryGroupCode: 'CURRENT_ASSETS',
    reservedCode: null,
    isPredefined: false,
    classes: ['party', 'debtor', 'asset'],
    openingBills: [],
    gstRateHistory: [],
    closingBalance: 0,
    voucherCount: 0,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('applyGroupDefaults (new ledgers, Tally-like)', () => {
  it('choosing Sundry Debtors turns bill-wise on and starts in the company state', () => {
    const d = applyGroupDefaults(emptyLedgerDraft('A'), null, classOfGroup(index, DEBTORS), DEFAULTS);
    assert.equal(d.billWise, true);
    assert.equal(d.stateCode, '27');
  });

  it('choosing Sales Accounts: GST applicable, taxable, inventory affected', () => {
    const d = applyGroupDefaults(emptyLedgerDraft('Sales @18%'), null, classOfGroup(index, SALES), DEFAULTS);
    assert.equal(d.gstApplicable, true);
    assert.equal(d.gstTaxability, 'taxable');
    assert.equal(d.inventoryValuesAffected, true);
  });

  it('moving a new ledger from a party group to a bank turns bill-wise off (no bills yet)', () => {
    const party = applyGroupDefaults(emptyLedgerDraft('A'), null, classOfGroup(index, DEBTORS), DEFAULTS);
    const bank = applyGroupDefaults(party, classOfGroup(index, DEBTORS), classOfGroup(index, BANK), DEFAULTS);
    assert.equal(bank.billWise, false);
  });

  it('GST off in the company: sales ledger stays non-GST', () => {
    const d = applyGroupDefaults(emptyLedgerDraft('S'), null, classOfGroup(index, SALES), { ...DEFAULTS, gstEnabled: false });
    assert.equal(d.gstApplicable, false);
  });
});

describe('validateLedgerDraft', () => {
  it('requires name and group', () => {
    const e = validateLedgerDraft(emptyLedgerDraft(''), { sections: ledgerSections(null, CTX), booksFrom: '2026-04-01', final: true });
    assert.equal(e.name, 'Enter the ledger name');
    assert.match(e.groupId, /Choose the group/);
  });

  it('party identifiers: PAN, PIN (India only), email, mobile, GSTIN', () => {
    const d = { ...emptyLedgerDraft('A', DEBTORS), pan: 'ABC', pincode: '0123', email: 'x@', mobile: '12345', gstin: `${MH.slice(0, 14)}A`, registrationType: 'regular' as const };
    const e = validateLedgerDraft(d, { sections: sectionsFor(DEBTORS), booksFrom: '2026-04-01', final: true });
    assert.ok(e.pan && e.pincode && e.email && e.mobile && e.gstin);
    const overseas = validateLedgerDraft({ ...d, registrationType: 'overseas', gstin: '', pincode: '90210', stateCode: '96', pan: '', email: '', mobile: '' }, {
      sections: sectionsFor(DEBTORS),
      booksFrom: '2026-04-01',
      final: true,
    });
    assert.deepEqual(overseas, {});
  });

  it('bank: IFSC and account number', () => {
    const d = { ...emptyLedgerDraft('HDFC', BANK), bankIfsc: 'HDFC1234567', bankAccountNo: '12' };
    const e = validateLedgerDraft(d, { sections: sectionsFor(BANK), booksFrom: '2026-04-01', final: true });
    assert.match(e.bankIfsc, /0, then 6/);
    assert.match(e.bankAccountNo, /6–20 digits/);
  });

  it('GST details: slab check unless non-standard allowed; exempt carries no rate; HSN shape', () => {
    const d = { ...emptyLedgerDraft('S', SALES), gstApplicable: true, gstRate: 17, hsnSac: '12' };
    const e = validateLedgerDraft(d, { sections: sectionsFor(SALES), booksFrom: '2026-04-01', final: true });
    assert.match(e.gstRate, /not a GST rate slab/);
    assert.match(e.hsnSac, /4, 6 or 8 digits/);
    assert.equal(validateLedgerDraft({ ...d, hsnSac: '', allowNonStandardRate: true }, { sections: sectionsFor(SALES), booksFrom: '2026-04-01', final: true }).gstRate, undefined);
    const exempt = validateLedgerDraft({ ...d, hsnSac: '', gstTaxability: 'exempt', gstRate: 5 }, { sections: sectionsFor(SALES), booksFrom: '2026-04-01', final: true });
    assert.match(exempt.gstRate, /no GST rate/);
  });

  it('opening bills are validated only with bill-wise on', () => {
    const d = { ...emptyLedgerDraft('A', DEBTORS), billWise: true, openingBills: [{ key: 'k', billName: '', billDate: '2026-03-01', dueDate: null, amount: 100 }] };
    const e = validateLedgerDraft(d, { sections: sectionsFor(DEBTORS), booksFrom: '2026-04-01', final: true });
    assert.equal(e['openingBills[0].billName'], 'Enter the bill number');
  });
});

describe('buildSaveInput', () => {
  it('create: hidden sections are cleared (bank details typed before switching to a party group)', () => {
    const d = { ...emptyLedgerDraft('Sharma', DEBTORS), bankIfsc: 'HDFC0001234', gstin: MH, stateCode: '27', registrationType: 'regular' as const, openingBalance: 500 };
    const { input } = buildSaveInput(d, sectionsFor(DEBTORS), null);
    assert.equal(input.bankIfsc, null);
    assert.equal(input.gstin, MH);
    assert.equal(input.openingBalance, 500);
    assert.equal('id' in input, false);
    assert.equal('gstNatureOverride' in input, false);
  });

  it('alter: only changed fields are sent (patch); nothing changed → unchanged', () => {
    const orig = detail();
    const d = draftFromDetail(orig);
    const same = buildSaveInput(d, sectionsFor(DEBTORS), orig);
    assert.equal(same.unchanged, true);
    assert.deepEqual(same.input, { id: 42 });
    const changed = buildSaveInput({ ...d, defaultCreditDays: 45, email: 'a@b.in' }, sectionsFor(DEBTORS), orig);
    assert.deepEqual(changed.input, { id: 42, defaultCreditDays: 45, email: 'a@b.in' });
  });

  it('alter: moving a bank ledger out of Bank Accounts sends nulls for the carried-over bank fields', () => {
    const orig = detail({ groupId: BANK, bankIfsc: 'HDFC0001234', bankName: 'HDFC', billWise: false, stateCode: null, registrationType: null, defaultCreditDays: null });
    const d = { ...draftFromDetail(orig), groupId: DEBTORS };
    const { input } = buildSaveInput(d, sectionsFor(DEBTORS), orig);
    assert.equal(input.groupId, DEBTORS);
    assert.equal(input.bankIfsc, null);
    assert.equal(input.bankName, null);
  });

  it('alter: opening bills only when changed; server indices skip blank rows', () => {
    const orig = detail({ openingBalance: 1_000, openingBills: [{ id: 1, billName: 'A', billDate: '2026-03-01', dueDate: null, amount: 1_000 }] });
    const d = draftFromDetail(orig);
    assert.equal('openingBills' in buildSaveInput(d, sectionsFor(DEBTORS), orig).input, false);
    const two = {
      ...d,
      openingBalance: 1_500,
      openingBills: [{ key: 'x', billName: '', billDate: null, dueDate: null, amount: null }, ...d.openingBills, { key: 'y', billName: 'B', billDate: '2026-03-02', dueDate: null, amount: 500 }],
    };
    const out = buildSaveInput(two, sectionsFor(DEBTORS), orig);
    assert.equal(out.input.openingBills?.length, 2);
    assert.deepEqual(out.billIndexMap, [1, 2]);
    assert.equal(out.input.openingBalance, 1_500);
  });

  it('alter: applicableFrom only when a GST rate detail changed and a rate stays', () => {
    const orig = detail({ groupId: SALES, gstApplicable: true, gstTaxability: 'taxable', gstRate: 12, registrationType: null, stateCode: null, billWise: false, defaultCreditDays: null });
    const d = { ...draftFromDetail(orig), gstRate: 18, applicableFrom: '2026-09-22' };
    assert.equal(gstDetailsChanged(d, sectionsFor(SALES), orig), true);
    assert.equal(buildSaveInput(d, sectionsFor(SALES), orig).input.applicableFrom, '2026-09-22');
    // Rate cleared: the history is removed by the server, so no date is sent.
    const cleared = { ...d, gstRate: null };
    assert.equal(buildSaveInput(cleared, sectionsFor(SALES), orig).input.applicableFrom, undefined);
    // Only the name changed: no date.
    const renamed = { ...draftFromDetail(orig), name: 'Sales 18', applicableFrom: '2026-09-22' };
    assert.equal(buildSaveInput(renamed, sectionsFor(SALES), orig).input.applicableFrom, undefined);
  });

  it('non-standard rate is flagged for the server', () => {
    const d = { ...emptyLedgerDraft('S', SALES), gstApplicable: true, gstRate: 0.5, allowNonStandardRate: true };
    assert.equal(buildSaveInput(d, sectionsFor(SALES), null).input.allowNonStandardRate, true);
  });

  it('isDraftDirty ignores bill row keys', () => {
    const orig = detail({ openingBills: [{ id: 1, billName: 'A', billDate: '2026-03-01', dueDate: null, amount: 1 }] });
    const a = draftFromDetail(orig);
    const b = { ...a, openingBills: a.openingBills.map((x) => ({ ...x, key: 'other' })) };
    assert.equal(isDraftDirty(b, a), false);
    assert.equal(isDraftDirty({ ...a, name: 'X' }, a), true);
  });
});

describe('fieldsFromDraft — hidden is not the same as cleared', () => {
  const OFF: SectionContext = {
    features: { billWise: false, interest: false, costCentres: false, inventory: false, integrateInventory: false, tds: false, multiCurrency: false, gst: false },
    gstEnabled: false,
  };

  it('alter with F11 features / GST turned off keeps the stored settings (nothing is sent)', () => {
    const orig = detail({
      groupId: SALES,
      registrationType: null,
      stateCode: null,
      billWise: false,
      defaultCreditDays: null,
      gstApplicable: true,
      gstTaxability: 'taxable',
      gstRate: 18,
      hsnSac: '9983',
      costCentresApplicable: true,
      inventoryValuesAffected: true,
      tdsApplicable: true,
      tdsSection: '194J',
    });
    const sec = ledgerSections(classOfGroup(index, SALES), OFF);
    assert.equal(sec.gstDetails, false);
    assert.equal(sec.gstAllowed, true);
    const out = buildSaveInput(draftFromDetail(orig), sec, orig);
    assert.equal(out.unchanged, true);
  });

  it('alter: moving a customer to an expense group keeps the address (Tally keeps it too)', () => {
    const orig = detail({ address: '12 MG Road', email: 'a@b.in' });
    const EXP = 102;
    const { input } = buildSaveInput({ ...draftFromDetail(orig), groupId: EXP }, ledgerSections(classOfGroup(index, EXP), CTX), orig);
    assert.equal(input.groupId, EXP);
    assert.equal('address' in input, false);
    assert.equal('email' in input, false);
  });

  it('create: party details typed before switching to an expense group are not sent', () => {
    const EXP = 102;
    const d = { ...emptyLedgerDraft('Rent', EXP), address: 'typed by mistake', gstin: MH };
    const { input } = buildSaveInput(d, ledgerSections(classOfGroup(index, EXP), CTX), null);
    assert.equal(input.address, null);
    assert.equal(input.gstin, null);
  });

  it('ITC / reverse charge are cleared for an outward (sales) ledger', () => {
    const d = { ...emptyLedgerDraft('S', SALES), gstApplicable: true, isReverseCharge: true, itcEligibility: 'inputs' as const };
    const { input } = buildSaveInput(d, sectionsFor(SALES), null);
    assert.equal(input.isReverseCharge, false);
    assert.equal(input.itcEligibility, null);
  });
});

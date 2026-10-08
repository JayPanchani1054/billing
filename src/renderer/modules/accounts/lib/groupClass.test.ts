import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classNamesOf, classOfGroup, groupIsUnder, indexGroups, natureHint } from './groupClass.ts';
import { defaultOpeningSide, ledgerSections, visibleSectionTitles } from './ledgerSections.ts';
import type { SectionContext } from './ledgerSections.ts';
import { groupIdOf, predefinedTestGroups } from './testGroups.ts';

const groups = predefinedTestGroups();
const index = indexGroups(groups);
const cls = (code: Parameters<typeof groupIdOf>[1]) => classOfGroup(index, groupIdOf(groups, code));

const ALL_ON: SectionContext = {
  features: { billWise: true, interest: true, costCentres: true, inventory: true, integrateInventory: true, tds: true, multiCurrency: true, gst: true },
};

describe('classOfGroup (mirrors core classFromChain)', () => {
  it('classifies a user sub-group by its reserved ancestors', () => {
    const c = classOfGroup(index, 101);
    assert.ok(c);
    assert.equal(c.isDebtor, true);
    assert.equal(c.isParty, true);
    assert.equal(c.primaryCode, 'CURRENT_ASSETS');
    assert.deepEqual(classNamesOf(c), ['party', 'debtor', 'asset']);
  });

  it('Bank OD is a bank and a liability', () => {
    const c = cls('BANK_OD');
    assert.ok(c);
    assert.equal(c.isBank, true);
    assert.equal(c.isBankOd, true);
    assert.equal(c.isCashOrBank, true);
    assert.deepEqual(classNamesOf(c), ['bank', 'cash_bank', 'liability']);
  });

  it('Sales Accounts is sales and income and affects gross profit', () => {
    const c = cls('SALES_ACCOUNTS');
    assert.ok(c);
    assert.deepEqual(classNamesOf(c), ['sales', 'income']);
    assert.equal(c.affectsGrossProfit, true);
  });

  it('unknown group / null → null; groupIsUnder walks the chain', () => {
    assert.equal(classOfGroup(index, 9999), null);
    assert.equal(classOfGroup(index, null), null);
    assert.equal(groupIsUnder(index, 101, 'CURRENT_ASSETS'), true);
    assert.equal(groupIsUnder(index, 102, 'CURRENT_ASSETS'), false);
  });

  it('a cycle in bad data does not hang', () => {
    const bad = indexGroups([
      { id: 1, parentId: 2, reservedCode: null, nature: 'assets', affectsGrossProfit: false },
      { id: 2, parentId: 1, reservedCode: null, nature: 'assets', affectsGrossProfit: false },
    ]);
    assert.equal(classOfGroup(bad, 1), null);
  });

  it('nature hints are plain English', () => {
    assert.match(natureHint('income', true), /gross profit/);
    assert.match(natureHint('liabilities', false), /owes/);
  });
});

describe('ledgerSections (section visibility by class)', () => {
  it('customer: party details, bill-wise, interest, TDS; no bank/tax/GST rate details', () => {
    const s = ledgerSections(classOfGroup(index, 101), ALL_ON);
    assert.equal(s.party, true);
    assert.equal(s.billWise, true);
    assert.equal(s.interest, true);
    assert.equal(s.bank, false);
    assert.equal(s.tax, false);
    assert.equal(s.gstDetails, false);
    assert.equal(s.tds, true);
    assert.deepEqual(visibleSectionTitles(s), ['Basic details', 'Opening balance', 'Party details', 'GST registration', 'Other settings']);
  });

  it('bank: bank details only', () => {
    const s = ledgerSections(cls('BANK_ACCOUNTS'), ALL_ON);
    assert.equal(s.bank, true);
    assert.equal(s.party, false);
    assert.equal(s.gstDetails, false);
    assert.equal(s.billWise, false);
  });

  it('bill-wise switch stays visible for a non-party ledger that already keeps bills', () => {
    assert.equal(ledgerSections(cls('BANK_ACCOUNTS'), { ...ALL_ON, billWiseOn: true }).billWise, true);
  });

  it('Duties & Taxes: tax section', () => {
    const s = ledgerSections(cls('DUTIES_TAXES'), ALL_ON);
    assert.equal(s.tax, true);
    assert.equal(s.gstDetails, false);
  });

  it('sales: GST details without ITC/RCM or charges fields; inventory values', () => {
    const s = ledgerSections(cls('SALES_ACCOUNTS'), ALL_ON);
    assert.equal(s.gstDetails, true);
    assert.equal(s.gstInward, false);
    assert.equal(s.gstCharges, false);
    assert.equal(s.inventoryValues, true);
    assert.equal(s.costCentres, true);
  });

  it('purchase: inward GST fields (ITC, reverse charge)', () => {
    const s = ledgerSections(cls('PURCHASE_ACCOUNTS'), ALL_ON);
    assert.equal(s.gstInward, true);
    assert.equal(s.gstCharges, false);
  });

  it('indirect expense (freight): charges fields + inward', () => {
    const s = ledgerSections(classOfGroup(index, 102), ALL_ON);
    assert.equal(s.gstDetails, true);
    assert.equal(s.gstInward, true);
    assert.equal(s.gstCharges, true);
  });

  it('fixed assets: GST details (capital goods ITC) but no cost centres', () => {
    const s = ledgerSections(cls('FIXED_ASSETS'), ALL_ON);
    assert.equal(s.gstDetails, true);
    assert.equal(s.gstInward, true);
    assert.equal(s.costCentres, false);
  });

  it('GST off in the company → no GST details anywhere', () => {
    const s = ledgerSections(cls('SALES_ACCOUNTS'), { ...ALL_ON, gstEnabled: false });
    assert.equal(s.gstDetails, false);
    assert.equal(s.gstInward, false);
  });

  it('features off hide their sections', () => {
    const off: SectionContext = {
      features: { billWise: false, interest: false, costCentres: false, inventory: false, integrateInventory: false, tds: false, multiCurrency: false, gst: true },
    };
    const s = ledgerSections(classOfGroup(index, 101), off);
    assert.equal(s.billWise, false);
    assert.equal(s.interest, false);
    assert.equal(s.tds, false);
    assert.equal(s.currency, false);
  });

  it('Stock-in-Hand with integrated inventory takes no opening balance', () => {
    assert.equal(ledgerSections(cls('STOCK_IN_HAND'), { ...ALL_ON, stockInHand: true }).openingBalance, false);
    const notIntegrated = { ...ALL_ON, features: { ...ALL_ON.features, integrateInventory: false }, stockInHand: true };
    assert.equal(ledgerSections(cls('STOCK_IN_HAND'), notIntegrated).openingBalance, true);
  });

  it('opening side follows the nature', () => {
    assert.equal(defaultOpeningSide(cls('SUNDRY_CREDITORS')), 'cr');
    assert.equal(defaultOpeningSide(cls('SALES_ACCOUNTS')), 'cr');
    assert.equal(defaultOpeningSide(cls('CASH_IN_HAND')), 'dr');
    assert.equal(defaultOpeningSide(null), 'dr');
  });
});

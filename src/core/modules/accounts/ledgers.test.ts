import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FieldIssue } from '../../../shared/api.ts';
import type { LedgerSaveInput } from '../../../shared/types/accounts.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany, makeGstin, type TestCompany } from '../../testing/fixtures.ts';
import {
  assertLedgerUsable,
  bulkCreateLedgers,
  deleteLedger,
  getLedger,
  isLedgerUsable,
  ledgerGstRateOn,
  ledgerInfo,
  openingBalanceSummary,
  saveLedger,
} from './ledgers.ts';
import { lastAudit, postRaw } from './testkit.ts';

const isErr = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));

/** Run `fn`, expect a VALIDATION error with an issue at `path` whose message matches `re`. */
function expectIssue(fn: () => unknown, path: string, re: RegExp): FieldIssue[] {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
    assert.equal(e.code, 'VALIDATION', e.message);
    const issues = e.details as FieldIssue[];
    const hit = issues.find((i) => i.path === path);
    assert.ok(hit, `no issue at ${path}; got ${JSON.stringify(issues)}`);
    assert.match(hit.message, re);
    return issues;
  }
  assert.fail(`expected a validation error at ${path}`);
}

const party = (t: TestCompany, over: LedgerSaveInput = {}): LedgerSaveInput => ({ name: 'Acme Traders', groupId: t.ids.groups.SUNDRY_DEBTORS, ...over });

describe('ledger save: party GST registration', () => {
  it('fills state, PAN and registration type from the GSTIN', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, party(t, { gstin: ` ${makeGstin('29').toLowerCase()} ` }));
    assert.equal(l.gstin, makeGstin('29'));
    assert.equal(l.stateCode, '29');
    assert.equal(l.pan, 'AAPFU0939F');
    assert.equal(l.registrationType, 'regular');
    assert.deepEqual(l.classes, ['party', 'debtor', 'asset']);
    assert.deepEqual(l.groupPath, ['Current Assets', 'Sundry Debtors']);
    assert.equal(l.billWise, true, 'parties keep bills by default when bill-wise is enabled (F11)');
    assert.equal(saveLedger(t.ctx, { name: 'Rent', groupId: t.ids.groups.INDIRECT_EXPENSES }).billWise, false);
    t.close();
    const noBills = createTestCompany({ features: { billWise: false } });
    assert.equal(saveLedger(noBills.ctx, { name: 'Acme', groupId: noBills.ids.groups.SUNDRY_DEBTORS }).billWise, false);
    noBills.close();
  });

  it('adding a GSTIN later re-derives the carried-over state, PAN and registration type', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, party(t));
    assert.deepEqual([l.stateCode, l.registrationType, l.pan], ['27', 'unregistered', null]);
    const a = saveLedger(t.ctx, { id: l.id, gstin: makeGstin('29') });
    assert.deepEqual([a.stateCode, a.registrationType, a.pan], ['29', 'regular', 'AAPFU0939F']);
    // Entered together with a different state → still an error.
    expectIssue(() => saveLedger(t.ctx, { id: l.id, gstin: makeGstin('33'), stateCode: '29' }), 'gstin', /registered in Tamil Nadu \(33\)/);
    t.close();
  });

  it("rejects a GSTIN from another state than the ledger's state", () => {
    const t = createTestCompany();
    expectIssue(() => saveLedger(t.ctx, party(t, { gstin: makeGstin('29'), stateCode: '27' })), 'gstin', /registered in Karnataka \(29\).*Maharashtra \(27\)/);
    t.close();
  });

  it('rejects a mistyped GSTIN and a PAN that differs from the PAN inside the GSTIN', () => {
    const t = createTestCompany();
    const g = makeGstin('27');
    const typo = g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A');
    expectIssue(() => saveLedger(t.ctx, party(t, { gstin: typo })), 'gstin', /check character/);
    expectIssue(() => saveLedger(t.ctx, party(t, { gstin: g, pan: 'ABCPE1234F' })), 'pan', /does not match the PAN inside the GSTIN \(AAPFU0939F\)/);
    t.close();
  });

  it('enforces registration-type rules', () => {
    const t = createTestCompany();
    for (const reg of ['regular', 'composition', 'sez'] as const) {
      expectIssue(() => saveLedger(t.ctx, party(t, { registrationType: reg })), 'gstin', /GSTIN is required/);
    }
    expectIssue(() => saveLedger(t.ctx, party(t, { registrationType: 'consumer', gstin: makeGstin('27') })), 'gstin', /consumer party cannot have a GSTIN/);
    expectIssue(() => saveLedger(t.ctx, party(t, { registrationType: 'unregistered', gstin: makeGstin('27') })), 'gstin', /unregistered party cannot have a GSTIN/);
    expectIssue(() => saveLedger(t.ctx, party(t, { registrationType: 'overseas', stateCode: '27' })), 'stateCode', /overseas party must be '96/);
    expectIssue(() => saveLedger(t.ctx, party(t, { registrationType: 'overseas', gstin: makeGstin('27') })), 'gstin', /Overseas parties do not have a GSTIN/);
    expectIssue(() => saveLedger(t.ctx, party(t, { stateCode: '96' })), 'stateCode', /only for overseas parties/);
    expectIssue(() => saveLedger(t.ctx, party(t, { registrationType: 'uin', gstin: makeGstin('07') })), 'gstin', /UIN holder needs a UIN/);
    expectIssue(() => saveLedger(t.ctx, party(t, { stateCode: '45' })), 'stateCode', /not a GST state code/);
    // Defaults: an unregistered local party; an overseas party in state 96.
    const local = saveLedger(t.ctx, party(t, { name: 'Walk-in Customer' }));
    assert.equal(local.registrationType, 'unregistered');
    assert.equal(local.stateCode, '27', "defaults to the company's state");
    const foreign = saveLedger(t.ctx, party(t, { name: 'Globex Inc', registrationType: 'overseas', country: 'USA', pincode: '90210' }));
    assert.equal(foreign.stateCode, '96');
    assert.equal(foreign.pincode, '90210', 'PIN code rules apply only in India');
    const sez = saveLedger(t.ctx, party(t, { name: 'SEZ Unit', registrationType: 'sez', gstin: makeGstin('24', 'AAACS1234K') }));
    assert.equal(sez.registrationType, 'sez');
    assert.equal(sez.stateCode, '24');
    t.close();
  });

  it('validates PAN, mobile, e-mail and PIN code and reports every problem at once', () => {
    const t = createTestCompany();
    const issues = expectIssue(
      () => saveLedger(t.ctx, party(t, { name: '', pan: 'ABCXE1234F', mobile: '12345', email: 'accounts@', pincode: '012345' })),
      'name',
      /Ledger name is required/,
    );
    assert.deepEqual(issues.map((i) => i.path).sort(), ['email', 'mobile', 'name', 'pan', 'pincode']);
    const ok = saveLedger(t.ctx, party(t, { pan: 'abcpe1234f', mobile: '+91 98765 43210', email: ' accounts@acme.in ', pincode: '411 001' }));
    assert.equal(ok.pan, 'ABCPE1234F');
    assert.equal(ok.mobile, '9876543210');
    assert.equal(ok.email, 'accounts@acme.in');
    assert.equal(ok.pincode, '411001');
    t.close();
  });
});

describe('ledger save: fields allowed by group', () => {
  it('bank details only for Bank Accounts / Bank OD ledgers; they are cleared when a bank ledger is moved', () => {
    const t = createTestCompany();
    const bank = saveLedger(t.ctx, {
      name: 'HDFC Current A/c',
      groupId: t.ids.groups.BANK_ACCOUNTS,
      bankAccountNo: '50200012345678',
      bankIfsc: 'hdfc0001234',
      bankUpiId: 'shop@okhdfcbank',
      chequeBookEnabled: true,
    });
    assert.equal(bank.bankIfsc, 'HDFC0001234');
    assert.deepEqual(bank.classes, ['bank', 'cash_bank', 'asset']);
    expectIssue(() => saveLedger(t.ctx, party(t, { bankIfsc: 'HDFC0001234' })), 'bankIfsc', /only for ledgers under Bank Accounts or Bank OD/);
    expectIssue(() => saveLedger(t.ctx, { name: 'SBI', groupId: t.ids.groups.BANK_ACCOUNTS, bankIfsc: 'SBIN123' }), 'bankIfsc', /IFSC must be 11 characters/);
    const od = saveLedger(t.ctx, { name: 'SBI OD', groupId: t.ids.groups.BANK_OD, bankIfsc: 'SBIN0001234' });
    assert.equal(od.bankIfsc, 'SBIN0001234');
    // Moving the bank ledger elsewhere drops the details carried over from the stored ledger.
    const moved = saveLedger(t.ctx, { id: bank.id, groupId: t.ids.groups.LOANS_ADVANCES_ASSET, bankIfsc: 'HDFC0001234' });
    assert.equal(moved.bankIfsc, null);
    assert.equal(moved.bankAccountNo, null);
    assert.equal(moved.chequeBookEnabled, false);
    t.close();
  });

  it('tax fields only under Duties & Taxes; GST tax ledgers need a duty head', () => {
    const t = createTestCompany();
    const tds = saveLedger(t.ctx, { name: 'TDS Payable 194C', groupId: t.ids.groups.DUTIES_TAXES, taxType: 'TDS' });
    assert.equal(tds.taxType, 'TDS');
    expectIssue(() => saveLedger(t.ctx, { name: 'Output IGST 5%', groupId: t.ids.groups.DUTIES_TAXES, taxType: 'GST' }), 'gstDutyHead', /Choose the GST duty head/);
    const inferred = saveLedger(t.ctx, { name: 'Output CGST (Old)', groupId: t.ids.groups.DUTIES_TAXES, gstDutyHead: 'CGST', gstTaxDirection: 'output' });
    assert.equal(inferred.taxType, 'GST');
    expectIssue(() => saveLedger(t.ctx, { name: 'Odd Sales', groupId: t.ids.groups.SALES_ACCOUNTS, gstDutyHead: 'IGST' }), 'gstDutyHead', /only for ledgers under Duties & Taxes/);
    t.close();
  });

  it('GST rate details only for sales/purchase/income/expense ledgers, with slab, HSN/SAC and taxability checks', () => {
    const t = createTestCompany();
    const sales = saveLedger(t.ctx, { name: 'Sales @18%', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, gstRate: 18, hsnSac: '8471' });
    assert.equal(sales.gstTaxability, 'taxable');
    assert.equal(sales.gstSupplyType, 'goods');
    expectIssue(() => saveLedger(t.ctx, party(t, { gstApplicable: true, gstRate: 18 })), 'gstRate', /GST rate details can be set only/);
    expectIssue(() => saveLedger(t.ctx, { name: 'Sales @17%', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, gstRate: 17 }), 'gstRate', /17% is not a GST rate slab/);
    const odd = saveLedger(t.ctx, { name: 'Sales @17%', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, gstRate: 17, allowNonStandardRate: true });
    assert.equal(odd.gstRate, 17);
    expectIssue(() => saveLedger(t.ctx, { name: 'Svc', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, hsnSac: '99831' }), 'hsnSac', /4, 6 or 8 digits/);
    expectIssue(
      () => saveLedger(t.ctx, { name: 'Svc', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, hsnSac: '998314', gstSupplyType: 'goods' }),
      'hsnSac',
      /SAC \(services\)/,
    );
    const svc = saveLedger(t.ctx, { name: 'Consulting Income', groupId: t.ids.groups.INDIRECT_INCOMES, gstApplicable: true, gstRate: 18, hsnSac: '998314' });
    assert.equal(svc.gstSupplyType, 'services');
    expectIssue(
      () => saveLedger(t.ctx, { name: 'Exempt Sales', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, gstTaxability: 'exempt', gstRate: 5 }),
      'gstRate',
      /exempt ledger has no GST rate/,
    );
    expectIssue(
      () => saveLedger(t.ctx, { name: 'Sales ITC', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, itcEligibility: 'inputs' }),
      'itcEligibility',
      /only to purchase, expense and fixed-asset ledgers/,
    );
    const capex = saveLedger(t.ctx, { name: 'Machinery', groupId: t.ids.groups.FIXED_ASSETS, gstApplicable: true, gstRate: 18, itcEligibility: 'capital_goods' });
    assert.equal(capex.itcEligibility, 'capital_goods');
    // GST not applicable → rate details are dropped.
    const plain = saveLedger(t.ctx, { name: 'Misc Income', groupId: t.ids.groups.INDIRECT_INCOMES, gstApplicable: false, gstRate: 18 });
    assert.equal(plain.gstRate, null);
    // Moving a sales ledger under Sundry Debtors drops its GST details instead of failing.
    const moved = saveLedger(t.ctx, { id: sales.id, groupId: t.ids.groups.SUNDRY_DEBTORS, gstApplicable: true, gstRate: 18 });
    assert.equal(moved.gstApplicable, false);
    assert.equal(moved.gstRate, null);
    t.close();
  });
});

describe('ledger save: GST rate history', () => {
  it('writes effective-dated rows and keeps the history', () => {
    const t = createTestCompany({ today: '2026-04-15' });
    const l = saveLedger(t.ctx, { name: 'Sales - Furniture', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, gstRate: 12, hsnSac: '9403' });
    assert.deepEqual(
      l.gstRateHistory.map((h) => [h.applicableFrom, h.rate, h.hsnSac]),
      [['2026-04-01', 12, '9403']],
    );
    const after = saveLedger(t.ctx, { id: l.id, gstRate: 18, applicableFrom: '2026-09-22' });
    assert.deepEqual(
      after.gstRateHistory.map((h) => [h.applicableFrom, h.rate]),
      [
        ['2026-04-01', 12],
        ['2026-09-22', 18],
      ],
    );
    assert.equal(ledgerGstRateOn(t.db, l.id, '2026-06-30')?.rate, 12);
    assert.equal(ledgerGstRateOn(t.db, l.id, '2026-09-22')?.rate, 18);
    // Without a date the change corrects the latest row.
    const corrected = saveLedger(t.ctx, { id: l.id, hsnSac: '94036000' });
    assert.deepEqual(
      corrected.gstRateHistory.map((h) => [h.applicableFrom, h.rate, h.hsnSac]),
      [
        ['2026-04-01', 12, '9403'],
        ['2026-09-22', 18, '94036000'],
      ],
    );
    // A back-dated rate is inserted in the history; the master keeps showing the latest rate.
    const back = saveLedger(t.ctx, { id: l.id, gstRate: 5, applicableFrom: '2026-06-01' });
    assert.deepEqual(
      back.gstRateHistory.map((h) => h.rate),
      [12, 5, 18],
    );
    assert.equal(back.gstRate, 18);
    assert.equal(ledgerGstRateOn(t.db, l.id, '2026-07-01')?.rate, 5);
    // Unchanged GST details write nothing.
    saveLedger(t.ctx, { id: l.id, notes: 'Wooden furniture', applicableFrom: '2026-10-01' });
    assert.equal(getLedger(t.db, l.id, t.today).gstRateHistory.length, 3);
    assert.equal(ledgerGstRateOn(t.db, t.ids.ledgers.CASH, '2026-07-01'), null);
    t.close();
  });
});

describe('ledger save: opening bills', () => {
  it('requires the bills to add up to the opening balance, showing both amounts', () => {
    const t = createTestCompany();
    const base = party(t, { billWise: true, openingBalance: 150000 });
    const err = expectIssue(
      () =>
        saveLedger(t.ctx, {
          ...base,
          openingBills: [
            { billName: 'INV-1', billDate: '2026-03-10', amount: 100000 },
            { billName: 'INV-2', billDate: '2026-03-20', amount: 40000 },
          ],
        }),
      'openingBills',
      /add up to ₹ 1,400.00 Dr but the opening balance is ₹ 1,500.00 Dr \(difference ₹ 100.00 Dr\)/,
    );
    assert.equal(err.length, 1);
    const ok = saveLedger(t.ctx, {
      ...base,
      openingBills: [
        { billName: 'INV-2', billDate: '2026-03-20', dueDate: '2026-04-19', amount: 50000 },
        { billName: 'INV-1', billDate: '2026-03-10', amount: 100000 },
      ],
    });
    assert.deepEqual(
      ok.openingBills.map((b) => [b.billName, b.amount, b.dueDate]),
      [
        ['INV-1', 100000, null],
        ['INV-2', 50000, '2026-04-19'],
      ],
    );
    // Credit-side bills for a supplier.
    const sup = saveLedger(t.ctx, {
      name: 'Supplier One',
      groupId: t.ids.groups.SUNDRY_CREDITORS,
      billWise: true,
      openingBalance: -50000,
      openingBills: [{ billName: 'P-77', billDate: '2026-03-31', amount: -50000 }],
    });
    assert.equal(sup.openingBills.length, 1);
    // Changing the opening balance alone re-checks the stored bills.
    expectIssue(() => saveLedger(t.ctx, { id: ok.id, openingBalance: 160000 }), 'openingBills', /add up to ₹ 1,500.00 Dr/);
    expectIssue(() => saveLedger(t.ctx, { id: ok.id, billWise: false }), 'billWise', /2 opening bills\. Remove them before turning off/);
    t.close();
  });

  it('checks bill-wise flag, bill dates and duplicate references', () => {
    const t = createTestCompany();
    expectIssue(
      () => saveLedger(t.ctx, party(t, { billWise: false, openingBalance: 100, openingBills: [{ billName: 'A', billDate: '2026-03-01', amount: 100 }] })),
      'openingBills',
      /Turn on bill-wise details/,
    );
    expectIssue(
      () => saveLedger(t.ctx, party(t, { billWise: true, openingBalance: 100, openingBills: [{ billName: 'A', billDate: '2026-04-05', amount: 100 }] })),
      'openingBills[0].billDate',
      /outstanding when the books begin \(01-Apr-2026\)/,
    );
    expectIssue(
      () =>
        saveLedger(
          t.ctx,
          party(t, {
            billWise: true,
            openingBalance: 200,
            openingBills: [
              { billName: 'A', billDate: '2026-03-01', amount: 100 },
              { billName: 'a', billDate: '2026-03-02', amount: 100 },
            ],
          }),
        ),
      'openingBills[1].billName',
      /entered twice/,
    );
    t.close();
  });
});

describe('ledger save: names, reserved ledgers, patching, audit', () => {
  it('keeps names and aliases unique among ledgers', () => {
    const t = createTestCompany();
    saveLedger(t.ctx, party(t, { alias: 'ACME' }));
    expectIssue(() => saveLedger(t.ctx, party(t, { name: 'acme traders' })), 'name', /A ledger named 'Acme Traders' already exists/);
    expectIssue(() => saveLedger(t.ctx, party(t, { name: 'Acme' })), 'name', /already the alias of ledger 'Acme Traders'/);
    expectIssue(() => saveLedger(t.ctx, party(t, { name: 'Acme Pune', alias: 'acme' })), 'alias', /already used by ledger 'Acme Traders'/);
    expectIssue(() => saveLedger(t.ctx, party(t, { name: 'Acme Pune', alias: 'Cash' })), 'alias', /name of another ledger/);
    const same = saveLedger(t.ctx, party(t, { name: 'Beta Corp', alias: 'beta corp' }));
    assert.equal(same.alias, null, 'an alias equal to the name is dropped');
    t.close();
  });

  it('reserved ledgers keep their group, stay active and keep their tax settings, but can be renamed', () => {
    const t = createTestCompany();
    const cash = t.ids.ledgers.CASH;
    expectIssue(() => saveLedger(t.ctx, { id: cash, groupId: t.ids.groups.BANK_ACCOUNTS }), 'groupId', /reserved ledger and must stay under Cash-in-Hand/);
    expectIssue(() => saveLedger(t.ctx, { id: cash, isActive: false }), 'isActive', /cannot be made inactive/);
    const renamed = saveLedger(t.ctx, { id: cash, name: 'Cash in Hand', openingBalance: 250000 });
    assert.equal(renamed.name, 'Cash in Hand');
    assert.equal(renamed.reservedCode, 'CASH');
    expectIssue(() => saveLedger(t.ctx, { id: t.ids.ledgers.OUTPUT_IGST, gstDutyHead: 'CGST' }), 'gstDutyHead', /cannot be changed/);
    const igst = saveLedger(t.ctx, { id: t.ids.ledgers.OUTPUT_IGST, gstDutyHead: 'IGST', alias: 'IGST Out' });
    assert.equal(igst.gstDutyHead, 'IGST');
    t.close();
  });

  it('alter is a patch: omitted fields are kept, null clears', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, party(t, { address: '1 MG Road', mobile: '9876543210', creditLimit: 5000000, defaultCreditDays: 30 }));
    const a = saveLedger(t.ctx, { id: l.id, address: null, isActive: false });
    assert.equal(a.address, null);
    assert.equal(a.mobile, '9876543210');
    assert.equal(a.creditLimit, 5000000);
    assert.equal(a.defaultCreditDays, 30);
    assert.equal(a.isActive, false);
    assert.equal(a.name, 'Acme Traders');
    expectIssue(() => saveLedger(t.ctx, { id: l.id, creditLimit: -1 }), 'creditLimit', /cannot be negative/);
    expectIssue(() => saveLedger(t.ctx, { id: l.id, interestEnabled: true }), 'interestRate', /Enter the interest rate/);
    expectIssue(() => saveLedger(t.ctx, { name: 'No Group' }), 'groupId', /Choose the group/);
    expectIssue(() => saveLedger(t.ctx, { name: 'Bad Group', groupId: 99_999 }), 'groupId', /does not exist/);
    assert.throws(() => saveLedger(t.ctx, { id: 99_999, name: 'X' }), isErr('NOT_FOUND'));
    t.close();
  });

  it('audits create and alter with before/after snapshots', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, party(t, { gstin: makeGstin('27') }));
    let a = lastAudit(t, 'ledger');
    assert.equal(a?.action, 'create');
    assert.equal(a?.entity_label, 'Acme Traders');
    assert.equal(JSON.parse(a?.after_json ?? '{}').gstin, makeGstin('27'));
    saveLedger(t.ctx, { id: l.id, name: 'Acme Traders Pvt Ltd' });
    a = lastAudit(t, 'ledger');
    assert.equal(a?.action, 'alter');
    assert.equal(JSON.parse(a?.before_json ?? '{}').name, 'Acme Traders');
    assert.equal(JSON.parse(a?.after_json ?? '{}').name, 'Acme Traders Pvt Ltd');
    t.close();
  });

  it('getLedger returns balances and usage', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, party(t, { openingBalance: 10000 }));
    postRaw(t, { date: '2026-04-02', lines: [[l.id, 5000], [t.ids.ledgers.SALES, -5000]] });
    postRaw(t, { date: '2026-04-03', optional: true, lines: [[l.id, 7000], [t.ids.ledgers.SALES, -7000]] });
    const d = getLedger(t.db, l.id, t.today);
    assert.equal(d.closingBalance, 15000);
    assert.equal(d.voucherCount, 2);
    assert.equal(d.groupName, 'Sundry Debtors');
    assert.equal(d.primaryGroupCode, 'CURRENT_ASSETS');
    t.close();
  });
});

describe('ledger delete & usability', () => {
  it('refuses to delete a ledger used in vouchers, with the voucher count', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, party(t));
    postRaw(t, { date: '2026-04-02', lines: [[l.id, 5000], [t.ids.ledgers.SALES, -5000]] });
    postRaw(t, { date: '2026-04-03', cancelled: true, lines: [[l.id, 100], [t.ids.ledgers.SALES, -100]] });
    try {
      deleteLedger(t.ctx, l.id);
      assert.fail('should refuse');
    } catch (e) {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, 'BUSINESS_RULE');
      assert.match(e.message, /Ledger 'Acme Traders' cannot be deleted: it is used in 2 vouchers\. Mark it inactive instead/);
      assert.equal((e.details as { vouchers: number }).vouchers, 2);
    }
    assert.ok(getLedger(t.db, l.id, t.today));
    t.close();
  });

  it('refuses predefined ledgers, opening balances/bills and voucher-type defaults', () => {
    const t = createTestCompany();
    assert.throws(() => deleteLedger(t.ctx, t.ids.ledgers.CASH), isErr('BUSINESS_RULE', /predefined ledger/));
    const withBills = saveLedger(t.ctx, party(t, { billWise: true, openingBalance: 100000, openingBills: [{ billName: 'OB-1', billDate: '2026-03-01', amount: 100000 }] }));
    assert.throws(
      () => deleteLedger(t.ctx, withBills.id),
      isErr('BUSINESS_RULE', /it has 1 opening bill and it has an opening balance of ₹ 1,000.00 Dr\. Remove these first/),
    );
    const exportSales = saveLedger(t.ctx, { name: 'Export Sales', groupId: t.ids.groups.SALES_ACCOUNTS });
    t.db.run('UPDATE voucher_types SET config = :c WHERE id = :id', { c: JSON.stringify({ defaultLedgerId: exportSales.id }), id: t.ids.voucherTypes.sales });
    assert.throws(() => deleteLedger(t.ctx, exportSales.id), isErr('BUSINESS_RULE', /default ledger of voucher type 'Sales'/));
    t.close();
  });

  it('deletes an unused ledger with its GST history and audits it', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, { name: 'Sales @5%', groupId: t.ids.groups.SALES_ACCOUNTS, gstApplicable: true, gstRate: 5 });
    assert.deepEqual(deleteLedger(t.ctx, l.id), { id: l.id, deleted: true });
    assert.equal(t.db.value(`SELECT COUNT(*) FROM gst_rate_history WHERE entity_type = 'ledger' AND entity_id = :id`, { id: l.id }), 0);
    const a = lastAudit(t, 'ledger');
    assert.equal(a?.action, 'delete');
    assert.equal(JSON.parse(a?.before_json ?? '{}').gstRate, 5);
    assert.throws(() => deleteLedger(t.ctx, l.id), isErr('NOT_FOUND'));
    t.close();
  });

  it('isLedgerUsable / assertLedgerUsable reject inactive and unknown ledgers; ledgerInfo describes a ledger', () => {
    const t = createTestCompany();
    const l = saveLedger(t.ctx, party(t));
    assert.equal(isLedgerUsable(t.db, l.id), true);
    assert.doesNotThrow(() => assertLedgerUsable(t.db, l.id));
    saveLedger(t.ctx, { id: l.id, isActive: false });
    assert.equal(isLedgerUsable(t.db, l.id), false);
    assert.throws(() => assertLedgerUsable(t.db, l.id), isErr('BUSINESS_RULE', /'Acme Traders' is inactive and cannot be used in new vouchers/));
    assert.equal(isLedgerUsable(t.db, 99_999), false);
    assert.throws(() => assertLedgerUsable(t.db, 99_999), isErr('NOT_FOUND'));
    const info = ledgerInfo(t.db, t.ids.ledgers.OUTPUT_CGST);
    assert.deepEqual([info.reservedCode, info.gstDutyHead, info.gstTaxDirection, info.cls.isDutyTax, info.isActive], ['OUTPUT_CGST', 'CGST', 'output', true, true]);
    assert.deepEqual(info.classes, ['duty_tax', 'liability']);
    assert.throws(() => ledgerInfo(t.db, 99_999), isErr('NOT_FOUND'));
    t.close();
  });
});

describe('ledger bulk create & opening summary', () => {
  it('creates all rows (with GSTIN auto-fill) in one go', () => {
    const t = createTestCompany();
    const r = bulkCreateLedgers(t.ctx, {
      rows: [
        { name: 'Party A', groupId: t.ids.groups.SUNDRY_DEBTORS, openingBalance: 100000 },
        { name: 'Party B', groupId: t.ids.groups.SUNDRY_DEBTORS, gstin: makeGstin('33') },
        { name: 'Rent', groupId: t.ids.groups.INDIRECT_EXPENSES },
      ],
    });
    assert.equal(r.created, 3);
    const b = getLedger(t.db, r.ids[1], t.today);
    assert.equal(b.stateCode, '33');
    assert.equal(b.registrationType, 'regular');
    assert.equal(t.db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'ledger' AND action = 'create'`), 3);
    t.close();
  });

  it('is all-or-nothing and reports per-row errors', () => {
    const t = createTestCompany();
    saveLedger(t.ctx, party(t));
    const before = t.db.value<number>('SELECT COUNT(*) FROM ledgers');
    try {
      bulkCreateLedgers(t.ctx, {
        rows: [
          { name: 'Good One', groupId: t.ids.groups.SUNDRY_DEBTORS },
          { name: 'ACME TRADERS', groupId: t.ids.groups.SUNDRY_DEBTORS },
          { name: 'Bad GSTIN', groupId: t.ids.groups.SUNDRY_DEBTORS, gstin: '27ABC' },
          { name: 'Good Two', groupId: t.ids.groups.SUNDRY_CREDITORS },
          { name: 'good one', groupId: t.ids.groups.SUNDRY_CREDITORS },
        ],
      });
      assert.fail('should refuse');
    } catch (e) {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, 'VALIDATION');
      assert.match(e.message, /3 of 5 rows have errors, so no ledgers were created/);
      const paths = (e.details as FieldIssue[]).map((d) => d.path);
      assert.deepEqual(paths, ['rows[1].name', 'rows[2].gstin', 'rows[4].name']);
      assert.match((e.details as FieldIssue[])[0].message, /^Row 2 \('ACME TRADERS'\): A ledger named 'Acme Traders' already exists/);
    }
    assert.equal(t.db.value<number>('SELECT COUNT(*) FROM ledgers'), before, 'nothing created');
    t.close();
  });

  it('summarises opening balances', () => {
    const t = createTestCompany();
    saveLedger(t.ctx, party(t, { openingBalance: 100000 }));
    saveLedger(t.ctx, { name: 'Capital', groupId: t.ids.groups.CAPITAL_ACCOUNT, openingBalance: -40000 });
    // Dr 1,000.00 − Cr 400.00 = 600.00 difference (Dr side heavier)
    assert.deepEqual(openingBalanceSummary(t.db), { totalDebit: 100000, totalCredit: 40000, difference: 60000, ledgerCount: 2 });
    t.close();
  });
});

/**
 * Contract test: the ledger form's pure model (draft → save input) and the voucher-type numbering
 * mirror, driven against the REAL accounts core on an in-memory company. It proves that what the
 * form sends is what the server expects (patch semantics on alter: omitted keeps, null clears),
 * that an untouched form sends nothing, and that the client checks agree with the server rules.
 *
 * Test-only: this file imports core services at runtime to exercise them. Renderer source files
 * never do (they use `import type` from src/core and talk to main over the API bridge).
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createTestCompany, makeGstin } from '../../../../core/testing/fixtures.ts';
import { listGroups } from '../../../../core/modules/accounts/groups.ts';
import { getLedger, listLedgers, saveLedger } from '../../../../core/modules/accounts/ledgers.ts';
import { getVoucherType, listVoucherTypes, saveVoucherType } from '../../../../core/modules/accounts/voucherTypes.ts';
import { getFeatures } from '../../../../core/modules/company/service.ts';
import { AppError } from '../../../../core/lib/errors.ts';
import { classOfGroup, indexGroups } from './groupClass.ts';
import { applyGstin, gstinProblem } from './gstin.ts';
import { applyGroupDefaults, buildSaveInput, draftFromDetail, emptyLedgerDraft, validateLedgerDraft } from './ledgerDraft.ts';
import type { LedgerDraft } from './ledgerDraft.ts';
import { ledgerSections } from './ledgerSections.ts';
import { newTypeNumbering } from './numbering.ts';

const TODAY = '2026-06-15';
const t = createTestCompany({ gst: true, stateCode: '27', today: TODAY });
after(() => t.close());

const index = indexGroups(listGroups(t.db).rows);
const features = getFeatures(t.db);
const defaultsCtx = { features, gstEnabled: true, companyStateCode: '27' };
const secOf = (groupId: number | null, billWiseOn = false) => ledgerSections(classOfGroup(index, groupId), { features, gstEnabled: true, billWiseOn });
/** A new ledger draft exactly as the form starts it under `group` (the group's usual defaults applied). */
const fresh = (name: string, groupId: number): LedgerDraft => applyGroupDefaults(emptyLedgerDraft(name, groupId), null, classOfGroup(index, groupId), defaultsCtx);
/** Save a draft the way the form does; returns the stored detail. */
function save(d: LedgerDraft, id: number | null = null) {
  const original = id === null ? null : getLedger(t.db, id, TODAY);
  const build = buildSaveInput(d, secOf(d.groupId, original?.billWise === true), original);
  const out = saveLedger(t.ctx, build.input);
  return getLedger(t.db, out.id, TODAY);
}
/** The form re-opened on a stored ledger and saved without touching anything. */
const untouched = (id: number) => {
  const det = getLedger(t.db, id, TODAY);
  return buildSaveInput(draftFromDetail(det), secOf(det.groupId, det.billWise), det);
};
const fieldsOf = (fn: () => unknown): Record<string, string> => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return Object.fromEntries(((e.details ?? []) as Array<{ path: string; message: string }>).map((x) => [x.path, x.message]));
    throw e;
  }
  return {};
};

describe('ledger form ↔ accounts core', () => {
  const DEBTORS = t.ids.groups.SUNDRY_DEBTORS;
  const CREDITORS = t.ids.groups.SUNDRY_CREDITORS;
  const SALES = t.ids.groups.SALES_ACCOUNTS;

  it('every seeded ledger re-opened and saved untouched sends nothing (no spurious patch)', () => {
    for (const r of listLedgers(t.db, { limit: 10_000 }, TODAY).rows) {
      const b = untouched(r.id);
      assert.equal(b.unchanged, true, `${r.name}: ${JSON.stringify(b.input)}`);
    }
  });

  it('a customer created with the form defaults keeps bills, gets the company state and round-trips', () => {
    const gstin = makeGstin('27');
    const det = save({
      ...fresh('Sharma Traders', DEBTORS),
      gstin,
      registrationType: 'regular',
      openingBalance: 118_000,
      openingBills: [
        { key: 'a', billName: 'INV-1', billDate: '2026-03-10', dueDate: '2026-04-09', amount: 100_000 },
        { key: 'b', billName: 'INV-2', billDate: '2026-03-20', dueDate: null, amount: 18_000 },
      ],
    });
    assert.equal(det.billWise, true);
    assert.equal(det.stateCode, '27');
    assert.equal(det.registrationType, 'regular');
    assert.equal(det.pan, 'AAPFU0939F'); // taken from the GSTIN by the server
    // 1,00,000 + 18,000 = 1,18,000 paise = the opening balance.
    assert.deepEqual(det.openingBills.map((b) => [b.billName, b.amount]), [['INV-1', 100_000], ['INV-2', 18_000]]);
    assert.equal(untouched(det.id).unchanged, true);
  });

  it('a supplier opening typed on the Cr side with a Cr bill is stored Cr (Dr +, Cr −)', () => {
    const det = save({ ...fresh('Gupta Suppliers', CREDITORS), openingBalance: -50_000, openingBills: [{ key: 'a', billName: 'P-7', billDate: '2026-03-01', dueDate: null, amount: -50_000 }] });
    assert.equal(det.openingBalance, -50_000);
    assert.equal(det.openingBills[0].amount, -50_000);
  });

  it('GSTIN added to an unregistered party: the form fills state 29 + PAN and makes it Regular; the server agrees', () => {
    const created = save(fresh('Bengaluru Stores', DEBTORS));
    assert.equal(created.registrationType, 'unregistered');
    assert.equal(created.stateCode, '27');
    const draft = draftFromDetail(created);
    const g = applyGstin(draft, makeGstin('29', 'AAACB1234C'));
    const altered = save({ ...draft, gstin: g.gstin, stateCode: g.stateCode, pan: g.pan, registrationType: g.registrationType }, created.id);
    assert.deepEqual([altered.registrationType, altered.stateCode, altered.pan], ['regular', '29', 'AAACB1234C']);
    // Removing it again: the form sends unregistered + null, the server keeps state and PAN.
    const d2 = draftFromDetail(altered);
    const cleared = applyGstin(d2, '');
    const back = save({ ...d2, gstin: cleared.gstin, registrationType: cleared.registrationType }, created.id);
    assert.deepEqual([back.registrationType, back.gstin, back.stateCode], ['unregistered', null, '29']);
  });

  it('only changed fields are sent on alter; null clears (credit period removed)', () => {
    const det = save({ ...fresh('Patch Test', DEBTORS), defaultCreditDays: 30, email: 'a@b.in' });
    const d = draftFromDetail(det);
    const b = buildSaveInput({ ...d, defaultCreditDays: null }, secOf(DEBTORS, det.billWise), det);
    assert.deepEqual(b.input, { id: det.id, defaultCreditDays: null });
    saveLedger(t.ctx, b.input);
    const after = getLedger(t.db, det.id, TODAY);
    assert.equal(after.defaultCreditDays, null);
    assert.equal(after.email, 'a@b.in');
  });

  it('a dated GST rate change keeps the earlier rate for earlier invoices; clearing the rate removes the history', () => {
    const det = save({ ...fresh('Sales 18%', SALES), gstRate: 18, hsnSac: '8471' });
    assert.equal(det.gstApplicable, true);
    assert.equal(det.inventoryValuesAffected, true); // form default = server default for Sales Accounts
    const changed = save({ ...draftFromDetail(det), gstRate: 12, applicableFrom: '2026-05-01' }, det.id);
    assert.deepEqual(
      changed.gstRateHistory.map((h) => [h.applicableFrom, h.rate]),
      [
        ['2026-04-01', 18],
        ['2026-05-01', 12],
      ],
    );
    const cleared = save({ ...draftFromDetail(changed), gstRate: null, applicableFrom: '2026-06-01' }, det.id);
    assert.equal(cleared.gstRate, null);
    assert.deepEqual(cleared.gstRateHistory, []);
  });

  it('client and server refuse the same things: GSTIN of another state; bills that do not add up', () => {
    const d = { ...fresh('Wrong State', DEBTORS), stateCode: '29', gstin: makeGstin('27'), registrationType: 'regular' as const };
    assert.equal(gstinProblem(d, true)?.field, 'gstin');
    assert.ok(fieldsOf(() => saveLedger(t.ctx, buildSaveInput(d, secOf(DEBTORS), null).input)).gstin);

    const bills = { ...fresh('Short Bills', DEBTORS), openingBalance: 118_000, openingBills: [{ key: 'a', billName: 'X', billDate: '2026-03-01', dueDate: null, amount: 100_000 }] };
    assert.ok(validateLedgerDraft(bills, { sections: secOf(DEBTORS), booksFrom: '2026-04-01', final: true }).openingBills);
    assert.ok(fieldsOf(() => saveLedger(t.ctx, buildSaveInput(bills, secOf(DEBTORS), null).input)).openingBills);
  });
});

describe('voucher type numbering ↔ accounts core', () => {
  it('a new type based on Sales starts its own series, exactly as the core does', () => {
    const sales = listVoucherTypes(t.db).rows.find((v) => v.isPredefined && v.baseType === 'sales');
    assert.ok(sales);
    saveVoucherType(t.ctx, { id: sales.id, numbering: { prefix: 'INV/', width: 4 } });
    const parent = getVoucherType(t.db, sales.id);
    const created = saveVoucherType(t.ctx, { name: 'Cash Sales', parentId: sales.id });
    assert.deepEqual(created.numbering, newTypeNumbering(parent.numbering));
    assert.equal(created.numbering.prefix, null);
  });
});

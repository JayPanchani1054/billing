/**
 * TDS main flow through the REAL runtime (createRuntime + runtime.dispatch, as Electron main does):
 *
 *   create company → F11 TDS on → TDS setup (TAN) → contractor + Contract Charges (194C) →
 *   purchase bill (TDS auto-line, party credited net) → outstanding (unpaid, due 7th) →
 *   challan payment (helper) → outstanding cleared → 26Q return data + CSV → Trial Balance balanced.
 *
 * Figures: Contract Charges ₹40,000 + CGST 9% ₹3,600 + SGST 9% ₹3,600 = ₹47,200 invoice;
 * 194C firm 2% × ₹40,000 = ₹800 TDS; Sharma Contractors credited ₹46,400.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { TdsNature, TdsOutstandingResult, TdsReturnData, TdsSettings } from '../../../shared/types/tds.ts';
import { makeGstin, TEST_PAN } from '../../testing/fixtures.ts';
import { P, startRuntime, type E2E } from '../../testing/e2e/harness.ts';

interface Row {
  id: number;
  name: string;
  [k: string]: unknown;
}

describe('TDS end to end (runtime.dispatch)', () => {
  let e: E2E;
  let contractor = 0;
  let expense = 0;
  let bank = 0;
  let purchaseType = 0;
  let billId = 0;

  before(() => {
    e = startRuntime('2026-05-20');
  });
  after(async () => {
    await e.close();
  });

  it('creates a GST company and turns TDS on (F11); TDS routes refuse before that', async () => {
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Sharma Builders E2E',
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: makeGstin('27'),
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: false, billWise: true, gst: true },
    });
    await e.fails('tds.settings.get', {}, 'BUSINESS_RULE', /F11/);
    const f = await e.call<{ tds: boolean; tcs: boolean }>('company.features.save', { tds: true });
    assert.equal(f.tds, true);
    assert.equal(f.tcs, false);
    const st = await e.call<TdsSettings>('tds.settings.save', {
      tan: 'MUMS12345A',
      deductorCategory: 'company',
      responsiblePerson: 'R. Sharma',
      responsibleDesignation: 'Director',
      buyer194Q: false,
      roundToRupee: true,
    });
    assert.equal(st.tan, 'MUMS12345A');
  });

  it('sets up the deductee and the 194C expense ledger', async () => {
    const groups = await e.call<{ rows: Row[] }>('accounts.group.list', {});
    const gid = (name: string): number => {
      const g = groups.rows.find((x) => x.name === name);
      assert.ok(g, name);
      return g.id;
    };
    contractor = (await e.call<Row>('accounts.ledger.save', { name: 'Sharma Contractors', groupId: gid('Sundry Creditors'), gstin: makeGstin('27', 'ABCFS1234C'), stateCode: '27', registrationType: 'regular' })).id;
    expense = (await e.call<Row>('accounts.ledger.save', { name: 'Contract Charges', groupId: gid('Direct Expenses'), gstApplicable: true, gstTaxability: 'taxable', gstRate: 18, hsnSac: '995411', gstSupplyType: 'services' })).id;
    bank = (await e.call<Row>('accounts.ledger.save', { name: 'HDFC Bank', groupId: gid('Bank Accounts') })).id;
    const natures = await e.call<TdsNature[]>('tds.natures.list', { kind: 'tds' });
    const c194 = natures.find((n) => n.section === '194C');
    assert.ok(c194);
    // Rates in force today (FY 2026-27): the FY 2025-26 row carries on.
    assert.deepEqual({ ind: c194.current?.rateIndividual, oth: c194.current?.rateOthers, single: c194.current?.thresholdSingle }, { ind: 1, oth: 2, single: P(30_000) });
    await e.fails('tds.ledgers.save', { ledgerId: contractor, applicable: true, deducteeType: 'firm', pan: 'ABCFS1234' }, 'VALIDATION', /not a valid PAN/);
    await e.call('tds.ledgers.save', { ledgerId: contractor, applicable: true, deducteeType: 'firm', pan: 'ABCFS1234C' });
    await e.call('tds.ledgers.save', { ledgerId: expense, applicable: true, natureId: c194.id });
    const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
    purchaseType = types.rows.find((t) => t.baseType === 'purchase' && t.isPredefined)?.id ?? 0;
  });

  it('a purchase bill gets the TDS auto-line: preview, then save', async () => {
    const input = {
      voucherTypeId: purchaseType,
      date: '2026-04-20',
      mode: 'accounting_invoice',
      partyLedgerId: contractor,
      referenceNo: 'SC/101',
      ledgers: [{ ledgerId: expense, amount: P(40_000) }],
    };
    const pv = await e.call<{ tds?: { tds: number; lines: Array<{ section: string; amount: number; note: string }> } }>('vouchers.preview', input);
    assert.equal(pv.tds?.tds, P(800));
    assert.equal(pv.tds?.lines[0].section, '194C');
    const saved = await e.call<{ id: number; totals: { grandTotal: number } }>('vouchers.save', { ...input, acknowledgeWarnings: true });
    billId = saved.id;
    assert.equal(saved.totals.grandTotal, P(47_200));
    const v = await e.call<{ entries: Array<{ ledgerName: string; amount: number }> }>('vouchers.get', { id: billId });
    const by = Object.fromEntries(v.entries.map((x) => [x.ledgerName, x.amount]));
    assert.equal(by['Sharma Contractors'], -P(46_400));
    assert.equal(by['TDS Payable – 194C'], -P(800));
  });

  it('outstanding shows ₹800 overdue (due 7-May) with interest; the challan clears it', async () => {
    const o = await e.call<TdsOutstandingResult>('tds.outstanding', { asOf: '2026-05-20', kind: 'tds' });
    assert.equal(o.rows.length, 1);
    // Deducted 20-Apr, unpaid on 20-May: April + May = 2 × 1.5% × ₹800 = ₹24.
    assert.deepEqual({ bal: o.rows[0].balance, due: o.rows[0].dueDate, status: o.rows[0].status, int: o.rows[0].interest }, { bal: P(800), due: '2026-05-07', status: 'overdue', int: P(24) });
    const sug = await e.call<{ unpaid: number; interest: number }>('tds.challan.suggest', { kind: 'tds', section: '194C', period: '2026-04', depositDate: '2026-05-20' });
    assert.deepEqual(sug, { ...sug, unpaid: P(800), interest: P(24) });
    await e.call('tds.challan.save', {
      date: '2026-05-20',
      bankLedgerId: bank,
      challan: { kind: 'tds', section: '194C', period: '2026-04', bsrCode: '0510001', challanNo: '00042', depositDate: '2026-05-20', tax: sug.unpaid, interest: sug.interest },
    });
    const after = await e.call<TdsOutstandingResult>('tds.outstanding', { asOf: '2026-05-20', kind: 'tds' });
    assert.equal(after.rows.length, 0);
    assert.equal(after.totals.balance, 0);
  });

  it('26Q Q1 data links the deduction to the challan; the CSV export works; the books balance', async () => {
    const d = await e.call<TdsReturnData>('tds.return.data', { form: '26Q', fyStart: 2026, quarter: 1 });
    assert.equal(d.tan, 'MUMS12345A');
    assert.equal(d.deductees.length, 1);
    assert.deepEqual(
      { sr: d.deductees[0].challanSr, pan: d.deductees[0].pan, paid: d.deductees[0].amountPaid, tax: d.deductees[0].tax, bsr: d.deductees[0].bsrCode },
      { sr: 1, pan: 'ABCFS1234C', paid: P(40_000), tax: P(800), bsr: '0510001' },
    );
    assert.equal(d.challans[0].interest, P(24));
    const csv = await e.call<{ content: string; fileName: string }>('tds.return.export', { form: '26Q', fyStart: 2026, quarter: 1, part: 'challans' });
    assert.match(csv.fileName, /^MUMS12345A_26Q_Q1_2026-27_challans\.csv$/);
    assert.match(csv.content, /1,194C,2026-04,0510001,20\/05\/2026,00042,200,800\.00/);
    const tb = await e.call<{ totals: { debit: number; credit: number } }>('reports.trialBalance', { from: '2026-04-01', to: '2026-05-20' });
    assert.equal(tb.totals.debit, tb.totals.credit);
  });
});

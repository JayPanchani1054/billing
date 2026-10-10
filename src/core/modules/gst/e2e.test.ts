/**
 * GST plus main flow through the REAL runtime (createRuntime + runtime.dispatch, as Electron main does):
 *
 *   create a GST company (Maharashtra) → advance receipt for services (GST details › advance) →
 *   purchase with ITC → sales invoice adjusting the advance (bill-wise) → Rule 42 reversal journal
 *   (stat adjustment) → GSTR-1 Table 11 and GSTR-3B 3.1(a) / 4(B)(1) → GST set-off (Rule 88A) →
 *   challan (PMT-06) → set-off journal → electronic cash / credit ledgers tie out and every GST account
 *   is squared off → a copy of the challan voucher does not carry its CPIN.
 *
 * Figures (all intra-state, CGST = SGST = half):
 *   Advance 11,800 incl. 18%  → taxable 10,000, CGST 900, SGST 900; adjusted on the invoice in the same
 *                               month, so May's Table 11A / 11B leave it out (the tax nets to nil anyway).
 *   Purchase 10,000 @18%      → Input CGST 900, SGST 900.
 *   Sale 20,000 @18%          → Output CGST 1,800, SGST 1,800 (the advance's 900 each reversed on it).
 *   Rule 42 reversal          → Input CGST 100, SGST 100 credited (4(B)(1)).
 *   Set-off: CGST 1,800 − credit (900 − 100) = 1,000 cash; SGST likewise 1,000 → challan 2,000.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ElectronicCashLedger, ElectronicCreditLedger, Gstr1AdvancesSummary, GstSetoffResult } from '../../../shared/types/gst-plus.ts';
import type { Gstr1Summary, Gstr3bSummary } from '../../../shared/types/gst-returns.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { makeGstin, TEST_PAN } from '../../testing/fixtures.ts';
import { P, startRuntime, type E2E } from '../../testing/e2e/harness.ts';

interface Row {
  id: number;
  name: string;
  [k: string]: unknown;
}

describe('GST plus end to end (runtime.dispatch)', () => {
  let e: E2E;
  const L: Record<string, number> = {};
  const VT: Record<string, number> = {};
  let challanId = 0;

  const ledgerId = async (name: string): Promise<number> => {
    const r = await e.call<{ rows: Row[] }>('accounts.ledger.list', { search: name, limit: 20 });
    const hit = r.rows.find((x) => x.name === name);
    assert.ok(hit, `ledger ${name}`);
    return hit.id;
  };
  const balance = async (name: string): Promise<number> => {
    const r = await e.call<{ closing: number }>('reports.ledger', { ledgerId: await ledgerId(name), from: '2026-04-01', to: '2026-06-30' });
    return r.closing;
  };
  const save = (input: VoucherInput) => e.call<{ id: number; number: string | null }>('vouchers.save', { ...input, acknowledgeWarnings: true });

  before(() => {
    e = startRuntime('2026-06-25');
  });
  after(async () => {
    await e.close();
  });

  it('creates the company and masters', async () => {
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Kulkarni Consultants E2E',
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: makeGstin('27'),
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: false, billWise: true, gst: true },
    });
    const groups = await e.call<{ rows: Row[] }>('accounts.group.list', {});
    const gid = (name: string): number => {
      const g = groups.rows.find((x) => x.name === name);
      assert.ok(g, name);
      return g.id;
    };
    L.acme = (await e.call<Row>('accounts.ledger.save', { name: 'Acme Industries', groupId: gid('Sundry Debtors'), billWise: true, gstin: makeGstin('27', 'AABCA1234C'), stateCode: '27', registrationType: 'regular' })).id;
    L.supplier = (await e.call<Row>('accounts.ledger.save', { name: 'Pune Advisors', groupId: gid('Sundry Creditors'), billWise: true, gstin: makeGstin('27', 'AABCP1234C'), stateCode: '27', registrationType: 'regular' })).id;
    L.consult = (await e.call<Row>('accounts.ledger.save', { name: 'Consulting Income', groupId: gid('Sales Accounts'), gstApplicable: true, gstTaxability: 'taxable', gstRate: 18, hsnSac: '998311', gstSupplyType: 'services' })).id;
    L.fees = (await e.call<Row>('accounts.ledger.save', { name: 'Professional Fees', groupId: gid('Indirect Expenses'), gstApplicable: true, gstTaxability: 'taxable', gstRate: 18, hsnSac: '998311', gstSupplyType: 'services', itcEligibility: 'input_services' })).id;
    L.reversal = (await e.call<Row>('accounts.ledger.save', { name: 'Common Credit Reversed', groupId: gid('Indirect Expenses') })).id;
    L.bank = (await e.call<Row>('accounts.ledger.save', { name: 'HDFC Bank', groupId: gid('Bank Accounts') })).id;
    const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
    for (const b of ['receipt', 'purchase', 'sales', 'journal']) VT[b] = types.rows.find((t) => t.baseType === b && t.isPredefined)?.id ?? 0;
  });

  it('posts tax on an advance for services and reverses it on the invoice (Table 11A / 11B)', async () => {
    await save({
      voucherTypeId: VT.receipt,
      date: '2026-05-05',
      mode: 'ledger',
      ledgers: [
        { ledgerId: L.bank, amount: P(11_800) },
        { ledgerId: L.acme, amount: -P(11_800), billAllocations: [{ refType: 'advance', billName: 'ADV-1', amount: P(11_800) }] },
      ],
      gstDetails: { advance: { supplyType: 'services', rate: 18 } },
    });
    assert.equal(await balance('GST on Advances Received'), P(1_800), 'Dr GST on Advances 1,800 / Cr Output CGST 900 + SGST 900');
    await save({ voucherTypeId: VT.purchase, date: '2026-05-08', mode: 'accounting_invoice', partyLedgerId: L.supplier, referenceNo: 'PA-17', ledgers: [{ ledgerId: L.fees, amount: P(10_000) }] });
    await save({
      voucherTypeId: VT.sales,
      date: '2026-05-20',
      mode: 'accounting_invoice',
      partyLedgerId: L.acme,
      ledgers: [{ ledgerId: L.consult, amount: P(20_000) }],
      partyBillAllocations: [
        { refType: 'against', billName: 'ADV-1', amount: P(11_800) },
        { refType: 'new', billName: 'INV-1', amount: P(11_800) },
      ],
    });
    assert.equal(await balance('GST on Advances Received'), 0, 'the advance tax is fully reversed by the invoice');

    // Up to 10 May the advance is unadjusted: 11A.
    const early = await e.call<Gstr1AdvancesSummary>('gst.advances.register', { from: '2026-05-01', to: '2026-05-10' });
    assert.deepEqual(early.received.map((x) => [x.pos, x.rate, x.taxable, x.cgst, x.sgst]), [['27', 18, P(10_000), P(900), P(900)]]);
    // Received and invoiced in the same return period (May): in neither 11A nor 11B (GSTR-1 instructions);
    // the register still lists both vouchers.
    const t11 = await e.call<Gstr1AdvancesSummary>('gst.advances.register', { from: '2026-05-01', to: '2026-05-31' });
    assert.deepEqual([t11.received, t11.adjusted], [[], []]);
    assert.deepEqual(t11.vouchers.map((x) => [x.kind, x.taxable]), [['received', P(10_000)], ['adjusted', P(10_000)]]);
    const g1 = await e.call<Gstr1Summary>('gst.gstr1.summary', { period: '052026' });
    assert.equal(g1.advances?.received.length, 0);
    assert.deepEqual(await e.call('gst.advances.pending', { asOf: '2026-05-31' }), []);
  });

  it('a Rule 42 stat adjustment journal reaches GSTR-3B 4(B)(1)', async () => {
    const inCgst = await ledgerId('Input CGST');
    const inSgst = await ledgerId('Input SGST/UTGST');
    await save({
      voucherTypeId: VT.journal,
      date: '2026-05-31',
      mode: 'ledger',
      ledgers: [
        { ledgerId: L.reversal, amount: P(200) },
        { ledgerId: inCgst, amount: -P(100) },
        { ledgerId: inSgst, amount: -P(100) },
      ],
      gstDetails: { adjustment: { nature: 'itc_reversal_r42' } },
    });
    const g3 = await e.call<Gstr3bSummary>('gst.gstr3b.summary', { period: '052026' });
    const osup = g3.supplies.find((x) => x.key === 'osup_det');
    // 3.1(a): invoice 20,000 / 1,800 / 1,800; the advance (11A) and its adjustment (11B) net to nil.
    assert.deepEqual([osup?.taxable, osup?.cgst, osup?.sgst], [P(20_000), P(1_800), P(1_800)]);
    assert.deepEqual([g3.bookAdjustments?.reversalRules.cgst, g3.bookAdjustments?.reversalRules.sgst], [P(100), P(100)]);
    assert.deepEqual([g3.itc.net.cgst, g3.itc.net.sgst], [P(800), P(800)]);
  });

  it('sets off credit first, records the challan, posts the set-off and the ledgers tie out', async () => {
    const s = await e.call<GstSetoffResult>('gst.setoff.compute', { period: '052026' });
    assert.deepEqual(s.credit, [
      { from: 'cgst', to: 'cgst', amount: P(800) },
      { from: 'sgst', to: 'sgst', amount: P(800) },
    ]);
    assert.equal(s.cashTotal, P(2_000));
    const challan = await e.call<{ id: number }>('gst.challan.post', {
      date: '2026-06-15',
      bankLedgerId: L.bank,
      cpin: '26052700098765',
      cin: 'HDFC2605270098765',
      challanDate: '2026-06-15',
      period: '052026',
      heads: [
        { head: 'cgst', minor: 'tax', amount: P(1_000) },
        { head: 'sgst', minor: 'tax', amount: P(1_000) },
      ],
    });
    challanId = challan.id;
    await e.call('gst.setoff.post', { period: '052026', date: '2026-06-20' });
    for (const name of ['Output CGST', 'Output SGST/UTGST', 'Input CGST', 'Input SGST/UTGST', 'GST Electronic Cash Ledger']) assert.equal(await balance(name), 0, name);

    const cash = await e.call<ElectronicCashLedger>('gst.ledger.cash', { from: '2026-05-01', to: '2026-06-30' });
    assert.deepEqual([cash.totals.deposited, cash.totals.utilised, cash.totals.closing, cash.booksBalance], [P(2_000), P(2_000), 0, 0]);
    const credit = await e.call<ElectronicCreditLedger>('gst.ledger.credit', { from: '2026-05-01', to: '2026-06-30' });
    const cg = credit.rows.find((r) => r.head === 'cgst');
    // CGST credit: 900 accrued − 100 reversed − 800 utilised = 0.
    assert.deepEqual([cg?.accrued, cg?.reversed, cg?.utilised, cg?.closing], [P(900), P(100), P(800), 0]);
  });

  it('a copy of the challan voucher does not carry the challan (one CPIN, one deposit)', async () => {
    const copy = await e.call<VoucherInput>('vouchers.duplicate', { id: challanId });
    assert.equal(copy.gstDetails, undefined);
  });
});

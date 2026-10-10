/**
 * Multi-currency main flow through the REAL runtime (createRuntime + runtime.dispatch):
 *
 *   company → F11 Multiple currencies on (Forex Gain/Loss ledger created) → US Dollar + rates →
 *   USD customer → export invoice under LUT ($2,000 @ ₹83.00 = ₹1,66,000) → GSTR-1 6A EXPWOP in INR →
 *   part receipt $1,200 @ ₹84.50 (gain ₹1,800 in the same voucher) → forex outstanding / ledger →
 *   period-end revaluation at ₹85.00 ($800 carried at ₹66,400 → ₹68,000: unrealised gain ₹1,600) →
 *   "Forex adjustment" journal → outstanding now at the closing rate → Trial Balance balanced.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ForexContext, ForexLedgerStatement, ForexOutstandingResult, ForexRevaluationPostResult, ForexRevaluationResult, ForexVoucherDetail } from '../../../shared/types/forex.ts';
import type { Gstr1Summary } from '../../../shared/types/gst-returns.ts';
import { makeGstin, TEST_PAN } from '../../testing/fixtures.ts';
import { P, startRuntime, type E2E } from '../../testing/e2e/harness.ts';

interface Row {
  id: number;
  name: string;
  [k: string]: unknown;
}

describe('Multi-currency end to end (runtime.dispatch)', () => {
  let e: E2E;
  let usd = 0;
  let customer = 0;
  let bank = 0;
  let exportSales = 0;
  const VT: Record<string, number> = {};
  let invoiceId = 0;

  before(() => {
    e = startRuntime('2026-06-30');
  });
  after(async () => {
    await e.close();
  });

  it('turns Multiple currencies on and sets up the masters', async () => {
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Kaveri Exports E2E',
      stateCode: '33',
      gstRegistrationType: 'regular',
      gstin: makeGstin('33'),
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: false, billWise: true, gst: true },
    });
    await e.fails('forex.outstanding', { asOf: '2026-06-30' }, 'BUSINESS_RULE', /Multiple currencies is turned off/);
    await e.call('company.features.save', { multiCurrency: true });
    await e.call('company.config.save', { gst: { lutNumber: 'AD330426000123X', lutValidFrom: '2026-04-01', lutValidTo: '2027-03-31' } });
    const ctx = await e.call<ForexContext>('forex.context', {});
    assert.equal(ctx.enabled, true);
    assert.equal(ctx.settings.gainLossLedger?.name, 'Forex Gain/Loss');

    usd = (await e.call<Row>('accounts.currency.save', { symbol: '$', formalName: 'US Dollar', isoCode: 'USD', decimalPlaces: 2 })).id;
    await e.call('accounts.exchangeRate.save', { currencyId: usd, date: '2026-05-01', standard: 83, selling: 83.4, buying: 82.6 });
    await e.call('accounts.exchangeRate.save', { currencyId: usd, date: '2026-06-30', standard: 85, selling: 85.4, buying: 84.6 });
    const groups = await e.call<{ rows: Row[] }>('accounts.group.list', {});
    const gid = (name: string): number => {
      const g = groups.rows.find((x) => x.name === name);
      assert.ok(g, name);
      return g.id;
    };
    customer = (
      await e.call<Row>('accounts.ledger.save', {
        name: 'Pacific Retail LLC',
        groupId: gid('Sundry Debtors'),
        registrationType: 'overseas',
        country: 'United States',
        billWise: true,
        currencyId: usd,
      })
    ).id;
    bank = (await e.call<Row>('accounts.ledger.save', { name: 'Indian Bank', groupId: gid('Bank Accounts') })).id;
    exportSales = (
      await e.call<Row>('accounts.ledger.save', { name: 'Export of Services', groupId: gid('Sales Accounts'), gstApplicable: true, gstTaxability: 'taxable', gstRate: 18, hsnSac: '998314', gstSupplyType: 'services' })
    ).id;
    const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
    for (const b of ['sales', 'receipt', 'journal']) VT[b] = (types.rows.find((t) => t.baseType === b && t.isPredefined) as { id: number }).id;
    const r = await e.call<{ rate: number; rateType: string }>('forex.rate.suggest', { currencyId: usd, date: '2026-05-20', baseType: 'sales' });
    assert.deepEqual([r.rate, r.rateType], [82.6, 'buying']);
  });

  it('posts an export invoice in USD; GSTR-1 reports it in INR under 6A (without payment)', async () => {
    const saved = await e.call<{ id: number; totals: { grandTotal: number } }>('vouchers.save', {
      voucherTypeId: VT.sales,
      date: '2026-05-20',
      mode: 'accounting_invoice',
      partyLedgerId: customer,
      placeOfSupply: '96',
      exportDetails: { withPayment: false, shippingBillNo: '7654321', shippingBillDate: '2026-05-21', portCode: 'INMAA1' },
      forex: { currencyId: usd, rate: 83, rateType: 'standard' },
      ledgers: [{ ledgerId: exportSales, amount: 0, forexAmount: 2000 }],
      acknowledgeWarnings: true,
    });
    invoiceId = saved.id;
    assert.equal(saved.totals.grandTotal, P(166_000));
    const fx = await e.call<ForexVoucherDetail>('forex.voucher', { id: invoiceId });
    assert.equal(fx.documentForex, 2000);
    assert.equal(fx.rate, 83);
    assert.deepEqual(fx.entries.map((x) => [x.ledgerName, x.forexAmount, x.amount]), [['Pacific Retail LLC', 2000, P(166_000)]]);
    const g1 = await e.call<Gstr1Summary>('gst.gstr1.summary', { period: '052026' });
    const exp = g1.sections.find((x) => x.id === 'exp_wop');
    assert.ok(exp);
    assert.equal(exp.count, 1);
    assert.equal(exp.taxable, P(166_000));
    assert.equal(exp.igst, 0);
  });

  it('a part receipt at ₹84.50 books the realised gain in the same voucher', async () => {
    // $1,200 × ₹84.50 = ₹1,01,400 received; carried 1200/2000 × ₹1,66,000 = ₹99,600 → gain ₹1,800.
    const preview = await e.call<{ forex: { gainLoss: number } }>('vouchers.preview', {
      voucherTypeId: VT.receipt,
      date: '2026-06-10',
      mode: 'ledger',
      ledgers: [
        { ledgerId: bank, amount: P(101_400) },
        { ledgerId: customer, amount: 0, forexAmount: -1200, exchangeRate: 84.5, billAllocations: [{ refType: 'against', billName: '1', amount: 0, forexAmount: 1200 }] },
      ],
    });
    assert.equal(preview.forex.gainLoss, -P(1_800));
    await e.call('vouchers.save', {
      voucherTypeId: VT.receipt,
      date: '2026-06-10',
      mode: 'ledger',
      ledgers: [
        { ledgerId: bank, amount: P(101_400) },
        { ledgerId: customer, amount: 0, forexAmount: -1200, exchangeRate: 84.5, billAllocations: [{ refType: 'against', billName: '1', amount: 0, forexAmount: 1200 }] },
      ],
    });
    const out = await e.call<ForexOutstandingResult>('forex.outstanding', { asOf: '2026-06-15', kind: 'receivable' });
    assert.equal(out.parties.length, 1);
    const p = out.parties[0];
    // Left: $800 carried at ₹66,400 (₹83). Closing rate on 15-Jun: standard ₹83 (row of 1-May).
    assert.deepEqual([p.forexBalance, p.inrBalance, p.bills[0].forexAmount, p.bills[0].amount, p.bills[0].bookedRate], [800, P(66_400), 800, P(66_400), 83]);
    const st = await e.call<ForexLedgerStatement>('forex.ledger', { ledgerId: customer, from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(
      st.rows.map((r) => [r.date, r.forexAmount, r.amount, r.forexBalance, r.inrBalance]),
      [
        ['2026-05-20', 2000, P(166_000), 2000, P(166_000)],
        ['2026-06-10', -1200, -P(99_600), 800, P(66_400)],
      ],
    );
    // At ₹85 on 30-Jun the $800 is worth ₹68,000: unrealised +₹1,600.
    assert.equal(st.unrealised, P(1_600));
  });

  it('revalues at the closing rate with a Forex adjustment journal', async () => {
    const rep = await e.call<ForexRevaluationResult>('forex.revaluation.report', { asOf: '2026-06-30' });
    assert.deepEqual(rep.lines.map((l) => [l.ledgerName, l.billName, l.forexAmount, l.bookedAmount, l.revaluedAmount, l.adjustment]), [
      ['Pacific Retail LLC', '1', 800, P(66_400), P(68_000), P(1_600)],
    ]);
    // The journal cannot be dated before the balances it restates (review fix).
    await e.fails('forex.revaluation.post', { asOf: '2026-06-30', date: '2026-06-29' }, 'VALIDATION', /cannot be before the revaluation date/);
    const posted = await e.call<ForexRevaluationPostResult>('forex.revaluation.post', { asOf: '2026-06-30' });
    assert.equal(posted.net, P(1_600));
    await e.fails('forex.revaluation.post', { asOf: '2026-06-30' }, 'BUSINESS_RULE', /already posted/);
    // The screen asks before posting again (withConfirmation): the refusal must carry needsConfirmation.
    const again = await e.raw('forex.revaluation.post', { asOf: '2026-06-30' });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal((again.error.details as { needsConfirmation?: boolean } | undefined)?.needsConfirmation, true);
    // Confirmed: nothing is left to restate, so it is refused for that reason instead (no empty journal).
    await e.fails('forex.revaluation.post', { asOf: '2026-06-30', allowRepeat: true }, 'BUSINESS_RULE', /Nothing to revalue/);
    const after = await e.call<ForexRevaluationResult>('forex.revaluation.report', { asOf: '2026-06-30' });
    assert.equal(after.lines.length, 0);
    assert.equal(after.posted.length, 1);
    const out = await e.call<ForexOutstandingResult>('forex.outstanding', { asOf: '2026-06-30' });
    assert.deepEqual([out.parties[0].inrBalance, out.parties[0].difference], [P(68_000), 0]);
    // Gain/loss ledger: −₹1,800 realised − ₹1,600 unrealised = ₹3,400 Cr. Books balance.
    const tb = await e.call<{ totals: { debit: number; credit: number } }>('reports.trialBalance', { from: '2026-04-01', to: '2026-06-30' });
    assert.equal(tb.totals.debit, tb.totals.credit);
    const v = await e.call<{ entries: Array<{ ledgerName: string; amount: number }> }>('vouchers.get', { id: posted.voucherId });
    assert.deepEqual(v.entries.map((x) => [x.ledgerName, x.amount]), [
      ['Pacific Retail LLC', P(1_600)],
      ['Forex Gain/Loss', -P(1_600)],
    ]);
    // Deleting the journal removes its revaluation record (ON DELETE CASCADE): the difference is back
    // and posting is no longer treated as a repeat.
    await e.call('vouchers.delete', { id: posted.voucherId, reason: 'wrong closing rate' });
    const undone = await e.call<ForexRevaluationResult>('forex.revaluation.report', { asOf: '2026-06-30' });
    assert.deepEqual([undone.posted.length, undone.net], [0, P(1_600)]);
  });
});

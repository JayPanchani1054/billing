/**
 * Forex settings, openings in the currency, revaluation (bank + payable), outstanding, routes access.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { forexRoutes } from './routes.ts';
import { forexOutstanding, forexRevaluation, postForexRevaluation } from './reports.ts';
import { getForexOpening, saveForexOpening, saveForexSettings, voucherForex } from './service.ts';
import { systemForexLedgerId } from './store.ts';
import { forexCompany } from './testkit.ts';
import { saveLedger } from '../accounts/ledgers.ts';

describe('forex settings', () => {
  it('only an income / expense rupee ledger without bill-wise can take exchange differences', () => {
    const f = forexCompany();
    const asset = f.t.addLedger({ name: 'Deposit', group: 'DEPOSITS_ASSET' });
    assert.throws(() => saveForexSettings(f.t.ctx, { gainLossLedgerId: asset }), (e: unknown) => e instanceof AppError && /not an income or expense/.test(e.message + JSON.stringify(e.details)));
    const income = f.t.addLedger({ name: 'Exchange Fluctuation', group: 'INDIRECT_INCOMES' });
    const s = saveForexSettings(f.t.ctx, { gainLossLedgerId: income });
    assert.equal(s.gainLossLedger?.name, 'Exchange Fluctuation');
    assert.equal(s.unrealisedLedger?.name, 'Exchange Fluctuation');
    // A settlement now posts there.
    f.save({ base: 'journal', date: '2026-05-01', mode: 'ledger', ledgers: [
      { ledgerId: f.customer, amount: 0, forexAmount: 100, exchangeRate: 80, billAllocations: [{ refType: 'new', billName: 'X1', amount: 0, forexAmount: 100 }] },
      { ledgerId: f.exportSales, amount: -800000 },
    ] });
    const r = f.save({ base: 'receipt', date: '2026-06-01', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 820000 },
      { ledgerId: f.customer, amount: 0, forexAmount: -100, exchangeRate: 82, billAllocations: [{ refType: 'against', billName: 'X1', amount: 0, forexAmount: 100 }] },
    ] });
    assert.deepEqual(f.entries(r.id).map((e) => [e.ledger_id, e.amount]), [[f.bank, 820000], [f.customer, -800000], [income, -20000]]);
    const d = voucherForex(f.t.db, r.id);
    assert.equal(d.gainLoss, -20000);
    assert.equal(d.gainLossLedger?.name, 'Exchange Fluctuation');
    assert.equal(d.entries[0].bills[0].forexAmount, -100);
  });
});

describe('opening balances in the currency', () => {
  it('opening bill in USD is settled with a realised difference', () => {
    const f = forexCompany();
    // Opening: $500 receivable carried at ₹41,000 (₹82).
    const led = f.t.addLedger({
      name: 'Old Overseas Buyer',
      group: 'SUNDRY_DEBTORS',
      registrationType: 'overseas',
      billWise: true,
      openingBalance: 4_100_000,
      openingBills: [{ name: 'OB-1', date: '2026-03-15', amount: 4_100_000 }],
      columns: { currency_id: f.usd },
    });
    assert.throws(() => saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: -500 }), /same side/);
    const o = saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 500, bills: [{ billName: 'OB-1', forexAmount: 500 }] });
    assert.deepEqual([o.openingForex, o.bills[0].forexAmount], [500, 500]);
    assert.equal(getForexOpening(f.t.db, led).openingForex, 500);
    // Received $500 at ₹84 = ₹42,000 → gain ₹1,000.
    const r = f.save({ base: 'receipt', date: '2026-05-05', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 4_200_000 },
      { ledgerId: led, amount: 0, forexAmount: -500, exchangeRate: 84, billAllocations: [{ refType: 'against', billName: 'OB-1', amount: 0, forexAmount: 500 }] },
    ] });
    assert.equal(f.entries(r.id).find((e) => e.ledger_id === systemForexLedgerId(f.t.db))?.amount, -100_000);
    const out = forexOutstanding(f.t.db, f.t.today, { asOf: '2026-05-31', ledgerId: led });
    assert.equal(out.parties.length, 0);
  });
});

describe('revaluation', () => {
  it('revalues an EEFC account and a payable; the journal posts and clears the differences', () => {
    const f = forexCompany();
    // EEFC: $1,000 received at ₹83 = ₹83,000 (on account from the customer).
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.eefc, amount: 0, forexAmount: 1000, exchangeRate: 83 },
      { ledgerId: f.customer, amount: 0, forexAmount: -1000, exchangeRate: 83 },
    ] });
    // Payable: $300 bill at ₹84 = ₹25,200.
    f.save({ base: 'journal', date: '2026-05-10', mode: 'ledger', ledgers: [
      { ledgerId: f.importPurchase, amount: 2_520_000 },
      { ledgerId: f.supplier, amount: 0, forexAmount: -300, exchangeRate: 84, billAllocations: [{ refType: 'new', billName: 'GX-9', amount: 0, forexAmount: 300 }] },
    ] });
    // Closing standard rate on 30-Jun: ₹85.
    // EEFC +$1,000: ₹85,000 − ₹83,000 = +₹2,000. Customer on account −$1,000: −₹85,000 − (−₹83,000) = −₹2,000.
    // Supplier −$300: −₹25,500 − (−₹25,200) = −₹300 (loss).
    const rep = forexRevaluation(f.t.db, f.t.today, { asOf: '2026-06-30' });
    assert.deepEqual(
      rep.lines.map((l) => [l.ledgerName, l.billName, l.forexAmount, l.adjustment]),
      [
        ['Acme Inc (USA)', null, -1000, -200_000],
        ['EEFC Account (USD)', null, 1000, 200_000],
        ['Globex GmbH', 'GX-9', -300, -30_000],
      ],
    );
    assert.equal(rep.net, -30_000);
    // A typed closing rate replaces the master's.
    const typed = forexRevaluation(f.t.db, f.t.today, { asOf: '2026-06-30', rates: [{ currencyId: f.usd, rate: 84 }] });
    assert.equal(typed.net, 0);
    assert.equal(typed.rates.find((r) => r.currencyId === f.usd)?.overridden, true);

    const posted = postForexRevaluation(f.t.ctx, { asOf: '2026-06-30' });
    assert.equal(posted.net, -30_000);
    const entries = f.entries(posted.voucherId);
    assert.equal(entries.reduce((a, e) => a + e.amount, 0), 0);
    // Bank line in a Journal is an exchange adjustment (forex 0), allowed.
    assert.deepEqual(entries.find((e) => e.ledger_id === f.eefc), { ledger_id: f.eefc, amount: 200_000, forex_amount: 0, exchange_rate: null, currency_id: f.usd });
    const after = forexRevaluation(f.t.db, f.t.today, { asOf: '2026-06-30' });
    assert.equal(after.lines.length, 0);
    // Paying the supplier $300 at ₹85 now realises nothing (carried at ₹25,500 after revaluation).
    const pay = f.save({ base: 'payment', date: '2026-06-30', mode: 'ledger', ledgers: [
      { ledgerId: f.supplier, amount: 0, forexAmount: 300, exchangeRate: 85, billAllocations: [{ refType: 'against', billName: 'GX-9', amount: 0, forexAmount: 300 }] },
      { ledgerId: f.bank, amount: -2_550_000 },
    ] });
    assert.equal(f.entries(pay.id).length, 2);
  });

  it('refuses without a rate, and posts nothing when balances are at the closing rate', () => {
    const f = forexCompany();
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 900_000 },
      { ledgerId: f.customer, amount: 0, forexAmount: -100, exchangeRate: 90 },
    ] });
    assert.throws(() => postForexRevaluation(f.t.ctx, { asOf: '2026-03-31' }), /Nothing to revalue/);
    const eurParty = f.t.addLedger({ name: 'Euro Client', group: 'SUNDRY_DEBTORS', columns: { currency_id: f.eur } });
    f.t.db.run('DELETE FROM exchange_rates WHERE currency_id = :c', { c: f.eur });
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 900_000 },
      { ledgerId: eurParty, amount: 0, forexAmount: -100, exchangeRate: 90 },
    ] });
    assert.throws(() => postForexRevaluation(f.t.ctx, { asOf: '2026-06-30' }), /No standard rate of exchange .* Euro/);
  });
});

describe('routes', () => {
  it('refuse with the feature off and enforce permissions', async () => {
    const off = forexCompany({ multiCurrency: false });
    const ctx = await off.t.callOk<{ enabled: boolean }>(forexRoutes, 'forex.context', {});
    assert.equal(ctx.enabled, false);
    const r = await off.t.call(forexRoutes, 'forex.outstanding', { asOf: '2026-06-30' });
    assert.equal(r.ok, false);
    const f = forexCompany();
    const denied = await f.t.call(forexRoutes, 'forex.settings.save', { revaluationRateType: 'buying' }, { session: f.t.sessionAs({ role: 'Data Entry' }) });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
    const ok = await f.t.callOk<{ revaluationRateType: string }>(forexRoutes, 'forex.settings.save', { revaluationRateType: 'buying' });
    assert.equal(ok.revaluationRateType, 'buying');
    const rate = await f.t.callOk<{ rate: number }>(forexRoutes, 'forex.rate.suggest', { currencyId: f.usd, date: '2026-06-30', baseType: 'payment' });
    assert.equal(rate.rate, 85.4);
  });
});

describe('ledger master', () => {
  it('the currency of a ledger with foreign-currency entries cannot be changed', () => {
    const f = forexCompany();
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 830_000 },
      { ledgerId: f.customer, amount: 0, forexAmount: -100, exchangeRate: 83 },
    ] });
    assert.throws(() => saveLedger(f.t.ctx, { id: f.customer, currencyId: f.eur }), (e: unknown) => e instanceof AppError && JSON.stringify(e.details).includes('cannot be changed'));
    // A ledger without such entries may change.
    const fresh = f.t.addLedger({ name: 'New Buyer', group: 'SUNDRY_DEBTORS', columns: { currency_id: f.usd } });
    assert.equal(saveLedger(f.t.ctx, { id: fresh, currencyId: f.eur }).currencyId, f.eur);
  });
});

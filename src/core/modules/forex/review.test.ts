/**
 * Forex adversarial-review regressions: each test fails if the defect it names comes back.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveExchangeRate } from '../accounts/currencies.ts';
import { saveLedger } from '../accounts/ledgers.ts';
import { AppError } from '../../lib/errors.ts';
import { loadReportEnv } from '../reports/engine.ts';
import { ledgerReport } from '../reports/ledger.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { forexPrintBlock } from './print.ts';
import { forexLedgerStatement, forexOutstanding, forexRevaluation, postForexRevaluation } from './reports.ts';
import { getForexOpening, saveForexOpening } from './service.ts';
import { pendingForexBills, systemForexLedgerId } from './store.ts';
import { forexCompany } from './testkit.ts';

const sum = (rows: Array<{ amount: number }>): number => rows.reduce((a, r) => a + r.amount, 0);

describe('forex review: probes', () => {
  it('altering a ledger with its opening bills keeps their foreign amounts', () => {
    const f = forexCompany();
    const led = f.t.addLedger({
      name: 'Old Buyer',
      group: 'SUNDRY_DEBTORS',
      registrationType: 'overseas',
      billWise: true,
      openingBalance: 4_100_000,
      openingBills: [{ name: 'OB-1', date: '2026-03-15', amount: 4_100_000 }],
      columns: { currency_id: f.usd },
    });
    saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 500, bills: [{ billName: 'OB-1', forexAmount: 500 }] });
    saveLedger(f.t.ctx, { id: led, stateCode: '96', openingBills: [{ billName: 'OB-1', billDate: '2026-03-15', dueDate: '2026-04-30', amount: 4_100_000 }] });
    const o = getForexOpening(f.t.db, led);
    assert.equal(o.openingForex, 500);
    assert.equal(o.bills[0].forexAmount, 500);
  });

  it('income / expense ledgers kept in a currency are not revalued (non-monetary)', () => {
    const f = forexCompany();
    const usdSales = f.t.addLedger({ name: 'Export Sales USD', group: 'SALES_ACCOUNTS', columns: { currency_id: f.usd } });
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 830_000 },
      { ledgerId: usdSales, amount: 0, forexAmount: -100, exchangeRate: 83 },
    ] });
    const rep = forexRevaluation(f.t.db, f.t.today, { asOf: '2026-06-30' });
    assert.deepEqual(rep.lines.map((l) => l.ledgerName), []);
  });

  it('item invoice with a discount under LUT: document value = Σ lines; print shows no tax', () => {
    const f = forexCompany();
    const item = f.t.addStockItem({ name: 'Valve', unit: 'Nos', gstRate: 18, hsnSac: '8481', openingQty: 100, openingRate: 500 });
    const r = f.save({
      base: 'sales', date: '2026-05-10', mode: 'item_invoice', partyLedgerId: f.customer, placeOfSupply: '96',
      exportDetails: { withPayment: false }, forex: { currencyId: f.usd, rate: 83.37 },
      items: [{ itemId: item, qty: 7, rate: 0, forexRate: 13.33, discountPct: 7.5 }],
    });
    const e = f.entries(r.id);
    assert.equal(sum(e), 0);
    const v = f.t.db.get<{ forex_amount: number }>('SELECT forex_amount FROM vouchers WHERE id = :id', { id: r.id });
    // 7 × 13.33 = 93.31; less 7.5% = 86.31175 → $86.31.
    assert.equal(v?.forex_amount, 86.31);
    const party = e.find((x) => x.ledger_id === f.customer);
    assert.equal(party?.forex_amount, 86.31);
  });

  it('a credit note (sales return) against an invoice at another rate realises the difference', () => {
    const f = forexCompany();
    f.save({
      base: 'sales', date: '2026-05-10', mode: 'accounting_invoice', partyLedgerId: f.customer, placeOfSupply: '96',
      exportDetails: { withPayment: false }, forex: { currencyId: f.usd, rate: 83 },
      ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 1000 }],
      partyBillAllocations: [{ refType: 'new', billName: 'INV-1', amount: 0, forexAmount: 1000 }],
    });
    const cn = f.save({
      base: 'credit_note', date: '2026-06-01', mode: 'accounting_invoice', partyLedgerId: f.customer, placeOfSupply: '96',
      exportDetails: { withPayment: false }, forex: { currencyId: f.usd, rate: 84 },
      ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 100 }],
      partyBillAllocations: [{ refType: 'against', billName: 'INV-1', amount: 0, forexAmount: 100 }],
    });
    const e = f.entries(cn.id);
    assert.equal(sum(e), 0);
    // $100 at ₹84 = ₹8,400 returned; booked ₹8,300 → gain ₹100 (Cr).
    assert.equal(e.find((x) => x.ledger_id === systemForexLedgerId(f.t.db))?.amount, -10_000);
    const pend = pendingForexBills(f.t.db, f.customer, '2026-06-30', f.t.today, 2);
    assert.deepEqual([pend[0].amount, pend[0].forexAmount], [7_470_000, 900]);
  });

  it('ledger in both currencies ties to the rupee ledger report; cancel restores the bill', () => {
    const f = forexCompany();
    f.save({
      base: 'sales', date: '2026-05-10', mode: 'accounting_invoice', partyLedgerId: f.customer, placeOfSupply: '96',
      exportDetails: { withPayment: false }, forex: { currencyId: f.usd, rate: 83 },
      ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 1000 }],
      partyBillAllocations: [{ refType: 'new', billName: 'INV-1', amount: 0, forexAmount: 1000 }],
    });
    const rc = f.save({ base: 'receipt', date: '2026-06-05', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 8_400_000 },
      { ledgerId: f.customer, amount: 0, forexAmount: -1000, exchangeRate: 84, billAllocations: [{ refType: 'against', billName: 'INV-1', amount: 0, forexAmount: 1000 }] },
    ] });
    const st = forexLedgerStatement(f.t.db, f.t.today, { ledgerId: f.customer, from: '2026-04-01', to: '2026-06-30' });
    const rl = ledgerReport(loadReportEnv(f.t.db, f.t.today), { ledgerId: f.customer, from: '2026-04-01', to: '2026-06-30' });
    assert.equal(st.closingInr, rl.closing);
    assert.equal(st.closingForex, 0);
    cancelVoucher(f.t.ctx, rc.id, 'wrong rate');
    const pend = pendingForexBills(f.t.db, f.customer, '2026-06-30', f.t.today, 2);
    assert.deepEqual([pend[0].amount, pend[0].forexAmount], [8_300_000, 1000]);
    const hdr = f.t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger_entries WHERE voucher_id = :id', { id: rc.id });
    assert.equal(hdr?.n, 0);
    const out = forexOutstanding(f.t.db, f.t.today, { asOf: '2026-06-30' });
    assert.equal(out.parties[0].inrBalance, 8_300_000);
  });

  it('revaluation journal cannot be dated before the as-of date', () => {
    const f = forexCompany();
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.eefc, amount: 0, forexAmount: 1000, exchangeRate: 83 },
      { ledgerId: f.bank, amount: -8_300_000 },
    ] });
    assert.throws(() => postForexRevaluation(f.t.ctx, { asOf: '2026-06-30', date: '2026-05-01' }), /date/i);
  });

  it('print block of a LUT invoice with discount shows zero tax', () => {
    const f = forexCompany();
    const item = f.t.addStockItem({ name: 'Valve', unit: 'Nos', gstRate: 18, hsnSac: '8481', openingQty: 100, openingRate: 500 });
    const r = f.save({
      base: 'sales', date: '2026-05-10', mode: 'item_invoice', partyLedgerId: f.customer, placeOfSupply: '96',
      exportDetails: { withPayment: false }, forex: { currencyId: f.usd, rate: 83.37 },
      items: [{ itemId: item, qty: 7, rate: 0, forexRate: 13.33, discountPct: 7.5 }],
    });
    const amount = f.t.db.value<number>('SELECT amount FROM inventory_entries WHERE voucher_id = :id', { id: r.id }) ?? 0;
    const block = forexPrintBlock(f.t.db, { id: r.id, layout: 'invoice', sample: false, lines: [{ rate: 13.33 * 83.37, amount }] as never, charges: [] });
    assert.ok(block);
    assert.equal(block.tax, 0);
    assert.equal(block.total, 86.31);
  });

  it('changing the currency of a ledger whose opening is entered in the currency is refused', () => {
    const f = forexCompany();
    const led = f.t.addLedger({
      name: 'Old Buyer',
      group: 'SUNDRY_DEBTORS',
      registrationType: 'overseas',
      openingBalance: 4_100_000,
      columns: { currency_id: f.usd },
    });
    saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 500 });
    assert.throws(
      () => saveLedger(f.t.ctx, { id: led, stateCode: '96', currencyId: f.eur }),
      (e: unknown) => e instanceof AppError && /opening balance of this ledger is entered in its foreign currency/.test(JSON.stringify(e.details)),
    );
    // A rupee opening balance moved to the other side drops the stale foreign opening.
    saveLedger(f.t.ctx, { id: led, stateCode: '96', openingBalance: -4_100_000 });
    assert.equal(getForexOpening(f.t.db, led).openingForex, 0);
  });

  it('preview before the gain/loss ledger exists: bills follow the entry (no bill-wise block), save posts the difference', () => {
    const f = forexCompany();
    f.save({
      base: 'sales', date: '2026-05-10', mode: 'accounting_invoice', partyLedgerId: f.customer, placeOfSupply: '96',
      exportDetails: { withPayment: false }, forex: { currencyId: f.usd, rate: 83 },
      ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 1000 }],
      partyBillAllocations: [{ refType: 'new', billName: 'INV-1', amount: 0, forexAmount: 1000 }],
    });
    // The system ledger is created by the first forex save (or F11); simulate a company without it yet.
    f.t.db.run('DELETE FROM ledgers WHERE id = :id', { id: systemForexLedgerId(f.t.db) ?? 0 });
    assert.equal(systemForexLedgerId(f.t.db), undefined);
    const input = { base: 'receipt' as const, date: '2026-06-05', mode: 'ledger' as const, ledgers: [
      { ledgerId: f.bank, amount: 8_400_000 },
      { ledgerId: f.customer, amount: 0, forexAmount: -1000, exchangeRate: 84, billAllocations: [{ refType: 'against' as const, billName: 'INV-1', amount: 0, forexAmount: 1000 }] },
    ] };
    const p = f.preview(input);
    assert.deepEqual(p.warnings.filter((w) => w.level === 'block').map((w) => w.message), []);
    assert.ok(p.warnings.some((w) => /will be posted to Forex Gain\/Loss/.test(w.message)));
    const r = f.save(input);
    assert.equal(f.entries(r.id).find((e) => e.ledger_id === systemForexLedgerId(f.t.db))?.amount, -100_000);
  });

  it('a typed rate for one currency does not let another currency go unrevalued', () => {
    const f = forexCompany();
    const eurParty = f.t.addLedger({ name: 'Euro Client', group: 'SUNDRY_DEBTORS', columns: { currency_id: f.eur } });
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.eefc, amount: 0, forexAmount: 1000, exchangeRate: 83 },
      { ledgerId: f.bank, amount: -8_300_000 },
    ] });
    f.save({ base: 'receipt', date: '2026-05-02', mode: 'ledger', ledgers: [
      { ledgerId: f.bank, amount: 900_000 },
      { ledgerId: eurParty, amount: 0, forexAmount: -100, exchangeRate: 90 },
    ] });
    f.t.db.run('DELETE FROM exchange_rates WHERE currency_id = :c', { c: f.eur });
    assert.throws(() => postForexRevaluation(f.t.ctx, { asOf: '2026-06-30', rates: [{ currencyId: f.usd, rate: 86 }] }), /No standard rate of exchange .* Euro/);
    const rep = forexRevaluation(f.t.db, f.t.today, { asOf: '2026-06-30', rates: [{ currencyId: f.usd, rate: 86 }] });
    // The master rate stays visible next to a typed one.
    const usdRate = rep.rates.find((r) => r.currencyId === f.usd);
    assert.deepEqual([usdRate?.rate, usdRate?.overridden, usdRate?.masterRate, usdRate?.masterDate], [86, true, 85, '2026-06-30']);
    saveExchangeRate(f.t.ctx, { currencyId: f.eur, date: '2026-06-30', standard: 91 });
    const ok = postForexRevaluation(f.t.ctx, { asOf: '2026-06-30', rates: [{ currencyId: f.usd, rate: 86 }] });
    // EEFC +$1,000: ₹86,000 − ₹83,000 = +₹3,000; Euro client −€100: −₹9,100 − (−₹9,000) = −₹100.
    assert.equal(ok.net, 290_000);
  });
});

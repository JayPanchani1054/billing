/**
 * Forex voucher hook: foreign-currency invoices, settlements at another rate (realised gain / loss in the
 * same voucher), ledger-mode lines, rules. Hand-verified figures in the comments.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { deleteVoucher } from '../vouchers/service.ts';
import { pendingBills } from '../vouchers/bills.ts';
import { forexCompany } from './testkit.ts';
import { pendingForexBills, systemForexLedgerId } from './store.ts';

const sum = (rows: Array<{ amount: number }>): number => rows.reduce((a, r) => a + r.amount, 0);

function expectValidation(fn: () => unknown, path: string, re: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof AppError, String(e));
    assert.equal(e.code, 'VALIDATION');
    const issues = e.details as Array<{ path: string; message: string }>;
    assert.equal(issues[0].path, path);
    assert.match(issues[0].message, re);
    return true;
  });
}

describe('forex: export invoice and settlement', () => {
  const f = forexCompany();
  let invoiceId = 0;

  it('posts an export invoice (LUT) in USD: INR at the rate, party carries $', () => {
    // 10 hours × $100 = $1,000 at ₹83.25 = ₹83,250.00 (8325000 paise). Export under LUT: no tax.
    const r = f.save({
      base: 'sales',
      date: '2026-05-10',
      mode: 'accounting_invoice',
      partyLedgerId: f.customer,
      placeOfSupply: '96',
      exportDetails: { withPayment: false, shippingBillNo: 'SB123', portCode: 'INBOM4' },
      forex: { currencyId: f.usd, rate: 83.25 },
      ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 1000 }],
    });
    invoiceId = r.id;
    const e = f.entries(r.id);
    assert.equal(sum(e), 0);
    const party = e.find((x) => x.ledger_id === f.customer);
    assert.ok(party);
    assert.equal(party.amount, 8325000);
    assert.equal(party.forex_amount, 1000);
    assert.equal(party.exchange_rate, 83.25);
    assert.equal(party.currency_id, f.usd);
    const sales = e.find((x) => x.ledger_id === f.exportSales);
    assert.equal(sales?.amount, -8325000);
    assert.equal(sales?.forex_amount, null);
    const b = f.bills(r.id);
    assert.equal(b.length, 1);
    assert.equal(b[0].ref_type, 'new');
    assert.equal(b[0].amount, 8325000);
    assert.equal(b[0].forex_amount, 1000);
    const v = f.t.db.get<{ currency_id: number; exchange_rate: number; forex_amount: number; gst_nature: string; export_details: string }>(
      'SELECT currency_id, exchange_rate, forex_amount, gst_nature, export_details FROM vouchers WHERE id = :id',
      { id: r.id },
    );
    assert.equal(v?.currency_id, f.usd);
    assert.equal(v?.forex_amount, 1000);
    assert.equal(v?.gst_nature, 'export_lut');
    assert.equal(JSON.parse(v?.export_details ?? '{}').currency, 'USD');
    // GST lines in INR (GSTR-1 EXPWOP).
    const g = f.t.db.get<{ taxable_value: number; igst: number }>('SELECT taxable_value, igst FROM gst_lines WHERE voucher_id = :id', { id: r.id });
    assert.deepEqual(g, { taxable_value: 8325000, igst: 0 });
  });

  it('a receipt at a higher rate books the realised gain in the same voucher', () => {
    // $600 received at ₹84.00 = ₹50,400. The bill carries 600/1000 × ₹83,250 = ₹49,950.
    // Gain = ₹450 (Cr Forex Gain/Loss). Party credited ₹49,950; bill left: $400 / ₹33,300.
    const p = f.preview({
      base: 'receipt',
      date: '2026-06-05',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.bank, amount: 5040000 },
        { ledgerId: f.customer, amount: 0, forexAmount: -600, exchangeRate: 84, billAllocations: [{ refType: 'against', billName: '1', amount: 0, forexAmount: 600 }] },
      ],
    });
    assert.ok(p.forex);
    assert.equal(p.forex.gainLoss, -45000);
    assert.equal(p.forex.realised[0].bookedAmount, 4995000);
    assert.equal(p.forex.realised[0].settledAmount, 5040000);
    assert.equal(p.warnings.filter((w) => w.level !== 'info').length, 0, JSON.stringify(p.warnings));
    const r = f.save({
      base: 'receipt',
      date: '2026-06-05',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.bank, amount: 5040000 },
        { ledgerId: f.customer, amount: 0, forexAmount: -600, exchangeRate: 84, billAllocations: [{ refType: 'against', billName: '1', amount: 0, forexAmount: 600 }] },
      ],
    });
    const e = f.entries(r.id);
    assert.equal(sum(e), 0);
    const gl = systemForexLedgerId(f.t.db);
    assert.ok(gl, 'Forex Gain/Loss ledger created');
    assert.deepEqual(
      e.map((x) => [x.ledger_id, x.amount, x.forex_amount]),
      [
        [f.bank, 5040000, null],
        [f.customer, -4995000, -600],
        [gl, -45000, null],
      ],
    );
    const pend = pendingForexBills(f.t.db, f.customer, '2026-06-30', f.t.today, 2);
    assert.equal(pend.length, 1);
    assert.equal(pend[0].amount, 3330000);
    assert.equal(pend[0].forexAmount, 400);
    assert.equal(pend[0].bookedRate, 83.25);
  });

  it('settling the rest at a lower rate books a loss and clears the bill in both currencies', () => {
    // $400 at ₹82.50 = ₹33,000 against ₹33,300 carried → loss ₹300 (Dr).
    const r = f.save({
      base: 'receipt',
      date: '2026-06-20',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.bank, amount: 3300000 },
        { ledgerId: f.customer, amount: 0, forexAmount: -400, exchangeRate: 82.5, billAllocations: [{ refType: 'against', billName: '1', amount: 0, forexAmount: 400 }] },
      ],
    });
    const e = f.entries(r.id);
    assert.equal(sum(e), 0);
    assert.equal(e.find((x) => x.ledger_id === f.customer)?.amount, -3330000);
    assert.equal(e.find((x) => x.ledger_id === systemForexLedgerId(f.t.db))?.amount, 30000);
    assert.equal(pendingForexBills(f.t.db, f.customer, '2026-06-30', f.t.today, 2).length, 0);
    assert.equal(pendingBills(f.t.db, f.customer, '2026-06-30', f.t.today).length, 0);
    // Party ledger: ₹83,250 − ₹49,950 − ₹33,300 = 0. Gain/loss ledger: −₹450 + ₹300 = −₹150 (net gain).
    const bal = f.t.db.value<number>('SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = :l', { l: f.customer });
    assert.equal(bal, 0);
    const gl = f.t.db.value<number>('SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = :l', { l: systemForexLedgerId(f.t.db) as number });
    assert.equal(gl, -15000);
    // Deleting the settlement brings the bill back with its booked INR.
    deleteVoucher(f.t.ctx, r.id);
    const pend = pendingForexBills(f.t.db, f.customer, '2026-06-30', f.t.today, 2);
    assert.deepEqual([pend[0].amount, pend[0].forexAmount], [3330000, 400]);
    assert.ok(invoiceId > 0);
  });
});

describe('forex: invoice with IGST, purchases, rules', () => {
  it('export with payment of IGST: party $ = lines + IGST at the rate; GST stays in INR', () => {
    const f = forexCompany();
    // $500 at ₹84 = ₹42,000; IGST 18% = ₹7,560 → invoice ₹49,560; party $500 + 7560/84 = $590.00.
    const r = f.save({
      base: 'sales',
      date: '2026-05-10',
      mode: 'accounting_invoice',
      partyLedgerId: f.customer,
      placeOfSupply: '96',
      exportDetails: { withPayment: true },
      forex: { currencyId: f.usd, rate: 84 },
      ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 500 }],
    });
    const party = f.entries(r.id).find((x) => x.ledger_id === f.customer);
    assert.equal(party?.amount, 4956000);
    assert.equal(party?.forex_amount, 590);
    const g = f.t.db.get<{ taxable_value: number; igst: number }>('SELECT taxable_value, igst FROM gst_lines WHERE voucher_id = :id', { id: r.id });
    assert.deepEqual(g, { taxable_value: 4200000, igst: 756000 });
  });

  it('item invoice: rates in the currency, INR rate derived, value to the paisa', () => {
    const f = forexCompany();
    const item = f.t.addStockItem({ name: 'Brass Fittings', unit: 'Nos', gstRate: 18, hsnSac: '7412', openingQty: 100, openingRate: 500 });
    // 3 × $1.005 = $3.015 → $3.02 (2 decimals) at ₹83 = ₹250.66 (25066 paise).
    const r = f.save({
      base: 'sales',
      date: '2026-05-10',
      mode: 'item_invoice',
      partyLedgerId: f.customer,
      placeOfSupply: '96',
      exportDetails: { withPayment: false },
      forex: { currencyId: f.usd, rate: 83 },
      items: [{ itemId: item, qty: 3, rate: 0, forexRate: 1.005 }],
    });
    const party = f.entries(r.id).find((x) => x.ledger_id === f.customer);
    assert.equal(party?.amount, 25066);
    assert.equal(party?.forex_amount, 3.02);
    const inv = f.t.db.get<{ rate: number; amount: number }>('SELECT rate, amount FROM inventory_entries WHERE voucher_id = :id', { id: r.id });
    assert.equal(inv?.amount, 25066);
    assert.equal(inv?.rate, 83.415);
  });

  it('a payment without a typed rate takes the master selling rate; partial against with two bills', () => {
    const f = forexCompany();
    // Two import bills: $200 at ₹83.50 = ₹16,700 and $300 at ₹84.00 = ₹25,200.
    const mk = (ref: string, usd: number, rate: number) =>
      f.save({
        base: 'journal',
        date: '2026-05-01',
        mode: 'ledger',
        ledgers: [
          { ledgerId: f.importPurchase, amount: Math.round(usd * rate * 100) },
          { ledgerId: f.supplier, amount: 0, forexAmount: -usd, exchangeRate: rate, billAllocations: [{ refType: 'new', billName: ref, amount: 0, forexAmount: usd }] },
        ],
      });
    mk('G-1', 200, 83.5);
    mk('G-2', 300, 84);
    // Pay $500 on 30-Jun (no rate typed → master selling rate ₹85.40) = ₹42,700.
    // Booked ₹16,700 + ₹25,200 = ₹41,900 → loss ₹800 (Dr).
    const r = f.save({
      base: 'payment',
      date: '2026-06-30',
      mode: 'ledger',
      ledgers: [
        {
          ledgerId: f.supplier,
          amount: 0,
          forexAmount: 500,
          billAllocations: [
            { refType: 'against', billName: 'G-1', amount: 0, forexAmount: 200 },
            { refType: 'against', billName: 'G-2', amount: 0, forexAmount: 300 },
          ],
        },
        { ledgerId: f.bank, amount: -4270000 },
      ],
    });
    const e = f.entries(r.id);
    assert.equal(sum(e), 0);
    const sup = e.find((x) => x.ledger_id === f.supplier);
    assert.equal(sup?.exchange_rate, 85.4);
    assert.equal(sup?.amount, 4190000);
    assert.equal(e.find((x) => x.ledger_id === systemForexLedgerId(f.t.db))?.amount, 80000);
    assert.deepEqual(
      f.bills(r.id).map((b) => [b.bill_name, b.amount, b.forex_amount]),
      [
        ['G-1', 1670000, 200],
        ['G-2', 2520000, 300],
      ],
    );
  });

  it('EEFC transfer: both lines in USD at different rates is an ordinary exchange (no bill, no gain)', () => {
    const f = forexCompany();
    // Receipt into the EEFC account: $1,000 at ₹84 Dr; customer on account $1,000 at ₹84 Cr.
    const r = f.save({
      base: 'receipt',
      date: '2026-06-01',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.eefc, amount: 0, forexAmount: 1000, exchangeRate: 84 },
        { ledgerId: f.customer, amount: 0, forexAmount: -1000, exchangeRate: 84 },
      ],
    });
    const e = f.entries(r.id);
    assert.deepEqual(e.map((x) => [x.amount, x.forex_amount]), [
      [8400000, 1000],
      [-8400000, -1000],
    ]);
    assert.deepEqual(f.bills(r.id).map((b) => [b.ref_type, b.forex_amount]), [['on_account', -1000]]);
  });

  it('rules: forex ledger without a foreign amount, rupee party with a currency, feature off', () => {
    const f = forexCompany();
    expectValidation(
      () => f.preview({ base: 'receipt', date: '2026-06-01', mode: 'ledger', ledgers: [{ ledgerId: f.bank, amount: 100 }, { ledgerId: f.customer, amount: -100 }] }),
      'ledgers[1].forexAmount',
      /kept in US Dollar/,
    );
    const inr = f.t.addLedger({ name: 'Local Buyer', group: 'SUNDRY_DEBTORS' });
    expectValidation(
      () =>
        f.preview({
          base: 'sales',
          date: '2026-06-01',
          mode: 'accounting_invoice',
          partyLedgerId: inr,
          forex: { currencyId: f.usd, rate: 84 },
          ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 10 }],
        }),
      'forex.currencyId',
      /kept in rupees/,
    );
    expectValidation(
      () => f.preview({ base: 'sales', date: '2026-06-01', mode: 'accounting_invoice', partyLedgerId: f.customer, ledgers: [{ ledgerId: f.exportSales, amount: 1000 }] }),
      'forex',
      /enter the invoice in \$/,
    );
    expectValidation(
      () =>
        f.preview({
          base: 'sales',
          date: '2026-06-01',
          mode: 'accounting_invoice',
          partyLedgerId: f.customer,
          forex: { currencyId: f.eur, rate: 90 },
          ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 10 }],
        }),
      'forex.currencyId',
      /this invoice is in Euro/,
    );
    const off = forexCompany({ multiCurrency: false });
    expectValidation(
      () => off.preview({ base: 'receipt', date: '2026-06-01', mode: 'ledger', ledgers: [{ ledgerId: off.bank, amount: 8400 }, { ledgerId: off.customer, amount: -8400, forexAmount: -1, exchangeRate: 84 }] }),
      'ledgers[1].forexAmount',
      /turned off/,
    );
    // Feature off: the ledger's currency is ignored (books in INR as before).
    const ok = off.save({ base: 'receipt', date: '2026-06-01', mode: 'ledger', ledgers: [{ ledgerId: off.bank, amount: 8400 }, { ledgerId: off.customer, amount: -8400 }] });
    assert.equal(off.entries(ok.id)[1].forex_amount, null);
  });

  it('bill-wise foreign amounts must add up to the line', () => {
    const f = forexCompany();
    const p = f.preview({
      base: 'receipt',
      date: '2026-06-01',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.bank, amount: 8400000 },
        { ledgerId: f.customer, amount: 0, forexAmount: -1000, exchangeRate: 84, billAllocations: [{ refType: 'advance', billName: 'ADV-1', amount: 0, forexAmount: 900 }] },
      ],
    });
    const w = p.warnings.find((x) => x.code === 'forex' && x.level === 'block');
    assert.ok(w, JSON.stringify(p.warnings));
    assert.match(w.message, /total \$ 900\.00 but its amount is \$ 1,000\.00/);
  });

  it('an INR-only exchange adjustment (forex 0) moves rupees without touching the foreign balance', () => {
    const f = forexCompany();
    const inv = f.save({
      base: 'sales',
      date: '2026-05-10',
      mode: 'accounting_invoice',
      partyLedgerId: f.customer,
      placeOfSupply: '96',
      exportDetails: { withPayment: false },
      forex: { currencyId: f.usd, rate: 83 },
      ledgers: [{ ledgerId: f.exportSales, amount: 0, forexAmount: 100 }],
    });
    assert.ok(inv.id);
    const gl = f.t.db.value<number>("SELECT id FROM ledgers WHERE reserved_code = 'FOREX_GAIN_LOSS'") as number;
    // Revalue the bill to ₹85: +₹200 on the receivable.
    f.save({
      base: 'journal',
      date: '2026-06-30',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.customer, amount: 20000, forexAmount: 0, billAllocations: [{ refType: 'against', billName: '1', amount: 20000 }] },
        { ledgerId: gl, amount: -20000 },
      ],
    });
    const pend = pendingForexBills(f.t.db, f.customer, '2026-06-30', f.t.today, 2);
    assert.deepEqual([pend[0].amount, pend[0].forexAmount, pend[0].bookedRate], [850000, 100, 85]);
  });
});

/**
 * Regression tests of the final-wave gap fixes in the tds module (each fails if its defect returns).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveFeatures } from '../company/service.ts';
import { forexCompany } from '../forex/testkit.ts';
import { saveLedgerDetails, saveSettings } from './masters.ts';
import { getTdsSettings } from './store.ts';
import { entries, journal, purchase, save, setupTds, tdsLines } from './testkit.ts';
import { tdsRoutes } from './routes.ts';
import type { TdsOutstandingResult } from '../../../shared/types/tds.ts';

describe('s.195 TDS on a foreign-currency bill', () => {
  it('the supplier is credited in USD net of the tax, the bill-wise USD follows, and paying it settles the bill exactly', () => {
    const f = forexCompany();
    saveFeatures(f.t.ctx, { tds: true });
    const n195 = f.t.db.value<number>(`SELECT id FROM tds_natures WHERE kind = 'tds' AND section = '195'`)!;
    saveLedgerDetails(f.t.ctx, { ledgerId: f.importPurchase, applicable: true, natureId: n195 });
    saveLedgerDetails(f.t.ctx, { ledgerId: f.supplier, applicable: true, deducteeType: 'company', nonResident: true });
    // Bill: $1,000 at ₹83 = ₹83,000. TDS u/s 195 @ 20% = ₹16,600 → the supplier is owed ₹66,400 = $800.
    const bill = f.save({
      base: 'journal',
      date: '2026-05-01',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.importPurchase, amount: 83_000_00 },
        { ledgerId: f.supplier, amount: 0, forexAmount: -1000, exchangeRate: 83, billAllocations: [{ refType: 'new', billName: 'GX-1', amount: 0, forexAmount: 1000 }] },
      ],
    });
    const e = f.entries(bill.id);
    const sup = e.find((x) => x.ledger_id === f.supplier)!;
    assert.deepEqual([sup.amount, sup.forex_amount], [-66_400_00, -800]);
    const tds = f.t.db.get<{ amount: number; base: number }>('SELECT amount, base FROM tds_lines WHERE voucher_id = :id', { id: bill.id })!;
    assert.deepEqual([tds.amount, tds.base], [16_600_00, 83_000_00]);
    // The bill typed for $1,000 gross now holds $800 / ₹66,400 (net of the tax).
    assert.deepEqual(f.bills(bill.id).map((b) => [b.bill_name, b.amount, b.forex_amount]), [['GX-1', -66_400_00, -800]]);
    // Pay the $800 on 30-Jun at ₹85 = ₹68,000 → the bill booked at ₹66,400 is settled; ₹1,600 realised loss.
    const pay = f.save({
      base: 'payment',
      date: '2026-06-30',
      mode: 'ledger',
      ledgers: [
        { ledgerId: f.supplier, amount: 0, forexAmount: 800, exchangeRate: 85, billAllocations: [{ refType: 'against', billName: 'GX-1', amount: 0, forexAmount: 800 }] },
        { ledgerId: f.bank, amount: -68_000_00 },
      ],
    });
    assert.equal(f.entries(pay.id).find((x) => x.ledger_id === f.supplier)?.amount, 66_400_00);
    const bal = f.t.db.get<{ inr: number; fx: number }>('SELECT SUM(amount) AS inr, SUM(forex_amount) AS fx FROM ledger_entries WHERE ledger_id = :id', { id: f.supplier })!;
    assert.deepEqual([bal.inr, bal.fx], [0, 0], 'the supplier is square in both currencies');
    const pending = f.t.db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM bill_allocations WHERE ledger_id = :id AND bill_name = 'GX-1'`, { id: f.supplier });
    assert.equal(pending, 0);
    f.t.close();
  });
});

describe('194T is deducted by firms only', () => {
  it('a company paying a partner-like deductee deducts nothing under 194T (info); a firm deducts 10%', () => {
    const k = setupTds();
    const n194T = k.t.db.value<number>(`SELECT id FROM tds_natures WHERE section = '194T'`)!;
    const cap = k.t.addLedger({ name: 'Partner A Capital', group: 'CAPITAL_ACCOUNT', pan: 'ABCPA1111A' });
    const rem = k.t.addLedger({ name: 'Partner Remuneration', group: 'INDIRECT_EXPENSES' });
    saveLedgerDetails(k.t.ctx, { ledgerId: rem, applicable: true, natureId: n194T });
    saveLedgerDetails(k.t.ctx, { ledgerId: cap, applicable: true, deducteeType: 'individual', natureId: n194T });
    // Default deductor category: company → no 194T.
    const r1 = save(k, journal(k, '2026-06-30', rem, cap, 1_00_000_00));
    assert.equal(entries(k, r1.id)['TDS Payable – 194T'], undefined);
    assert.ok(r1.warnings?.some((w) => /194T applies only when a firm/.test(w.message)));
    // A firm deducts: ₹1,00,000 × 10% = ₹10,000.
    saveSettings(k.t.ctx, { ...getTdsSettings(k.t.db), deductorCategory: 'firm' });
    const r2 = save(k, journal(k, '2026-06-30', rem, cap, 1_00_000_00));
    assert.equal(entries(k, r2.id)['TDS Payable – 194T'], -10_000_00);
    k.t.close();
  });
});

describe('Debit / credit notes reverse TDS / TCS in proportion', () => {
  it('a debit note against a contractor bill with TDS reverses 10% of it; the outstanding nets it', async () => {
    const k = setupTds();
    // Bill: Contract Charges ₹1,00,000 + GST 18% = ₹1,18,000; TDS 194C @ 2% (firm) on ₹1,00,000 = ₹2,000.
    const bill = save(k, purchase(k, '2026-06-05', k.L.contractor, k.L.contractExp, 1_00_000_00, 'SC-1'));
    assert.equal(entries(k, bill.id)['TDS Payable – 194C'], -2_000_00);
    // Debit note ₹10,000 + GST ₹1,800 against SC-1 → reverse 2,000 × 10,000 ÷ 1,00,000 = ₹200.
    const note = save(k, {
      voucherTypeId: k.vt.debit_note,
      date: '2026-06-10',
      mode: 'accounting_invoice',
      partyLedgerId: k.L.contractor,
      originalInvoiceNo: 'SC-1',
      originalInvoiceDate: '2026-06-05',
      ledgers: [{ ledgerId: k.L.contractExp, amount: 10_000_00 }],
      partyBillAllocations: [{ refType: 'against', billName: 'SC-1', amount: 11_800_00 }],
    });
    const e = entries(k, note.id);
    // Dr party 11,800 − 200 = 11,600; Dr TDS Payable 200; Cr expense 10,000; Cr input GST 1,800.
    assert.equal(e['Sharma Contractors'], 11_600_00);
    assert.equal(e['TDS Payable – 194C'], 200_00);
    const lines = tdsLines(k, note.id);
    assert.deepEqual(lines.map((l) => [l.section, l.amount, l.base]), [['194C', -200_00, -10_000_00]]);
    // The bill's tax to deposit is now ₹1,800.
    const os = await k.t.callOk<TdsOutstandingResult>(tdsRoutes, 'tds.outstanding', { asOf: '2026-06-30', kind: 'tds' });
    assert.equal(os.rows.reduce((a, r) => a + r.deducted, 0), 1_800_00);
    // A second note for the remaining ₹90,000 can never reverse more than is left (₹1,800).
    const note2 = save(k, {
      voucherTypeId: k.vt.debit_note, date: '2026-06-12', mode: 'accounting_invoice', partyLedgerId: k.L.contractor, originalInvoiceNo: 'SC-1',
      ledgers: [{ ledgerId: k.L.contractExp, amount: 95_000_00 }],
    });
    assert.equal(tdsLines(k, note2.id)[0].amount, -1_800_00);
    k.t.close();
  });

  it('a credit note against a sale with TCS reverses it in proportion; the customer is credited the TCS too', () => {
    const k = setupTds();
    // Sale of scrap ₹1,00,000 + GST 18%; TCS 206C(1) at 1% on the invoice value incl. GST = ₹1,180.
    const sale = save(k, { voucherTypeId: k.vt.sales, date: '2026-06-05', mode: 'accounting_invoice', partyLedgerId: k.L.buyer, ledgers: [{ ledgerId: k.L.scrapSales, amount: 1_00_000_00 }] });
    const tcs = tdsLines(k, sale.id)[0];
    assert.ok(tcs.amount > 0);
    const saleNo = k.t.db.value<string>('SELECT number FROM vouchers WHERE id = :id', { id: sale.id })!;
    // Credit note ₹10,000 + GST: 10% of the sale → 10% of the TCS.
    const cn = save(k, {
      voucherTypeId: k.vt.credit_note, date: '2026-06-10', mode: 'accounting_invoice', partyLedgerId: k.L.buyer,
      originalInvoiceNo: saleNo, originalInvoiceDate: '2026-06-05',
      ledgers: [{ ledgerId: k.L.scrapSales, amount: 10_000_00 }],
    });
    const rev = Math.round(tcs.amount / 10);
    const e = entries(k, cn.id);
    const payableName = k.t.db.value<string>('SELECT name FROM ledgers WHERE id = (SELECT payable_ledger_id FROM tds_lines WHERE voucher_id = :id)', { id: cn.id })!;
    assert.equal(e[payableName], rev, 'Dr TCS Payable');
    assert.equal(e['Metal Recyclers Ltd'], -(11_800_00 + rev));
    assert.equal(tdsLines(k, cn.id)[0].amount, -rev);
    k.t.close();
  });
});

describe('TDS journal on a bill booked gross', () => {
  it('Dr party / Cr TDS Payable against the bill is recorded as the deduction on that bill', async () => {
    const k = setupTds();
    // Bill booked gross: TDS overridden to nil (the accountant deducts it later by journal).
    const bill = save(k, purchase(k, '2026-06-05', k.L.contractor, k.L.contractExp, 1_00_000_00, 'SC-9', { tds: { overrides: [{ natureId: k.N['194C'], amount: 0, reason: 'deducted later' }] } }));
    assert.equal(entries(k, bill.id)['TDS Payable – 194C'], undefined);
    const payable = k.t.db.value<number>(`SELECT id FROM ledgers WHERE name = 'TDS Payable – 194C'`)!;
    const j = save(k, {
      voucherTypeId: k.vt.journal, date: '2026-06-20', mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.contractor, amount: 2_000_00, billAllocations: [{ refType: 'against', billName: 'SC-9', amount: 2_000_00 }] },
        { ledgerId: payable, amount: -2_000_00 },
      ],
    });
    assert.ok(!j.warnings.some((w) => w.level === 'confirm'), 'no longer asks for confirmation');
    const l = tdsLines(k, j.id);
    assert.deepEqual(l.map((x) => [x.section, x.amount, x.base, x.assessable, x.status]), [['194C', 2_000_00, 1_00_000_00, 0, 'deducted']]);
    assert.equal(k.t.db.value('SELECT bill_voucher_id FROM tds_lines WHERE voucher_id = :id', { id: j.id }), bill.id);
    const os = await k.t.callOk<TdsOutstandingResult>(tdsRoutes, 'tds.outstanding', { asOf: '2026-06-30', kind: 'tds' });
    assert.equal(os.rows.reduce((a, r) => a + r.deducted, 0), 2_000_00, 'in the TDS reports');
    k.t.close();
  });
});

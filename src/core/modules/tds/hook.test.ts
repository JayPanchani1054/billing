/**
 * TDS/TCS at voucher entry (vouchers/hooks.ts › tds hook): computation, posting, tds_lines and their
 * rebuild on alter / cancel / delete. Figures are hand-verified in the comments.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cancelVoucher, deleteVoucher, previewVoucher, saveVoucher } from '../vouchers/service.ts';
import { getFeatures, saveFeatures } from '../company/service.ts';
import { entries, enable194Q, journal, purchase, save, setupTds, tdsLines } from './testkit.ts';

const P = (rupees: number): number => Math.round(rupees * 100);

describe('tds hook: purchase invoices', () => {
  it('194C on a contractor bill: tax on the value excluding GST, party credited net, bill = net', () => {
    const k = setupTds();
    // Contract charges ₹40,000 + GST 18% (CGST 3,600 + SGST 3,600) = ₹47,200.
    // 194C, firm, single bill > ₹30,000: 2% × 40,000 = ₹800. Party gets 47,200 − 800 = ₹46,400.
    const r = save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'));
    const e = entries(k, r.id);
    assert.equal(e['Contract Charges'], P(40_000));
    assert.equal(e['Input CGST'], P(3_600));
    assert.equal(e['Input SGST/UTGST'], P(3_600));
    assert.equal(e['Sharma Contractors'], -P(46_400));
    assert.equal(e['TDS Payable – 194C'], -P(800));
    assert.equal(Object.values(e).reduce((a, b) => a + b, 0), 0);
    const [l] = tdsLines(k, r.id);
    assert.deepEqual(
      { assessable: l.assessable, base: l.base, rate: l.rate, amount: l.amount, status: l.status, books: l.affects_books },
      { assessable: P(40_000), base: P(40_000), rate: 2, amount: P(800), status: 'deducted', books: 1 },
    );
    const bill = k.t.db.get<{ amount: number; bill_name: string }>(`SELECT amount, bill_name FROM bill_allocations WHERE voucher_id = :id`, { id: r.id });
    assert.deepEqual(bill, { amount: -P(46_400), bill_name: 'SC-1' });
    // The invoice value stays the supplier's ₹47,200.
    assert.equal(k.t.db.value('SELECT total_amount FROM vouchers WHERE id = :id', { id: r.id }), P(47_200));
    // The duty ledger was created under Duties & Taxes, marked TDS, and audited.
    const led = k.t.db.get<{ tax_type: string; grp: string }>(
      `SELECT l.tax_type, g.name AS grp FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = 'TDS Payable – 194C'`,
    );
    assert.deepEqual(led, { tax_type: 'TDS', grp: 'Duties & Taxes' });
    assert.ok(k.t.db.value(`SELECT 1 FROM audit_log WHERE entity_type = 'ledger' AND entity_label = 'TDS Payable – 194C'`));
    k.t.close();
  });

  it('preview computes the TDS without creating the duty ledger; save creates it', () => {
    const k = setupTds();
    const input = purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1');
    const before = k.t.db.value<number>('SELECT COUNT(*) FROM ledgers');
    const p = previewVoucher(k.t.ctx, input);
    assert.equal(p.tds?.tds, P(800));
    assert.equal(p.tds?.lines[0].payableLedgerId, null);
    assert.ok(p.warnings.some((w) => w.code === 'tds' && /will be created when you save/.test(w.message)));
    assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM ledgers'), before);
    save(k, input);
    const p2 = previewVoucher(k.t.ctx, { ...input, referenceNo: 'SC-2' });
    assert.ok(p2.entries.some((x) => x.ledgerName === 'TDS Payable – 194C' && x.amount === -P(800)));
    assert.equal(p2.tds?.lines[0].payableLedgerName, 'TDS Payable – 194C');
    k.t.close();
  });

  it('no PAN: s.206AA higher rate (20%), with an info warning', () => {
    const k = setupTds();
    // ₹50,000 labour, no PAN, deductee type not set → "others", 194C single > ₹30,000: 20% = ₹10,000.
    const r = saveVoucher(k.t.ctx, { ...purchase(k, '2026-05-02', k.L.noPan, k.L.labourExp, P(50_000), 'UC-1'), acknowledgeWarnings: true });
    assert.ok(r.warnings.some((w) => w.code === 'tds' && /no PAN/.test(w.message)));
    const [l] = tdsLines(k, r.id);
    assert.equal(l.rate, 20);
    assert.equal(l.amount, P(10_000));
    assert.equal(l.pan_status, 'missing');
    assert.equal(entries(k, r.id)['Unknown Carpenter'], -P(40_000));
    k.t.close();
  });

  it('194Q: only for a buyer above ₹10 crore, on purchases above ₹50 lakh in the year', () => {
    const k = setupTds();
    const item = k.t.addStockItem({ name: 'Wheat (quintal)', unit: 'Nos', gstRate: 5, hsnSac: '1001' });
    const input = {
      voucherTypeId: k.vt.purchase,
      date: '2026-05-10',
      mode: 'item_invoice' as const,
      partyLedgerId: k.L.supplier,
      referenceNo: 'GC-1',
      items: [{ itemId: item, qty: 1000, rate: 6000, ledgerId: k.L.purchase }],
    };
    // Without the 194Q switch nothing is deducted.
    const r0 = save(k, input);
    assert.equal(tdsLines(k, r0.id).length, 0);
    deleteVoucher(k.t.ctx, r0.id);
    enable194Q(k);
    // 1000 × ₹6,000 = ₹60,00,000 (+ 5% GST ₹3,00,000). Excess over ₹50 lakh = ₹10,00,000 × 0.1% = ₹1,000.
    const r = save(k, input);
    const [l] = tdsLines(k, r.id);
    assert.deepEqual({ base: l.base, amount: l.amount, rate: l.rate }, { base: P(10_00_000), amount: P(1_000), rate: 0.1 });
    // Party: 63,00,000 − 1,000 = ₹62,99,000.
    assert.equal(entries(k, r.id)['Grain Corp Ltd'], -P(62_99_000));
    k.t.close();
  });

  it('override with a reason replaces the computed amount (0 = not deducted)', () => {
    const k = setupTds();
    const input = purchase(k, '2026-04-22', k.L.contractor, k.L.contractExp, P(40_000), 'SC-9', {
      tds: { overrides: [{ natureId: k.N['194C'], amount: 0, reason: 'Transporter declaration u/s 194C(6)' }] },
    });
    const r = save(k, input);
    const [l] = tdsLines(k, r.id);
    assert.deepEqual(
      { computed: l.computed, amount: l.amount, status: l.status, overridden: l.overridden, reason: l.reason },
      { computed: P(800), amount: 0, status: 'overridden_nil', overridden: 1, reason: 'Transporter declaration u/s 194C(6)' },
    );
    assert.equal(entries(k, r.id)['Sharma Contractors'], -P(47_200));
    assert.equal(entries(k, r.id)['TDS Payable – 194C'], undefined);
    k.t.close();
  });
});

describe('tds hook: journals and payments', () => {
  it('194C aggregate: four credits of ₹25,000 below the threshold, the fifth takes them all in', () => {
    const k = setupTds();
    const ids = ['2026-04-10', '2026-05-10', '2026-06-01', '2026-06-05'].map((d) => save(k, journal(k, d, k.L.labourExp, k.L.labour, P(25_000))).id);
    for (const id of ids) {
      const [l] = tdsLines(k, id);
      assert.equal(l.status, 'below_threshold');
      assert.equal(l.amount, 0);
      assert.equal(entries(k, id)['Ramesh Labour'], -P(25_000));
    }
    // 5th: aggregate 1,25,000 > 1,00,000 → base 25,000 + 1,00,000 catch-up = 1,25,000 × 1% (individual) = ₹1,250.
    const r = save(k, journal(k, '2026-06-10', k.L.labourExp, k.L.labour, P(25_000)));
    const [l] = tdsLines(k, r.id);
    assert.deepEqual({ catchUp: l.catch_up, base: l.base, amount: l.amount }, { catchUp: P(1_00_000), base: P(1_25_000), amount: P(1_250) });
    const e = entries(k, r.id);
    assert.equal(e['Ramesh Labour'], -P(23_750));
    assert.equal(e['TDS Payable – 194C'], -P(1_250));
    // A sixth credit: no catch-up left; 1% of ₹10,000 = ₹100.
    const r6 = save(k, journal(k, '2026-06-12', k.L.labourExp, k.L.labour, P(10_000)));
    assert.deepEqual(
      { catchUp: tdsLines(k, r6.id)[0].catch_up, amount: tdsLines(k, r6.id)[0].amount },
      { catchUp: 0, amount: P(100) },
    );
    k.t.close();
  });

  it('bill-wise allocations typed for the gross are rescaled to the net credit', () => {
    const k = setupTds();
    // ₹60,000 professional fees, 194J(b) individual 10%: ₹6,000; the bill becomes ₹54,000.
    const input = journal(k, '2026-05-05', k.L.profFees, k.L.prof, P(60_000));
    input.ledgers![1].billAllocations = [{ refType: 'new', billName: 'KAP-7', amount: P(60_000) }];
    const r = save(k, input);
    const b = k.t.db.get<{ amount: number; bill_name: string }>(`SELECT amount, bill_name FROM bill_allocations WHERE voucher_id = :id AND ledger_id = :l`, {
      id: r.id,
      l: k.L.prof,
    });
    assert.deepEqual(b, { amount: -P(54_000), bill_name: 'KAP-7' });
    k.t.close();
  });

  it('advance payment with a nature: the party is debited gross, the bank credit is reduced', () => {
    const k = setupTds();
    // Advance ₹60,000 to CA Kapoor, 194J(b) 10% → TDS ₹6,000; bank pays ₹54,000.
    const r = save(k, {
      voucherTypeId: k.vt.payment,
      date: '2026-04-25',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.prof, amount: P(60_000) },
        { ledgerId: k.L.bank, amount: -P(60_000) },
      ],
      tds: { natureId: k.N['194J(b)'] },
    });
    const e = entries(k, r.id);
    assert.deepEqual(e, { 'CA Kapoor': P(60_000), 'HDFC Bank': -P(54_000), 'TDS Payable – 194J(b)': -P(6_000) });
    // A payment settling a bill (no nature chosen) deducts nothing again.
    const r2 = save(k, {
      voucherTypeId: k.vt.payment,
      date: '2026-04-26',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.prof, amount: P(10_000) },
        { ledgerId: k.L.bank, amount: -P(10_000) },
      ],
    });
    assert.equal(tdsLines(k, r2.id).length, 0);
    k.t.close();
  });

  it('a journal crediting two parties is not guessed at (confirm warning, no TDS)', () => {
    const k = setupTds();
    const p = previewVoucher(k.t.ctx, {
      voucherTypeId: k.vt.journal,
      date: '2026-05-01',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.profFees, amount: P(80_000) },
        { ledgerId: k.L.prof, amount: -P(40_000) },
        { ledgerId: k.L.contractor, amount: -P(40_000) },
      ],
    });
    assert.ok(p.warnings.some((w) => w.code === 'tds' && w.level === 'confirm' && /one party per voucher/.test(w.message)));
    assert.ok(!p.entries.some((x) => /TDS Payable/.test(x.ledgerName)));
    k.t.close();
  });
});

describe('tds hook: TCS on sales', () => {
  it('scrap: TCS 1% on the value including GST is added to the invoice value', () => {
    const k = setupTds();
    // ₹1,00,000 scrap + CGST 9,000 + SGST 9,000 = ₹1,18,000; TCS 1% of 1,18,000 = ₹1,180; invoice ₹1,19,180.
    const r = save(k, {
      voucherTypeId: k.vt.sales,
      date: '2026-06-02',
      mode: 'accounting_invoice',
      partyLedgerId: k.L.buyer,
      ledgers: [{ ledgerId: k.L.scrapSales, amount: P(1_00_000) }],
    });
    const e = entries(k, r.id);
    assert.equal(e['Metal Recyclers Ltd'], P(1_19_180));
    assert.equal(e['TCS Payable'], -P(1_180));
    assert.equal(e['Sale of Scrap'], -P(1_00_000));
    assert.equal(k.t.db.value('SELECT total_amount FROM vouchers WHERE id = :id', { id: r.id }), P(1_19_180));
    const [l] = tdsLines(k, r.id);
    assert.deepEqual({ kind: l.kind, base: l.base, amount: l.amount, section: l.section }, { kind: 'tcs', base: P(1_18_000), amount: P(1_180), section: '206C(1)' });
    // GST lines are untouched by TCS.
    assert.equal(k.t.db.value('SELECT SUM(taxable_value) FROM gst_lines WHERE voucher_id = :id', { id: r.id }), P(1_00_000));
    k.t.close();
  });

  it('TCS off: the same sale posts no TCS; TDS off: no TDS', () => {
    const k = setupTds({ features: { tds: false, tcs: false } });
    assert.equal(getFeatures(k.t.db).tds, false);
    const r = save(k, { voucherTypeId: k.vt.sales, date: '2026-06-02', mode: 'accounting_invoice', partyLedgerId: k.L.buyer, ledgers: [{ ledgerId: k.L.scrapSales, amount: P(1_00_000) }] });
    assert.equal(tdsLines(k, r.id).length, 0);
    const r2 = save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'));
    assert.equal(tdsLines(k, r2.id).length, 0);
    assert.equal(entries(k, r2.id)['Sharma Contractors'], -P(47_200));
    k.t.close();
  });
});

describe('tds hook: lifecycle', () => {
  it('tds_lines follow alter, optional, cancel and delete', () => {
    const k = setupTds();
    const r = save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'));
    // Alter to ₹50,000: 2% = ₹1,000.
    const altered = save(k, { ...purchase(k, '2026-04-21', k.L.contractor, k.L.contractExp, P(50_000), 'SC-1'), id: r.id });
    assert.equal(altered.id, r.id);
    const lines = tdsLines(k, r.id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].amount, P(1_000));
    // Optional: rows kept but out of the books.
    save(k, { ...purchase(k, '2026-04-21', k.L.contractor, k.L.contractExp, P(50_000), 'SC-1'), id: r.id, isOptional: true });
    assert.equal(tdsLines(k, r.id)[0].affects_books, 0);
    save(k, { ...purchase(k, '2026-04-21', k.L.contractor, k.L.contractExp, P(50_000), 'SC-1'), id: r.id, isOptional: false });
    cancelVoucher(k.t.ctx, r.id, 'Wrong supplier');
    assert.equal(tdsLines(k, r.id).length, 0);
    const r2 = save(k, purchase(k, '2026-04-22', k.L.contractor, k.L.contractExp, P(40_000), 'SC-2'));
    assert.equal(tdsLines(k, r2.id).length, 1);
    deleteVoucher(k.t.ctx, r2.id);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM tds_lines WHERE voucher_id = :id', { id: r2.id }), 0);
    k.t.close();
  });

  it('turning TDS off and on keeps existing rows; the feature toggles are respected at entry', () => {
    const k = setupTds();
    const r = save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'));
    saveFeatures(k.t.ctx, { tds: false });
    const p = previewVoucher(k.t.ctx, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-2'));
    assert.equal(p.tds, undefined);
    assert.equal(tdsLines(k, r.id).length, 1);
    k.t.close();
  });
});

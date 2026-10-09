/**
 * Advances (GSTR-1 Table 11) through the real posting engine: tax on an advance receipt, its adjustment
 * on the invoice (bill-wise and explicit), refund vouchers, Table 11A / 11B and GSTR-3B 3.1(a).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { deleteVoucher, previewVoucher } from '../vouchers/service.ts';
import { entryMap, save, setupKit, throwsApp, type Kit } from '../vouchers/testkit.ts';
import { advanceTax, pendingAdvances, table11 } from './advances.ts';
import { loadCompany } from './docs.ts';
import { computeGstr3b } from './gstr3b.ts';
import { parsePeriodKey } from './period.ts';

function receipt(k: Kit, over: Partial<VoucherInput> & { party?: number; amount?: number; bill?: string } = {}): VoucherInput {
  const amount = over.amount ?? 11_800_00;
  const party = over.party ?? k.L.acme;
  return {
    voucherTypeId: k.vt.receipt,
    date: over.date ?? '2026-04-10',
    mode: 'ledger',
    ledgers: [
      { ledgerId: k.L.bank, amount },
      { ledgerId: party, amount: -amount, billAllocations: [{ refType: 'advance', billName: over.bill ?? 'ADV-1', amount }] },
    ],
    gstDetails: over.gstDetails ?? { advance: { supplyType: 'services', rate: 18 } },
  };
}

describe('advanceTax', () => {
  it('treats the amount as inclusive of tax and keeps taxable + tax = amount', () => {
    // 11,800 @18% intra: base 10,000; CGST = SGST = 900.
    assert.deepEqual(advanceTax(11_800_00, 18, 0, false), { gross: 11_800_00, taxable: 10_000_00, igst: 0, cgst: 900_00, sgst: 900_00, cess: 0 });
    // 1,000 @5% inter: base round(1000×100/105 = 952.38) = 952.38; IGST round(47.619) = 47.62; taxable 952.38.
    assert.deepEqual(advanceTax(1_000_00, 5, 0, true), { gross: 1_000_00, taxable: 952_38, igst: 47_62, cgst: 0, sgst: 0, cess: 0 });
  });
});

describe('advance receipts, adjustment and refund', () => {
  it('posts tax on the advance, reverses it on the invoice (bill-wise) and reports Table 11A / 11B', () => {
    const k = setupKit({ today: '2026-06-15' });
    const r = save(k, receipt(k));
    // Dr Bank 11,800 / Cr Acme 11,800 + Dr GST on Advances 1,800 / Cr Output CGST 900 / Cr Output SGST 900.
    const e = entryMap(k, r.id);
    assert.equal(e['GST on Advances Received'], 1_800_00);
    assert.equal(e['Output CGST'], -900_00);
    assert.equal(e['Output SGST/UTGST'], -900_00);
    assert.equal(e['HDFC Bank'], 11_800_00);

    // Invoice in May: consultancy 20,000 @18% = 23,600; 11,800 against the advance bill.
    const inv = save(k, {
      voucherTypeId: k.vt.sales,
      date: '2026-05-05',
      mode: 'accounting_invoice',
      partyLedgerId: k.L.acme,
      ledgers: [{ ledgerId: k.L.consult, amount: 20_000_00 }],
      partyBillAllocations: [
        { refType: 'against', billName: 'ADV-1', amount: 11_800_00 },
        { refType: 'new', billName: 'INV-1', amount: 11_800_00 },
      ],
    });
    const ie = entryMap(k, inv.id);
    // Invoice CGST 1,800 Cr less the advance's 900 reversed (Dr) = 900 Cr net on this voucher.
    assert.equal(ie['Output CGST'], -900_00);
    assert.equal(ie['GST on Advances Received'], -1_800_00);
    const bal = k.t.db.value<number>(`SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = (SELECT id FROM ledgers WHERE reserved_code = 'GST_ADVANCE')`);
    assert.equal(bal, 0, 'advance tax fully reversed');

    const company = loadCompany(k.t.db);
    const apr = table11(k.t.db, '2026-04-01', '2026-04-30', k.t.today, '27');
    assert.deepEqual(
      apr.received.map((x) => [x.pos, x.rate, x.supplyKind, x.taxable, x.cgst, x.sgst]),
      [['27', 18, 'INTRA', 10_000_00, 900_00, 900_00]],
    );
    const may = table11(k.t.db, '2026-05-01', '2026-05-31', k.t.today, '27');
    assert.deepEqual(may.adjusted.map((x) => [x.taxable, x.cgst, x.sgst]), [[10_000_00, 900_00, 900_00]]);

    // GSTR-3B: April 3.1(a) = the advance; May 3.1(a) = invoice 20,000 / 1,800 + 1,800 less the advance.
    const a3b = computeGstr3b(k.t.db, company, parsePeriodKey('042026')!, k.t.today);
    const osupA = a3b.supplies.find((s) => s.key === 'osup_det')!;
    assert.deepEqual([osupA.taxable, osupA.cgst, osupA.sgst], [10_000_00, 900_00, 900_00]);
    const m3b = computeGstr3b(k.t.db, company, parsePeriodKey('052026')!, k.t.today);
    const osupM = m3b.supplies.find((s) => s.key === 'osup_det')!;
    assert.deepEqual([osupM.taxable, osupM.cgst, osupM.sgst], [10_000_00, 900_00, 900_00]);
    assert.deepEqual(pendingAdvances(k.t.db, k.t.today, k.t.today), []);

    // The receipt cannot be deleted while the invoice adjusts its advance.
    throwsApp(() => deleteVoucher(k.t.ctx, r.id), 'BUSINESS_RULE', /settled by Sales|adjusted or refunded/);
    k.t.close();
  });

  it('refunds part of an inter-state advance proportionately (refund voucher)', () => {
    const k = setupKit({ today: '2026-06-15' });
    // 5,900 @18% inter-state (Karnataka): base 5,000, IGST 900.
    const r = save(k, receipt(k, { party: k.L.blr, amount: 5_900_00, bill: 'ADV-B' }));
    assert.equal(entryMap(k, r.id)['Output IGST'], -900_00);
    const p = save(k, {
      voucherTypeId: k.vt.payment,
      date: '2026-05-20',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.blr, amount: 2_950_00, billAllocations: [{ refType: 'against', billName: 'ADV-B', amount: 2_950_00 }] },
        { ledgerId: k.L.bank, amount: -2_950_00 },
      ],
      gstDetails: { advanceRefund: { receiptVoucherId: r.id, amount: 2_950_00 } },
    });
    // Half the advance: IGST round(900 × 2,950 / 5,900) = 450; taxable 2,950 − 450 = 2,500.
    assert.equal(entryMap(k, p.id)['Output IGST'], 450_00);
    const may = table11(k.t.db, '2026-05-01', '2026-05-31', k.t.today, '27');
    assert.deepEqual(may.adjusted.map((x) => [x.pos, x.supplyKind, x.taxable, x.igst]), [['29', 'INTER', 2_500_00, 450_00]]);
    assert.deepEqual(pendingAdvances(k.t.db, k.t.today, k.t.today).map((x) => x.pending), [2_950_00]);
    // Refunding more than is left is refused.
    const over = previewVoucher(k.t.ctx, {
      voucherTypeId: k.vt.payment,
      date: '2026-05-21',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.blr, amount: 3_000_00 },
        { ledgerId: k.L.bank, amount: -3_000_00 },
      ],
      gstDetails: { advanceRefund: { receiptVoucherId: r.id, amount: 3_000_00 } },
    });
    assert.ok(over.warnings.some((w) => w.code === 'gst_stat' && w.blocking && /still to be adjusted/.test(w.message)));
    k.t.close();
  });

  it('charges no tax on advances for goods (Notification 66/2017-CT) and refuses details on the wrong voucher', () => {
    const k = setupKit({ today: '2026-06-15' });
    const r = save(k, receipt(k, { gstDetails: { advance: { supplyType: 'goods', rate: 18 } } }));
    assert.equal(entryMap(k, r.id)['Output CGST'], undefined);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM gst_advance_lines'), 0);
    const pv = previewVoucher(k.t.ctx, {
      voucherTypeId: k.vt.journal,
      date: '2026-05-01',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.rent, amount: 100_00 },
        { ledgerId: k.L.capital, amount: -100_00 },
      ],
      gstDetails: { advance: { supplyType: 'services', rate: 18 } },
    });
    assert.ok(pv.warnings.some((w) => w.code === 'gst_stat' && w.blocking));
    k.t.close();
  });
});

/**
 * Bills of entry (imports of goods) and GST stat adjustment journals through the real posting engine,
 * and their place in GSTR-3B (4(A)(1), 4(A)(3), 4(A)(5), 4(B)(1), 4(B)(2), 4(D)(1), 3.1(d)).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Gstr3bSummary } from '../../../shared/types/gst-returns.ts';
import { previewVoucher } from '../vouchers/service.ts';
import { entryMap, save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { loadCompany } from './docs.ts';
import { computeGstr3b } from './gstr3b.ts';
import { parsePeriodKey } from './period.ts';
import { reconcileBoe } from './boeRecon.ts';

const g3b = (k: Kit, key: string): Gstr3bSummary => computeGstr3b(k.t.db, loadCompany(k.t.db), parsePeriodKey(key)!, k.t.today);
const itc = (s: Gstr3bSummary, ty: string) => s.itc.available.find((r) => r.ty === ty)!;
const heads = (t: { igst: number; cgst: number; sgst: number; cess: number }) => [t.igst, t.cgst, t.sgst, t.cess];

function journal(k: Kit, date: string, lines: Array<[number, number]>, adjustment: Record<string, unknown>) {
  return {
    voucherTypeId: k.vt.journal,
    date,
    mode: 'ledger' as const,
    ledgers: lines.map(([ledgerId, amount]) => ({ ledgerId, amount })),
    gstDetails: { adjustment: adjustment as never },
  };
}

describe('bill of entry (import of goods)', () => {
  it('posts the IGST paid at customs as input credit and reports it in 3B 4(A)(1)', () => {
    const k = setupKit({ today: '2026-06-15' });
    const overseas = k.t.addLedger({ name: 'Shenzhen Tools Co', group: 'SUNDRY_CREDITORS', registrationType: 'overseas', columns: { country: 'China', state_code: null } });
    // Invoice value 10 × 1,000 = 10,000 (IGST 18% computed on it: 1,800, not posted).
    // BOE: assessable 11,000 + BCD 1,100 + SWS 110 = 12,210 → IGST 18% = 2,197.80.
    const v = save(k, {
      voucherTypeId: k.vt.purchase,
      date: '2026-05-10',
      mode: 'item_invoice',
      partyLedgerId: overseas,
      referenceNo: 'SZ-77',
      items: [{ itemId: k.I.mixer, qty: 10, rate: 1000 }],
      gstDetails: { billOfEntry: { number: '4567890', date: '2026-05-10', portCode: 'INNSA1', assessableValue: 11_000_00, customsDuty: 1_210_00, igst: 2_197_80 } },
    });
    const e = entryMap(k, v.id);
    assert.equal(e['Input IGST'], 2_197_80);
    assert.equal(e['IGST Payable on Imports (Customs)'], -2_197_80);
    assert.equal(e['Shenzhen Tools Co'], -10_000_00, 'the supplier gets the invoice value only');
    const boe = k.t.db.get<{ boe_no: string; igst: number; port_code: string }>('SELECT boe_no, igst, port_code FROM gst_bill_of_entry WHERE voucher_id = :id', { id: v.id });
    assert.deepEqual(boe, { boe_no: '4567890', igst: 2_197_80, port_code: 'INNSA1' });
    const s = g3b(k, '052026');
    // 4(A)(1) = BOE IGST (2,197.80), not the 1,800 computed on the invoice value.
    assert.deepEqual(heads(itc(s, 'IMPG')), [2_197_80, 0, 0, 0]);
    assert.deepEqual(heads(s.bookAdjustments!.billOfEntry), [397_80, 0, 0, 0]);

    // GSTR-2B IMPG: the same BOE (number with leading zeros, same port) matches; a second one is not in the books.
    const twoB = {
      data: {
        rtnprd: '052026',
        docdata: {
          impg: [
            { refdt: '12-05-2026', portcode: 'INNSA1', boenum: '04567890', boedt: '10-05-2026', isamd: 'N', txval: 12210, igst: 2197.8, cess: 0 },
            { refdt: '20-05-2026', portcode: 'INMAA1', boenum: '1111111', boedt: '18-05-2026', isamd: 'N', txval: 5000, igst: 900, cess: 0 },
          ],
        },
      },
    };
    const rec = reconcileBoe(k.t.db, new TextEncoder().encode(JSON.stringify(twoB)), '2026-05-01', '2026-05-31', k.t.today);
    assert.deepEqual(rec.counts, { matched: 1, mismatch: 0, missing_in_books: 1, missing_in_portal: 0 });
    assert.equal(rec.period, '052026');
    k.t.close();
  });

  it('refuses a bill of entry on a domestic purchase', () => {
    const k = setupKit({ today: '2026-06-15' });
    const pv = previewVoucher(k.t.ctx, {
      voucherTypeId: k.vt.purchase,
      date: '2026-05-10',
      mode: 'item_invoice',
      partyLedgerId: k.L.supplier,
      referenceNo: 'X1',
      items: [{ itemId: k.I.rice, qty: 1, rate: 100 }],
      gstDetails: { billOfEntry: { number: '1', date: '2026-05-10', assessableValue: 100_00, igst: 5_00 } },
    });
    assert.ok(pv.warnings.some((w) => w.code === 'gst_stat' && w.blocking && /imports of goods/.test(w.message)));
    k.t.close();
  });
});

describe('GST stat adjustment journals', () => {
  it('ITC reversal (rules 42 / 37), reclaim and reverse-charge liability reach GSTR-3B', () => {
    const k = setupKit({ today: '2026-06-30' });
    const L = k.L;
    // Rule 42: Dr ITC reversal expense 1,000 / Cr Input CGST 500 / Cr Input SGST 500.
    save(k, journal(k, '2026-05-31', [[L.rent, 1_000_00], [L.INPUT_CGST, -500_00], [L.INPUT_SGST, -500_00]], { nature: 'itc_reversal_r42' }));
    // Rule 37 (supplier unpaid after 180 days): Cr Input IGST 300.
    save(k, journal(k, '2026-05-31', [[L.rent, 300_00], [L.INPUT_IGST, -300_00]], { nature: 'itc_reversal_r37' }));
    // Reverse charge (advocate, 10,000 @18% intra): Dr Input CGST/SGST 900 each / Cr RCM CGST/SGST 900 each.
    save(
      k,
      journal(k, '2026-05-20', [[L.INPUT_CGST, 900_00], [L.INPUT_SGST, 900_00], [L.RCM_CGST, -900_00], [L.RCM_SGST, -900_00]], {
        nature: 'rcm_liability',
        taxableValue: 10_000_00,
      }),
    );
    // June: the supplier is paid — reclaim the rule-37 credit (Dr Input IGST 300).
    save(k, journal(k, '2026-06-10', [[L.INPUT_IGST, 300_00], [L.rent, -300_00]], { nature: 'itc_reclaim' }));

    const may = g3b(k, '052026');
    const rul = may.itc.reversed.find((r) => r.row === '4(B)(1)')!;
    const oth = may.itc.reversed.find((r) => r.row === '4(B)(2)')!;
    assert.deepEqual(heads(rul), [0, 500_00, 500_00, 0]);
    assert.deepEqual(heads(oth), [300_00, 0, 0, 0]);
    assert.equal(oth.source, 'both');
    assert.deepEqual(heads(itc(may, 'ISRC')), [0, 900_00, 900_00, 0]);
    const rev = may.supplies.find((r) => r.key === 'isup_rev')!;
    assert.deepEqual([rev.taxable, ...heads(rev)], [10_000_00, 0, 900_00, 900_00, 0]);
    // 4(C) = 4(A) − 4(B): CGST 900 − 500 = 400; IGST 0 − 300 = −300 (added to the liability, paid in cash).
    assert.deepEqual(heads(may.itc.net), [-300_00, 400_00, 400_00, 0]);
    // RCM tax is paid in cash.
    assert.equal(may.payment.rows.find((r) => r.head === 'cgst')!.rcmLiability, 900_00);

    const jun = g3b(k, '062026');
    assert.deepEqual(heads(itc(jun, 'OTH')), [300_00, 0, 0, 0]);
    assert.deepEqual(heads(jun.itc.ineligible.find((r) => r.row === '4(D)(1)')!), [300_00, 0, 0, 0]);
    k.t.close();
  });

  it('refuses a journal whose lines contradict the nature', () => {
    const k = setupKit({ today: '2026-06-30' });
    // A "reversal" that debits Input tax is a reclaim, not a reversal.
    const pv = previewVoucher(k.t.ctx, journal(k, '2026-05-31', [[k.L.INPUT_CGST, 100_00], [k.L.rent, -100_00]], { nature: 'itc_reversal_r42' }));
    assert.ok(pv.warnings.some((w) => w.code === 'gst_stat' && w.blocking && /credit the Input tax ledgers/.test(w.message)));
    // Reverse charge without the taxable value needs confirmation.
    const rc = previewVoucher(k.t.ctx, journal(k, '2026-05-31', [[k.L.INPUT_IGST, 50_00], [k.L.RCM_IGST, -50_00]], { nature: 'rcm_liability' }));
    assert.ok(rc.warnings.some((w) => w.code === 'gst_stat' && w.level === 'confirm' && /taxable value/.test(w.message)));
    k.t.close();
  });
});

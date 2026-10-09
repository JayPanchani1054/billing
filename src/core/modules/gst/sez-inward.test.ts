/**
 * Purchases from an SEZ unit, end to end (posting → GSTR-3B → GSTR-9 → ITC register → GSTR-2B books side
 * → data check). The law (SEZ Act s.30, SEZ Rules r.47–48, IGST Act s.7(5)(b)):
 *   - GOODS cleared from an SEZ into the DTA are imports: the buyer files a bill of entry and pays IGST at
 *     customs. The SEZ unit's invoice carries no tax for us to pay it; ITC is claimed in GSTR-3B 4(A)(1)
 *     (IMPG) / GSTR-9 6E, and GSTR-2B shows the bill of entry under IMPGSEZ, not B2B.
 *   - SERVICES from an SEZ unit are an inter-state B2B supply: IGST on the invoice, paid to the supplier,
 *     ITC in 4(A)(5) (OTH), matched with GSTR-2B B2B.
 * Company: Maharashtra (27), working date 15-Apr-2026 (vouchers/testkit.ts). Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyData } from '../data/verify.ts';
import { loadBooksDocs } from '../gstrecon/books.ts';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { entryMap, save, setupKit } from '../vouchers/testkit.ts';
import { loadCompany } from './docs.ts';
import { computeGstr3b } from './gstr3b.ts';
import { computeGstr9 } from './gstr9.ts';
import { resolvePeriod } from './period.ts';
import { itcReport } from './reports.ts';

describe('purchase from an SEZ unit: goods are an import (IGST at customs), services are B2B', () => {
  it('posts, reports and reconciles consistently', () => {
    const k = setupKit();
    const sez = k.t.addLedger({ name: 'Pune SEZ Supplier', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(32)), registrationType: 'sez' });
    const testing = k.t.addLedger({ name: 'Testing Charges', group: 'INDIRECT_EXPENSES', gstRate: 18, hsnSac: '998346', supplyType: 'services' });
    // Mixer 2 × ₹2,000 = ₹4,000.00 (goods) @18% → IGST 720.00 paid at customs on the bill of entry;
    // testing services ₹1,000.00 @18% → IGST 180.00 charged by the SEZ unit.
    // Supplier: 4,000 + 1,000 + 180 = ₹5,180.00.
    const v = save(k, {
      voucherTypeId: k.vt.purchase,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: sez,
      referenceNo: 'SZS-1',
      referenceDate: k.t.today,
      items: [{ itemId: k.I.mixer, qty: 2, rate: 2000 }],
      ledgers: [{ ledgerId: testing, amount: 100000 }],
    });
    assert.deepEqual(entryMap(k, v.id), {
      'Pune SEZ Supplier': -518000,
      Purchase: 400000,
      'Testing Charges': 100000,
      'Input IGST': 18000,
    });
    const g = k.t.db.all<{ supply_type: string; igst: number }>('SELECT supply_type, igst FROM gst_lines WHERE voucher_id = :id ORDER BY line_no', { id: v.id });
    assert.deepEqual(g, [
      { supply_type: 'goods', igst: 72000 },
      { supply_type: 'services', igst: 18000 },
    ], 'gst_lines keep the goods IGST (the ITC of the bill of entry)');

    const company = loadCompany(k.t.db);
    const s = computeGstr3b(k.t.db, company, resolvePeriod({ period: '042026' }), k.t.today);
    const itc = (ty: string): number => s.itc.available.find((r) => r.ty === ty)?.igst ?? 0;
    assert.deepEqual([itc('IMPG'), itc('OTH')], [72000, 18000], '4(A)(1) goods via BOE; 4(A)(5) services');

    const nine = computeGstr9(k.t.db, company, '2026-27', k.t.today);
    const row = (key: string) => nine.table6.find((r) => r.key === key);
    assert.equal(row('6E')?.igst, 72000, '6E import of goods (incl. supplies from SEZs)');
    assert.equal(row('6B3')?.igst, 18000, '6B input services');

    const reg = itcReport(k.t.db, company, '2026-04-01', '2026-04-30', k.t.today);
    assert.equal(reg.totals.imports.igst, 72000, 'ITC register: the goods IGST is shown as paid on import');

    const books = loadBooksDocs(k.t.db, { side: 'inward', from: '2026-04-01', to: '2026-04-30', today: k.t.today });
    assert.deepEqual(
      books.map((b) => [b.docNo, b.taxable, b.igst]),
      [['SZS-1', 100000, 18000]],
      'GSTR-2B B2B expects only the services; the goods come through IMPGSEZ',
    );

    const dv = verifyData(k.t.ctx);
    const posting = dv.checks.find((c) => c.name === 'gst_tax_postings');
    assert.equal(posting?.ok, true, JSON.stringify(posting));
    k.t.close();
  });

  it('a purchase of goods only from an SEZ unit leaves nothing for GSTR-2B B2B and posts no IGST', () => {
    const k = setupKit();
    const sez = k.t.addLedger({ name: 'Pune SEZ Supplier', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(32)), registrationType: 'sez' });
    const v = save(k, {
      voucherTypeId: k.vt.purchase,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: sez,
      referenceNo: 'SZS-2',
      items: [{ itemId: k.I.mixer, qty: 2, rate: 2000 }],
    });
    // 2 × 2,000 = 4,000.00: the SEZ unit is owed the value only.
    assert.deepEqual(entryMap(k, v.id), { 'Pune SEZ Supplier': -400000, Purchase: 400000 });
    assert.deepEqual(loadBooksDocs(k.t.db, { side: 'inward', from: '2026-04-01', to: '2026-04-30', today: k.t.today }), []);
    k.t.close();
  });
});

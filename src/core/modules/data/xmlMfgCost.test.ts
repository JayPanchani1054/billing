/**
 * Tally XML export of a Manufacturing Journal re-valued after it was saved (found by the cross-feature
 * tie-out, all-features-year.test.ts): the journal's stored line amounts are the cost estimate made on
 * saving; a later back-dated purchase re-values the production in every stock report (valuation engine).
 * The export used to write the stale stored amounts, so the Tally company (and our own importer, which
 * takes a stock journal's inward values as written) closed with a different stock value. It now writes
 * the engine's values.
 *
 * Figures (mfg testkit: steel 100 kg @ ₹50 average, paint FIFO 10 L @ ₹200):
 *   10-May Manufacturing Journal: 10 chairs from 50 kg steel → ₹2,500.00 estimated on saving (₹250 each).
 *   Then a purchase dated 01-May (entered later): 100 kg steel @ ₹80 → average (5,000 + 8,000) ÷ 200 = ₹65
 *   on 10-May → 50 kg = ₹3,250.00 → chairs ₹3,250.00 (₹325 each) in every report and in the file.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { StockSummaryResult } from '../../../shared/types/stock.ts';
import { readZip } from '../../lib/zip.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { closingStockValue } from '../inventory/valuation.ts';
import { mfgKit, post, purchase, type MfgKit } from '../mfg/testkit.ts';
import { stockRoutes } from '../stock/routes.ts';
import { exportXml } from './xmlExport.ts';
import { importXml } from './xmlImport.ts';

let k: MfgKit | null = null;
let target: TestCompany | null = null;
afterEach(() => {
  k?.t.close();
  target?.close();
  k = null;
  target = null;
});

const byItem = async (t: TestCompany): Promise<Record<string, [number | null, number]>> => {
  const s = await t.callOk<StockSummaryResult>(stockRoutes, 'stock.summary', { from: '2026-04-01', to: '2026-06-30' });
  const out: Record<string, [number | null, number]> = {};
  for (const r of s.rows) if (r.kind === 'item') out[r.name] = [r.closing.qty, r.closing.value];
  return out;
};

describe('Tally export: manufacturing journals at the engine’s current cost', () => {
  it('a journal re-valued by a back-dated purchase is exported (and re-imported) at its re-valued cost', async () => {
    k = mfgKit();
    const { t, I, VT } = k;
    const mj = post(k, {
      voucherTypeId: VT.manufacturing,
      date: '2026-05-10',
      mode: 'inventory',
      stockJournal: {
        lines: [
          { role: 'product', itemId: I.chair, qty: 10 },
          { role: 'component', itemId: I.steel, qty: 50 },
        ],
      },
    });
    const stored = () => t.db.value<number>('SELECT amount FROM inventory_entries WHERE voucher_id = :id AND qty > 0', { id: mj.id });
    assert.equal(stored(), 2_500_00, 'estimate on saving: 50 kg × ₹50');
    purchase(k, '2026-05-01', [{ itemId: I.steel, qty: 100, rate: 80 }]);
    assert.equal(stored(), 2_500_00, 'the stored amount is not rewritten');
    const src = await byItem(t);
    assert.deepEqual(src.Chair, [10, 3_250_00], 'the engine re-values the chairs: 50 kg × ₹65');

    const file = await exportXml(t.ctx, { masters: true, vouchers: true, from: '2025-04-01', to: '2026-06-30' });
    const zip = readZip(file.bytes);
    const xml = new TextDecoder('utf-16le').decode(zip.read('2-Vouchers.xml').subarray(2));
    assert.match(xml, /<STOCKITEMNAME>Chair<\/STOCKITEMNAME>[\s\S]*?<RATE>325\.00\/Nos<\/RATE>[\s\S]*?<AMOUNT>-3250\.00<\/AMOUNT>/, 'production at ₹325 each');

    target = createTestCompany({ name: 'Copy', today: '2026-06-30', booksFrom: '2025-04-01', features: { multipleGodowns: true } });
    for (const [fileName, options] of [
      ['1-Masters.xml', { masters: true, vouchers: false, onDuplicate: 'skip' }],
      ['2-Vouchers.xml', { masters: false, vouchers: true, onDuplicate: 'skip' }],
    ] as const) {
      const r = await importXml(target.ctx, { fileName, bytes: zip.read(fileName), options });
      assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], fileName);
    }
    const dst = await byItem(target);
    for (const name of ['Chair', 'Steel Sheet']) assert.deepEqual(dst[name], src[name], `${name}: closing stock reproduced`);
    assert.equal(closingStockValue(target.db, { asOf: '2026-06-30', today: '2026-06-30' }), closingStockValue(t.db, { asOf: '2026-06-30', today: '2026-06-30' }), 'balance sheet closing stock');
  });
});

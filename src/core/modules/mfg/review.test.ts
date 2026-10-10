/**
 * Regression tests of the mfg adversarial review (each fails if its defect returns). Testkit masters
 * (testkit.ts): company in Maharashtra (27), Ravi Fabricators = job worker in Karnataka (29), Mehta
 * Textiles = principal, Supreme Steel = supplier (27).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Itc04Result, PendingJobWorkResult } from '../../../shared/types/mfg.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { AppError } from '../../lib/errors.ts';
import { saveGodown } from '../inventory/masters.ts';
import { closingStockValue, computeStockValuation } from '../inventory/valuation.ts';
import { previewVoucher, setVoucherOptional } from '../vouchers/service.ts';
import { itc04, pendingJobWork } from './jobwork.ts';
import { duplicateJournal, getJournal, productionRegister } from './journalQueries.ts';
import { mfgKit, post, purchase, type MfgKit } from './testkit.ts';

type Lines = NonNullable<VoucherInput['stockJournal']>['lines'];

const materialOut = (k: MfgKit, date: string, godown: number, party: number, lines: Lines, extra: Partial<VoucherInput> = {}) =>
  post(k, { voucherTypeId: k.VT.materialOut, date, mode: 'inventory', partyLedgerId: party, stockJournal: { thirdPartyGodownId: godown, process: 'Machining', lines }, ...extra });

describe('mfg review — job worker processing a principal’s goods', () => {
  test('outputs default to the principal’s godown; an own godown is refused (no stock value out of nothing)', () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    const shirt = t.addStockItem({ name: 'Shirt', gstRate: 5, hsnSac: '6205' });
    post(k, {
      voucherTypeId: VT.materialIn,
      date: '2026-06-01',
      mode: 'inventory',
      partyLedgerId: L.mehta,
      stockJournal: { thirdPartyGodownId: G.mehta, lines: [{ role: 'receipt', itemId: I.fabric, qty: 100, rate: 100 }] },
    });
    const before = closingStockValue(t.db, { asOf: '2026-06-30', today: t.today });
    const make = (productGodown?: number): VoucherInput => ({
      voucherTypeId: VT.manufacturing,
      date: '2026-06-10',
      mode: 'inventory',
      stockJournal: {
        lines: [
          { role: 'component', itemId: I.fabric, qty: 20, godownId: G.mehta },
          { role: 'product', itemId: shirt, qty: 10, ...(productGodown !== undefined ? { godownId: productGodown } : {}) },
        ],
      },
    });
    // Explicitly into our own Main Location: refused with the path of the line.
    assert.throws(
      () => post(k, make(G.main)),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /stockJournal\.lines\[1\]\.godownId/.test(JSON.stringify(e.details)) && /principal/.test(JSON.stringify(e.details)),
    );
    // Without a godown the shirts go into the principal's godown: our closing stock does not change.
    const saved = post(k, make());
    assert.equal(t.db.value('SELECT godown_id FROM inventory_entries WHERE voucher_id = :id AND qty > 0', { id: saved.id }), G.mehta);
    assert.equal(closingStockValue(t.db, { asOf: '2026-06-30', today: t.today }), before, 'a principal’s shirts are not our stock');
    assert.equal(computeStockValuation(t.db, { from: '2026-04-01', to: '2026-06-30', today: t.today, itemIds: [shirt] }).rows[0].closing.value, 0);
    const there = computeStockValuation(t.db, { from: '2026-04-01', to: '2026-06-30', today: t.today, itemIds: [shirt], godownId: G.mehta }).rows[0];
    assert.equal(there.closing.qty, 10);
    t.close();
  });
});

describe('mfg review — ordinary vouchers and a principal’s godown', () => {
  test('a purchase delivered into a principal’s godown needs confirmation (its value would vanish)', () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    const input = (godownId: number): VoucherInput => ({
      voucherTypeId: VT.purchase,
      date: '2026-06-02',
      mode: 'item_invoice',
      partyLedgerId: L.supreme,
      referenceNo: 'S-1',
      items: [{ itemId: I.steel, qty: 10, rate: 50, godownId }],
    });
    const warned = previewVoucher(t.ctx, input(G.mehta)).warnings.filter((w) => w.code === 'mfg');
    assert.equal(warned.length, 1);
    assert.equal(warned[0].level, 'confirm');
    assert.match(warned[0].message, /Mehta Goods holds a principal's goods/);
    assert.equal(previewVoucher(t.ctx, input(G.ravi)).warnings.filter((w) => w.code === 'mfg').length, 0, 'our stock at a job worker is fine');
    assert.equal(previewVoucher(t.ctx, input(G.main)).warnings.filter((w) => w.code === 'mfg').length, 0);
    t.close();
  });
});

describe('mfg review — pending job work and ITC-04', () => {
  test('a purchase delivered straight to the job worker is reported under the JOB WORKER, not the supplier', async () => {
    const k = mfgKit();
    const { t, I, L, G } = k;
    // Supreme Steel (27, intra-state) delivers 40 kg @ ₹55 straight to Ravi's godown (s.143(1)(b)).
    purchase(k, '2026-05-02', [{ itemId: I.steel, qty: 40, rate: 55, godownId: G.ravi }]);
    const r = await t.callOk<Itc04Result>(routes, 'mfg.itc04.report', { from: '2026-04-01', to: '2027-03-31' });
    assert.equal(r.sent.length, 1);
    const row = r.sent[0];
    assert.equal(row.jobWorkerName, 'Ravi Fabricators');
    assert.ok(row.jobWorkerGstin?.startsWith('29'), 'the job worker’s GSTIN, not the supplier’s');
    // Ravi is in Karnataka: inter-state → IGST 18%, not CGST + SGST.
    assert.deepEqual([row.igstRate, row.cgstRate, row.taxableValue], [18, 0, 220000]);
    const pending = pendingJobWork(t.db, t.today, { asOf: '2026-06-30', partyLedgerId: L.ravi });
    assert.deepEqual(pending.rows.map((p) => [p.itemName, p.pendingQty, p.partyName]), [['Steel Sheet', 40, 'Ravi Fabricators']]);
    t.close();
  });

  test('goods moved on to a second job worker keep the original challan date for s.143 (and appear once in table 4)', () => {
    const k = mfgKit();
    const { t, I, L, G } = k;
    const kiran = t.addLedger({ name: 'Kiran Platers', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(21)) });
    const kiranGodown = saveGodown(t.ctx, { name: 'Kiran Platers (JW)', thirdPartyKind: 'ours_with_party', partyLedgerId: kiran }).id;
    // 10-May-2025: 60 kg to Ravi (challan 1).  01-Mar-2026: 20 kg of it moved on from Ravi to Kiran.
    materialOut(k, '2025-05-10', G.ravi, L.ravi, [{ role: 'transfer', itemId: I.steel, qty: 60, rate: 50 }]);
    const onward = materialOut(k, '2026-03-01', kiranGodown, kiran, [{ role: 'transfer', itemId: I.steel, qty: 20, godownId: G.ravi }]);
    const res = pendingJobWork(t.db, t.today, { asOf: '2026-06-30' });
    const atKiran = res.rows.find((r) => r.godownId === kiranGodown);
    assert.ok(atKiran);
    // Due one year from 10-May-2025 (the day the principal sent it out), not from the 01-Mar-2026 transfer.
    assert.deepEqual([atKiran.sentOn, atKiran.dueDate, atKiran.status, atKiran.pendingQty, atKiran.challanNo], ['2025-05-10', '2026-05-10', 'overdue', 20, '1']);
    assert.equal(atKiran.voucherId, onward.id, 'drills down to the transfer');
    assert.equal(atKiran.pendingValue, 100000, '20 kg of the ₹3,000.00 challan for 60 kg');
    const atRavi = res.rows.find((r) => r.godownId === G.ravi);
    assert.equal(atRavi?.pendingQty, 40);
    assert.equal(res.counts.overdue, 2);

    const fy = itc04(t.db, t.today, { from: '2025-04-01', to: '2026-03-31' });
    assert.deepEqual(fy.sent.map((s) => [s.challanNo, s.qty, s.jobWorkerName]), [['1', 60, 'Ravi Fabricators']], 'the onward transfer is not a new table 4 challan');
    const b5 = fy.returned.filter((x) => x.table === '5B');
    assert.deepEqual(b5.map((x) => [x.jobWorkerName, x.originalChallanNo, x.originalChallanDate, x.qty]), [['Ravi Fabricators', '1', '2025-05-10', 20]]);
    // Row keys are unique (the screen keys its table rows by them).
    const keys = [...fy.sent.map((s) => s.key), ...fy.returned.map((x) => `${x.table}:${x.key}`)];
    assert.equal(new Set(keys).size, keys.length);
    t.close();
  });

  test('table 5A shows the job worker’s own challan number (the Material In reference) when entered', () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    materialOut(k, '2026-05-10', G.ravi, L.ravi, [
      { role: 'transfer', itemId: I.steel, qty: 10, rate: 50 },
      { role: 'transfer', itemId: I.steel, qty: 10, rate: 50 },
    ]);
    post(k, {
      voucherTypeId: VT.materialIn,
      date: '2026-06-15',
      mode: 'inventory',
      partyLedgerId: L.ravi,
      referenceNo: 'RF/77',
      stockJournal: { thirdPartyGodownId: G.ravi, lines: [{ role: 'transfer', itemId: I.steel, qty: 15 }] },
    });
    const r = itc04(t.db, t.today, { from: '2026-04-01', to: '2027-03-31' });
    // Two identical challan lines (same item and quantity) stay two distinct rows.
    assert.equal(r.sent.length, 2);
    assert.notEqual(r.sent[0].key, r.sent[1].key);
    assert.deepEqual(r.returned.map((x) => [x.table, x.docNo, x.originalChallanNo, x.qty]), [
      ['5A', 'RF/77', '1', 10],
      ['5A', 'RF/77', '1', 5],
    ]);
    assert.notEqual(r.returned[0].key, r.returned[1].key);
    const pending = pendingJobWork(t.db, t.today, { asOf: '2026-06-30' }) as PendingJobWorkResult;
    assert.deepEqual(pending.rows.map((p) => p.pendingQty), [5]);
    t.close();
  });
});

describe('mfg review — journals read back for alteration', () => {
  test('optional, post-dated and the reference no. are returned; a duplicate drops the reference', () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    const saved = post(k, {
      voucherTypeId: VT.materialIn,
      date: '2026-06-15',
      mode: 'inventory',
      partyLedgerId: L.mehta,
      referenceNo: 'MT/9',
      stockJournal: { thirdPartyGodownId: G.mehta, lines: [{ role: 'receipt', itemId: I.fabric, qty: 5 }] },
    });
    setVoucherOptional(t.ctx, saved.id, true, true);
    const d = getJournal(t.ctx, saved.id);
    assert.deepEqual([d.isOptional, d.isPostDated, d.referenceNo], [true, false, 'MT/9']);
    const dup = duplicateJournal(t.ctx, saved.id);
    assert.deepEqual([dup.isOptional, dup.referenceNo], [false, null]);
    t.close();
  });

  test('production register: several journals each get their own lines and costs', () => {
    const k = mfgKit();
    const { t, I, L, VT } = k;
    const make = (date: string, steel: number, chairs: number, labour: number) =>
      post(k, {
        voucherTypeId: VT.manufacturing,
        date,
        mode: 'inventory',
        stockJournal: {
          lines: [
            { role: 'component', itemId: I.steel, qty: steel },
            { role: 'product', itemId: I.chair, qty: chairs },
          ],
          additionalCosts: [{ ledgerId: L.labour, basis: 'amount', value: labour }],
        },
      });
    make('2026-05-01', 10, 2, 10000); // 10 kg × ₹50 = 500.00 + 100.00 = 600.00
    make('2026-05-02', 20, 4, 30000); // 20 kg × ₹50 = 1,000.00 + 300.00 = 1,300.00
    const reg = productionRegister(t.ctx, { from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(
      reg.rows.map((r) => [r.consumed, r.additional, r.productValue]),
      [
        [50000, 10000, 60000],
        [100000, 30000, 130000],
      ],
    );
    assert.deepEqual([reg.totals.consumed, reg.totals.additional, reg.totals.productValue], [150000, 40000, 190000]);
    t.close();
  });
});

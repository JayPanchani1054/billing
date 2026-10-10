import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BomDetail, Itc04Result, JobWorkAlerts, JobWorkOrderDetail, PendingJobWorkResult } from '../../../shared/types/mfg.ts';
import type { GodownDto } from '../../../shared/types/inventory.ts';
import type { VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { closingStockValue } from '../inventory/valuation.ts';
import { mfgKit } from './testkit.ts';

/**
 * The principal's job work flow end to end through the route dispatcher (what the screens call):
 *   godown master (job worker's godown) → BOM → Job Work Out Order → Material Out (challan) → Material In
 *   (finished goods back, components consumed there, job charges) → pending job work, s.143 alerts, ITC-04,
 *   order progress — with the Balance Sheet stock unchanged by the moves to and from the job worker.
 *
 * Kit opening: steel 100 kg @ ₹50 = 5,000.00 (+ paint 2,000.00, die 25,000.00) = 32,000.00.
 *   10-Apr-2026  Material Out: 40 kg steel to "Asha Works (JW)" (challan rate ₹50 → ₹2,000.00)
 *   20-Apr-2026  Material In: 6 chairs; 30 kg steel consumed there; job charges ₹300.00
 *                → chairs 30 × ₹50 + 300 = ₹1,800.00 (₹300 each); 10 kg (₹500.00) still with Asha.
 *   Closing stock 30-Jun-2026 = 32,000.00 − 1,500.00 consumed + 1,800.00 chairs = 32,300.00
 *   (the ₹300.00 job charges are capitalised into the chairs; their expense is booked separately.)
 */
describe('mfg end to end through the dispatcher', () => {
  test('godown → BOM → order → Material Out → Material In → pending, alerts, ITC-04', async () => {
    const k = mfgKit();
    const { t, I, L, VT } = k;
    const before = closingStockValue(t.db, { asOf: '2026-06-30', today: t.today });
    assert.equal(before, 3200000);

    const asha = { id: t.addLedger({ name: 'Asha Works', group: 'SUNDRY_CREDITORS' }) };
    const godown = await t.callOk<GodownDto>(routes, 'inventory.godown.save', { name: 'Asha Works (JW)', thirdPartyKind: 'ours_with_party', partyLedgerId: asha.id });
    assert.deepEqual([godown.thirdPartyKind, godown.isThirdParty, godown.partyName], ['ours_with_party', true, 'Asha Works']);

    const bom = await t.callOk<BomDetail>(routes, 'mfg.bom.save', { itemId: I.chair, name: 'Job work', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 5 }] });
    const order = await t.callOk<JobWorkOrderDetail>(routes, 'mfg.jobWorkOrder.save', {
      direction: 'out',
      date: '2026-04-05',
      partyLedgerId: asha.id,
      godownId: godown.id,
      itemId: I.chair,
      qty: 8,
      bomId: bom.id,
      process: 'Welding',
      lines: [],
    });
    assert.equal(order.number, 'JWO-1');
    assert.deepEqual(order.lines.map((l) => [l.itemName, l.qty]), [['Steel Sheet', 40]], 'material exploded from the BOM: 8 × 5 kg');

    const out = await t.callOk<VoucherSaveResult>(routes, 'vouchers.save', {
      voucherTypeId: VT.materialOut,
      date: '2026-04-10',
      mode: 'inventory',
      partyLedgerId: asha.id,
      acknowledgeWarnings: true,
      stockJournal: { thirdPartyGodownId: godown.id, jobWorkOrderId: order.id, process: 'Welding', lines: [{ role: 'transfer', itemId: I.steel, qty: 40, rate: 50, goodsType: 'inputs' }] },
    });
    assert.ok(out.id > 0);
    assert.equal(closingStockValue(t.db, { asOf: '2026-06-30', today: t.today }), before, 'goods with the job worker are still ours');

    await t.callOk<VoucherSaveResult>(routes, 'vouchers.save', {
      voucherTypeId: VT.materialIn,
      date: '2026-04-20',
      mode: 'inventory',
      partyLedgerId: asha.id,
      acknowledgeWarnings: true,
      stockJournal: {
        thirdPartyGodownId: godown.id,
        jobWorkOrderId: order.id,
        bomId: bom.id,
        process: 'Welding',
        lines: [
          { role: 'product', itemId: I.chair, qty: 6 },
          { role: 'component', itemId: I.steel, qty: 30 },
        ],
        additionalCosts: [{ ledgerId: L.jobCharges, basis: 'amount', value: 30000 }],
      },
    });
    assert.equal(closingStockValue(t.db, { asOf: '2026-06-30', today: t.today }), 3230000);

    const progress = await t.callOk<JobWorkOrderDetail>(routes, 'mfg.jobWorkOrder.get', { id: order.id });
    assert.deepEqual([progress.lines[0].sentQty, progress.lines[0].returnedQty, progress.productDoneQty, progress.vouchers.length], [40, 30, 6, 2]);

    const pending = await t.callOk<PendingJobWorkResult>(routes, 'mfg.jobWork.pending', { asOf: '2026-06-30', direction: 'out', partyLedgerId: asha.id });
    assert.deepEqual(pending.rows.map((r) => [r.itemName, r.sentQty, r.returnedQty, r.pendingQty, r.pendingValue, r.dueDate, r.status]), [['Steel Sheet', 40, 30, 10, 50000, '2027-04-10', 'ok']]);

    // A year later the 10 kg are overdue (s.143(3): deemed supplied on 10-Apr-2026).
    const alerts = await t.callOk<JobWorkAlerts>(routes, 'mfg.jobWork.alerts', { asOf: '2027-04-11' });
    assert.ok(alerts.overdue >= 1);
    assert.ok(alerts.overdueValue >= 50000);

    const itc = await t.callOk<Itc04Result>(routes, 'mfg.itc04.report', { from: '2026-04-01', to: '2026-09-30', aatoAbove5Cr: true });
    assert.equal(itc.frequency, 'half_yearly');
    assert.equal(itc.dueDate, '2026-10-25');
    const sent = itc.sent.filter((s) => s.jobWorkerName === 'Asha Works');
    assert.deepEqual(sent.map((s) => [s.challanDate, s.qty, s.taxableValue, s.hsn]), [['2026-04-10', 40, 200000, '7208']]);
    const back = itc.returned.filter((r) => r.jobWorkerName === 'Asha Works');
    assert.deepEqual(back.map((r) => [r.table, r.qty, r.originalChallanDate, r.receivedDescription, r.receivedQty, r.natureOfJobWork]), [['5A', 30, '2026-04-10', 'Chair', 6, 'Welding']]);

    // Every mutation is in the edit log.
    const audited = t.db.all<{ entity_type: string }>(`SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IN ('bom', 'job_work_order', 'godown', 'voucher')`).map((r) => r.entity_type).sort();
    assert.deepEqual(audited, ['bom', 'godown', 'job_work_order', 'voucher']);
    t.close();
  });
});

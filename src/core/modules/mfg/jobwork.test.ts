import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Itc04Result, PendingJobWorkResult } from '../../../shared/types/mfg.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { AppError } from '../../lib/errors.ts';
import { setPeriodLock } from '../company/service.ts';
import { saveGodown } from '../inventory/masters.ts';
import { closingStockValue, computeStockValuation } from '../inventory/valuation.ts';
import { godownSummary } from '../stock/summary.ts';
import { saveBom } from './bom.ts';
import { itc04, jobWorkAlerts, pendingJobWork } from './jobwork.ts';
import { deleteJobWorkOrder, getJobWorkOrder, listJobWorkOrders, saveJobWorkOrder } from './orders.ts';
import { mfgKit, post, type MfgKit } from './testkit.ts';

/**
 * Principal side (we give job work to Ravi Fabricators, Karnataka — inter-state):
 *   01-May-2025  Job Work Out Order JWO-1: 10 chairs, BOM "JW" (5 kg steel per chair) → send 50 kg
 *   10-May-2025  Material Out 1: Steel 60 kg @ ₹50 (inputs, challan ₹3,000.00) + Press Die (tool)
 *   15-Jun-2025  Material In 1: 10 chairs received; 50 kg steel consumed at the job worker; job charges ₹500
 *                → chair = 50 × ₹50 + ₹500 = ₹3,000.00
 *   20-Jun-2026  Material Out 1 of 2026-27: Steel 5 kg @ ₹50
 * As on 30-Jun-2026 with the job worker: 10 kg of challan 1 (due 10-May-2026 → overdue 51 days), the die
 * (no time limit), 5 kg of challan 2 (due 20-Jun-2027).
 */
function principal(): { k: MfgKit; orderId: number; mo1: number; mi1: number } {
  const k = mfgKit();
  const { t, I, L, G, VT } = k;
  const bom = saveBom(t.ctx, { itemId: I.chair, name: 'JW', outputQty: 1, lines: [{ kind: 'component', itemId: I.steel, qty: 5 }] });
  const order = saveJobWorkOrder(t.ctx, {
    direction: 'out',
    date: '2025-05-01',
    partyLedgerId: L.ravi,
    godownId: G.ravi,
    itemId: I.chair,
    qty: 10,
    bomId: bom.id,
    dueDate: '2025-06-30',
    process: 'Fabrication',
    lines: [],
  });
  const mo = (date: string, lines: NonNullable<VoucherInput['stockJournal']>['lines']): number =>
    post(k, {
      voucherTypeId: VT.materialOut,
      date,
      mode: 'inventory',
      partyLedgerId: L.ravi,
      stockJournal: { thirdPartyGodownId: G.ravi, jobWorkOrderId: date < '2026-01-01' ? order.id : undefined, process: 'Fabrication', lines },
    }).id;
  const mo1 = mo('2025-05-10', [
    { role: 'transfer', itemId: I.steel, qty: 60, rate: 50, goodsType: 'inputs' },
    { role: 'transfer', itemId: I.die, qty: 1, goodsType: 'tools' },
  ]);
  const mi1 = post(k, {
    voucherTypeId: VT.materialIn,
    date: '2025-06-15',
    mode: 'inventory',
    partyLedgerId: L.ravi,
    stockJournal: {
      thirdPartyGodownId: G.ravi,
      jobWorkOrderId: order.id,
      bomId: bom.id,
      process: 'Fabrication',
      lines: [
        { role: 'product', itemId: I.chair, qty: 10 },
        { role: 'component', itemId: I.steel, qty: 50 },
      ],
      additionalCosts: [{ ledgerId: L.jobCharges, basis: 'amount', value: 50000 }],
    },
  }).id;
  mo('2026-06-20', [{ role: 'transfer', itemId: I.steel, qty: 5, rate: 50 }]);
  return { k, orderId: order.id, mo1, mi1 };
}

describe('Job work — principal (our stock with a job worker)', () => {
  test('stock sent stays ours: valued, in the Balance Sheet, per godown', () => {
    const { k } = principal();
    const { t, I, G } = k;
    const steel = computeStockValuation(t.db, { from: '2025-04-01', to: '2026-06-30', today: t.today, itemIds: [I.steel] }).rows[0];
    // 100 − 50 consumed by the job worker = 50 kg @ ₹50
    assert.deepEqual([steel.closing.qty, steel.closing.value], [50, 250000]);
    const atJw = computeStockValuation(t.db, { from: '2026-06-30', to: '2026-06-30', today: t.today, itemIds: [I.steel], godownId: G.ravi }).rows[0];
    assert.equal(atJw.closing.qty, 15);
    assert.equal(atJw.closing.value, 75000);
    const chair = computeStockValuation(t.db, { from: '2025-04-01', to: '2026-06-30', today: t.today, itemIds: [I.chair] }).rows[0];
    assert.equal(chair.closing.value, 300000, '50 kg × ₹50 + job charges ₹500');
    // Opening 5,000 + 2,000 + 25,000 = 32,000.00 + job charges 500.00
    assert.equal(closingStockValue(t.db, { asOf: '2026-06-30', today: t.today }), 3250000);
    t.close();
  });

  test('pending job work and the s.143 deadlines', () => {
    const { k } = principal();
    const { t } = k;
    const res = pendingJobWork(t.db, t.today, { asOf: '2026-06-30' });
    assert.deepEqual(
      res.rows.map((r) => [r.itemName, r.challanNo, r.sentOn, r.pendingQty, r.goodsType, r.dueDate, r.status, r.pendingValue]),
      [
        ['Steel Sheet', '1', '2025-05-10', 10, 'inputs', '2026-05-10', 'overdue', 50000],
        // Numbering restarts with the financial year: the 2026-27 challan is no. 1 again.
        ['Steel Sheet', '1', '2026-06-20', 5, 'inputs', '2027-06-20', 'ok', 25000],
        ['Press Die', '1', '2025-05-10', 1, 'tools', null, 'no_limit', 2500000],
      ],
    );
    assert.equal(res.rows[0].daysLeft, -51);
    assert.equal(res.rows[0].orderNo, 'JWO-1');
    assert.deepEqual(res.counts, { overdue: 1, dueSoon: 0, total: 3 });
    const alerts = jobWorkAlerts(t.db, t.today, '2026-06-30');
    assert.deepEqual([alerts.overdue, alerts.overdueValue], [1, 50000]);
    // Before the first deadline nothing is overdue; 30 days before it the challan is "due soon".
    assert.equal(jobWorkAlerts(t.db, t.today, '2026-04-15').dueSoon, 1);
    t.close();
  });

  test('ITC-04: table 4 (sent) and 5A (received back) with the original challan', () => {
    const { k } = principal();
    const { t } = k;
    const r = itc04(t.db, t.today, { from: '2025-04-01', to: '2026-03-31' });
    assert.equal(r.frequency, 'annual');
    assert.equal(r.dueDate, '2026-04-25');
    assert.deepEqual(
      r.sent.map((s) => [s.challanNo, s.challanDate, s.description, s.goodsType, s.qty, s.uqc, s.taxableValue, s.igstRate, s.cgstRate, s.hsn]),
      [
        ['1', '2025-05-10', 'Steel Sheet', 'inputs', 60, 'KGS', 300000, 18, 0, '7208'],
        ['1', '2025-05-10', 'Press Die', 'tools', 1, 'NOS', 2500000, 18, 0, '8207'],
      ],
    );
    assert.ok(r.sent[0].jobWorkerGstin?.startsWith('29'));
    assert.deepEqual(
      r.returned.map((x) => [x.table, x.docNo, x.originalChallanNo, x.originalChallanDate, x.description, x.qty, x.receivedDescription, x.receivedQty, x.natureOfJobWork]),
      [['5A', '1', '1', '2025-05-10', 'Steel Sheet', 50, 'Chair', 10, 'Fabrication']],
    );
    const next = itc04(t.db, t.today, { from: '2026-04-01', to: '2027-03-31' });
    assert.equal(next.sent.length, 1);
    assert.equal(next.returned.length, 0);
    t.close();
  });

  test('job work order progress, list, delete refused while linked', () => {
    const { k, orderId } = principal();
    const { t } = k;
    const o = getJobWorkOrder(t.db, orderId);
    assert.equal(o.number, 'JWO-1');
    assert.deepEqual(o.lines.map((l) => [l.itemName, l.qty, l.sentQty, l.returnedQty]), [['Steel Sheet', 50, 60, 50]]);
    assert.equal(o.productDoneQty, 10);
    assert.equal(o.vouchers.length, 2);
    const list = listJobWorkOrders(t.db, t.today, { direction: 'out' });
    assert.deepEqual(list.rows.map((r) => [r.number, r.pendingQty, r.overdue]), [['JWO-1', 0, false]]);
    assert.throws(() => deleteJobWorkOrder(t.ctx, orderId), (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE');
    const second = saveJobWorkOrder(t.ctx, { direction: 'out', date: '2026-06-01', partyLedgerId: k.L.ravi, itemId: k.I.chair, qty: 4, dueDate: '2026-06-10', lines: [] });
    assert.equal(second.number, 'JWO-2');
    assert.equal(listJobWorkOrders(t.db, t.today, { direction: 'out' }).rows.find((r) => r.number === 'JWO-2')?.overdue, true);
    deleteJobWorkOrder(t.ctx, second.id);
    t.close();
  });

  test('rules: job work godown and party required, roles by godown kind, order of another party', () => {
    const { k, orderId } = principal();
    const { t, I, L, G, VT } = k;
    const fails = (input: VoucherInput, re: RegExp): void => {
      assert.throws(() => post(k, input), (e: unknown) => e instanceof AppError && re.test(`${e.message} ${JSON.stringify(e.details ?? '')}`));
    };
    const base: VoucherInput = { voucherTypeId: VT.materialOut, date: '2026-06-25', mode: 'inventory', partyLedgerId: L.ravi, stockJournal: { thirdPartyGodownId: G.ravi, lines: [{ role: 'transfer', itemId: I.steel, qty: 1 }] } };
    fails({ ...base, stockJournal: { lines: [{ role: 'transfer', itemId: I.steel, qty: 1 }] } }, /thirdPartyGodownId/);
    fails({ ...base, partyLedgerId: undefined }, /partyLedgerId/);
    fails({ ...base, stockJournal: { thirdPartyGodownId: G.main, lines: [{ role: 'transfer', itemId: I.steel, qty: 1 }] } }, /own godowns/);
    fails({ ...base, stockJournal: { thirdPartyGodownId: G.ravi, lines: [{ role: 'product', itemId: I.chair, qty: 1 }] } }, /transfer lines/);
    fails({ ...base, partyLedgerId: L.mehta, stockJournal: { thirdPartyGodownId: G.ravi, jobWorkOrderId: orderId, lines: [{ role: 'transfer', itemId: I.steel, qty: 1 }] } }, /another party/);
    t.close();
  });

  test('godown kind cannot change under locked books', () => {
    const { k } = principal();
    const { t, G } = k;
    setPeriodLock(t.ctx, '2025-12-31');
    assert.throws(
      () => saveGodown(t.ctx, { id: G.ravi, name: 'Ravi Fabricators (JW)', thirdPartyKind: 'none' }),
      (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /locked period/.test(e.message),
    );
    t.close();
  });
});

describe('Job work — job worker (a principal’s stock with us)', () => {
  test('received material is never valued or in the Balance Sheet; quantities are tracked per godown', async () => {
    const k = mfgKit();
    const { t, I, L, G, VT } = k;
    const before = closingStockValue(t.db, { asOf: '2026-06-30', today: t.today });
    post(k, {
      voucherTypeId: VT.materialIn,
      date: '2026-06-01',
      mode: 'inventory',
      partyLedgerId: L.mehta,
      stockJournal: { thirdPartyGodownId: G.mehta, lines: [{ role: 'receipt', itemId: I.fabric, qty: 100, rate: 100 }] },
    });
    post(k, {
      voucherTypeId: VT.materialOut,
      date: '2026-06-25',
      mode: 'inventory',
      partyLedgerId: L.mehta,
      stockJournal: { thirdPartyGodownId: G.mehta, lines: [{ role: 'issue', itemId: I.fabric, qty: 60 }] },
    });
    assert.equal(closingStockValue(t.db, { asOf: '2026-06-30', today: t.today }), before);
    const whole = computeStockValuation(t.db, { from: '2026-04-01', to: '2026-06-30', today: t.today });
    assert.equal(whole.rows.find((r) => r.itemId === I.fabric), undefined, 'not in our stock summary');
    const there = computeStockValuation(t.db, { from: '2026-04-01', to: '2026-06-30', today: t.today, godownId: G.mehta, itemIds: [I.fabric] }).rows[0];
    assert.deepEqual([there.inward.qty, there.outward.qty, there.closing.qty, there.closing.value], [100, 60, 40, 0]);
    const gs = godownSummary(t.db, t.today, { asOf: '2026-06-30' });
    const fabric = gs.rows.find((r) => r.kind === 'item' && r.itemId === I.fabric);
    assert.deepEqual([fabric?.qty, fabric?.value], [40, 0]);
    assert.equal(gs.totalValue, before, 'the godown summary total still equals the Balance Sheet stock');

    const pending = await t.callOk<PendingJobWorkResult>(routes, 'mfg.jobWork.pending', { asOf: '2026-06-30', direction: 'in' });
    assert.deepEqual(pending.rows.map((r) => [r.itemName, r.sentQty, r.returnedQty, r.pendingQty, r.pendingValue]), [['Fabric', 100, 60, 40, 400000]]);
    const report = await t.callOk<Itc04Result>(routes, 'mfg.itc04.report', { from: '2026-04-01', to: '2027-03-31' });
    assert.equal(report.sent.length, 0, 'ITC-04 is the principal’s return');
    t.close();
  });
});

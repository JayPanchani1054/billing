import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPrintDataFor } from '../print/data.ts';
import { mfgKit, post } from './testkit.ts';

/**
 * Material Out prints as the job work delivery challan (CGST rule 55(1)(c)): the voucher type created by
 * the Job work feature carries the title; the consignee is the job worker with GSTIN and state; each line
 * has HSN, quantity and the challan (taxable) value — 60 kg × ₹50 = ₹3,000.00. Job work is not a supply,
 * so no tax is charged on the challan.
 */
describe('Material Out challan print', () => {
  test('title, job worker, HSN, quantity and challan value', () => {
    const k = mfgKit();
    const id = post(k, {
      voucherTypeId: k.VT.materialOut,
      date: '2026-05-10',
      mode: 'inventory',
      partyLedgerId: k.L.ravi,
      stockJournal: { thirdPartyGodownId: k.G.ravi, process: 'Fabrication', lines: [{ role: 'transfer', itemId: k.I.steel, qty: 60, rate: 50, goodsType: 'inputs' }] },
    }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.title, 'Delivery Challan (Job Work)');
    assert.equal(d.party?.name, 'Ravi Fabricators');
    assert.equal(d.party?.stateCode, '29');
    const sent = d.lines.find((l) => l.section === 'production');
    assert.ok(sent);
    assert.deepEqual([sent.name, sent.hsnSac, sent.qty, sent.amount, sent.tax], ['Steel Sheet', '7208', 60, 300000, 0]);
    assert.equal(d.totals.grandTotal, 300000);
    k.t.close();
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Gstr3bChangeRow, Rule37Result, Rule37Row } from '../../../../shared/types/gst-plus.ts';
import { gstr3bChangesExport, rule37Actionable, rule37Export } from './gaps.ts';

const z = { igst: 0, cgst: 0, sgst: 0, cess: 0 };

describe('gst gaps helpers', () => {
  test('GSTR-3B changes export: one row per change with the net deltas', () => {
    const row: Gstr3bChangeRow = {
      id: 1, voucherId: null, kind: 'removed', label: 'Purchase 7', docDate: '2026-05-07', originalPeriod: '052026', reportPeriod: '062026',
      original: null, amended: null, liabilityDelta: z, itcDelta: { igst: 0, cgst: -25000, sgst: -25000, cess: 0 }, updatedAt: '',
    };
    const e = gstr3bChangesExport([row]);
    assert.deepEqual(e.rows[0], ['Deleted / cancelled', 'Purchase 7', '2026-05-07', '052026', '062026', 0, -50000]);
    assert.equal(e.columns.length, e.rows[0].length);
  });

  test('Rule 37: actionable rows per action and the export totals', () => {
    const base: Rule37Row = {
      voucherId: 1, number: '1', date: '2026-04-10', referenceNo: 'R-1', partyLedgerId: 9, partyName: 'Supplier', deadline: '2026-10-07',
      reportPeriod: '112026', reportPeriodLabel: 'Nov 2026', value: 1050000, unpaid: 420000, itc: { igst: 0, cgst: 25000, sgst: 25000, cess: 0 },
      due: { igst: 0, cgst: 10000, sgst: 10000, cess: 0 }, reversed: z, toReverse: { igst: 0, cgst: 10000, sgst: 10000, cess: 0 }, toReclaim: z,
    };
    const paid: Rule37Row = { ...base, voucherId: 2, unpaid: 0, due: z, reversed: { igst: 0, cgst: 100, sgst: 0, cess: 0 }, toReverse: z, toReclaim: { igst: 0, cgst: 100, sgst: 0, cess: 0 } };
    const r: Rule37Result = { asOf: '2026-12-15', rows: [base, paid], totals: { toReverse: base.toReverse, toReclaim: paid.toReclaim, unpaid: 420000 }, notBillWise: [], notes: [] };
    assert.deepEqual(rule37Actionable(r, 'reversal').map((x) => x.voucherId), [1]);
    assert.deepEqual(rule37Actionable(r, 'reclaim').map((x) => x.voucherId), [2]);
    const e = rule37Export(r);
    assert.equal(e.rows.length, 2);
    assert.deepEqual(e.rows[0].slice(-2), [20000, 0]);
    assert.deepEqual(e.totals?.slice(-2), [20000, 100]);
    assert.equal(e.columns.length, e.totals?.length);
  });
});

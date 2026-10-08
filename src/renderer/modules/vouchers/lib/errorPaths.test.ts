import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherWarning } from '../../../../shared/types/vouchers.ts';
import { ACCOUNT_ROW } from './buildInput.ts';
import { cellId, confirmationRequest, headerId, mapFieldErrors, parseCellId, parsePath, splitWarnings, targetOf, warningsByRow, warningsOfDetails } from './errorPaths.ts';

const maps = { itemKeys: ['i3', 'i7', 'i9'], ledgerKeys: [ACCOUNT_ROW, 'l2'] };

describe('server paths → cells', () => {
  it('parses line and header paths', () => {
    assert.deepEqual(parsePath('items[2].qty'), { section: 'items', index: 2, field: 'qty', rest: 'qty' });
    assert.deepEqual(parsePath('ledgers[1].billAllocations[0].billName'), { section: 'ledgers', index: 1, field: 'billAllocations', rest: 'billAllocations[0].billName' });
    assert.deepEqual(parsePath('items'), { section: 'items', index: null, field: null, rest: null });
    assert.equal(parsePath('exportDetails.withPayment').field, 'exportDetails');
  });

  it('maps through the key maps (input index ≠ row index once blanks are dropped)', () => {
    assert.deepEqual(targetOf('items[2].qty', maps), { id: cellId('items', 'i9', 'qty'), section: 'items', rowKey: 'i9', column: 'qty' });
    assert.equal(targetOf('items[1].batchName', maps)?.id, cellId('items', 'i7', 'batch'));
    assert.equal(targetOf('items[0].discountPct', maps)?.column, 'disc');
    assert.equal(targetOf('ledgers[1].ledgerId', maps)?.id, cellId('ledgers', 'l2', 'ledger'));
    assert.equal(targetOf('ledgers[1].billAllocations[0].amount', maps)?.column, 'amount');
    assert.equal(targetOf('ledgers[0].ledgerId', maps)?.id, headerId('account'));
    assert.equal(targetOf('partyLedgerId', maps)?.id, headerId('party'));
    assert.equal(targetOf('items[5].qty', maps), null);
    assert.equal(targetOf('exportDetails.withPayment', maps), null);
  });

  it('mapFieldErrors: first placed target and unplaced messages', () => {
    const m = mapFieldErrors({ 'items[1].qty': 'Quantity must be whole', 'items[1].rate': 'Rate?', items: 'Enter at least one item', 'items[0].itemId': 'Inactive' }, maps);
    assert.equal(m.cells[cellId('items', 'i7', 'qty')], 'Quantity must be whole');
    assert.equal(m.cells[cellId('items', 'i3', 'item')], 'Inactive');
    assert.deepEqual(m.general, ['Enter at least one item']);
    assert.equal(m.first?.rowKey, 'i7');
  });
});

describe('warnings', () => {
  const w = (code: VoucherWarning['code'], level: VoucherWarning['level'], path?: string): VoucherWarning => ({ code, message: code, level, blocking: level === 'block', path });

  it('split by level', () => {
    const s = splitWarnings([w('negative_stock', 'confirm'), w('gst_missing_hsn', 'info'), w('unbalanced', 'block')]);
    assert.deepEqual(
      [s.block.length, s.confirm.length, s.info.length],
      [1, 1, 1],
    );
  });

  it('group by row', () => {
    const g = warningsByRow([w('negative_stock', 'confirm', 'items[1]'), w('credit_limit', 'confirm', 'partyLedgerId'), w('gst', 'info')], maps);
    assert.equal(g.rows.i7.length, 1);
    assert.equal(g.header.length, 2);
  });

  it('reads details tolerantly', () => {
    const d = warningsOfDetails({ needsConfirmation: true, warnings: [w('negative_stock', 'confirm'), 'plain text', 7] });
    assert.equal(d.needsConfirmation, true);
    assert.equal(d.warnings.length, 2);
    assert.equal(d.warnings[1].message, 'plain text');
    assert.deepEqual(warningsOfDetails(null), { needsConfirmation: false, warnings: [] });
  });
});

describe('cell ids and confirmation requests', () => {
  it('parseCellId inverts cellId', () => {
    assert.deepEqual(parseCellId(cellId('items', 'i12', 'qty')), { section: 'items', rowKey: 'i12', column: 'qty' });
    assert.deepEqual(parseCellId(cellId('ledgers', 'l3', 'amount')), { section: 'ledgers', rowKey: 'l3', column: 'amount' });
    assert.equal(parseCellId(headerId('party')), null);
    assert.equal(parseCellId(null), null);
  });

  it('confirmationRequest asks only about confirm-level warnings', () => {
    const w = (code: VoucherWarning['code'], level: VoucherWarning['level'], message: string): VoucherWarning => ({ code, level, message, blocking: level === 'block' });
    const details = { needsConfirmation: true, warnings: [w('gst_missing_hsn', 'info', 'HSN missing on line 1'), w('negative_stock', 'confirm', 'Rice goes below zero')] };
    const r = confirmationRequest(details);
    assert.deepEqual(r?.confirm, ['Rice goes below zero']);
    assert.equal(r?.info.length, 1);
    assert.equal(r?.all.length, 2);
    assert.equal(confirmationRequest({ warnings: [w('unbalanced', 'block', 'Not balanced')] }), null);
    assert.equal(confirmationRequest(undefined), null);
  });
});

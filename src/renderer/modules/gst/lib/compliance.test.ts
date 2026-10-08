import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EinvoiceImportResult } from '../../../../shared/types/gst-returns.ts';
import {
  cancelWindowText,
  formatIstDateTime,
  irnCancelReasonText,
  docEventDetail,
  docEventLabel,
  importSummary,
  normaliseEwbNo,
  pruneSelection,
  rejectedFromDetails,
  selectionState,
  toggleAllReady,
  toggleSelection,
  validateEwbForm,
} from './compliance.ts';

const rows = [
  { voucherId: 1, ready: true },
  { voucherId: 2, ready: false },
  { voucherId: 3, ready: true },
];

describe('bulk selection', () => {
  it('toggles single rows and all ready rows', () => {
    let s = toggleSelection(new Set(), 1);
    assert.deepEqual([...s], [1]);
    assert.equal(selectionState(s, rows), 'some');
    s = toggleAllReady(s, rows);
    assert.deepEqual([...s].sort(), [1, 3]); // never the row with errors
    assert.equal(selectionState(s, rows), 'all');
    s = toggleAllReady(s, rows);
    assert.equal(s.size, 0);
    assert.equal(selectionState(s, rows), 'none');
    assert.deepEqual([...toggleSelection(new Set([1]), 1)], []);
  });

  it('drops ids that are no longer listed or ready after a refresh', () => {
    const s = pruneSelection(new Set([1, 2, 3, 9]), [{ voucherId: 1, ready: true }, { voucherId: 3, ready: false }]);
    assert.deepEqual([...s], [1]);
  });

  it('reads rejected vouchers from an error', () => {
    assert.deepEqual(
      rejectedFromDetails({ rejected: [{ voucherId: 5, number: 'S-5', errors: ['Buyer PIN missing', 7] }, { voucherId: 'x' }, null] }),
      [{ voucherId: 5, number: 'S-5', errors: ['Buyer PIN missing'] }],
    );
    assert.deepEqual(rejectedFromDetails(undefined), []);
    assert.deepEqual(rejectedFromDetails({ rejected: 'no' }), []);
  });
});

describe('e-way bill number entry', () => {
  it('normalises spaces and validates 12 digits', () => {
    assert.equal(normaliseEwbNo(' 1234 5678 9012 '), '123456789012');
    assert.deepEqual(validateEwbForm({ ewayBillNo: '1234 5678 9012', date: '2026-04-05', validUpto: '2026-04-06' }, '2026-04-05'), {});
    assert.match(validateEwbForm({ ewayBillNo: '12345', date: '2026-04-05', validUpto: null }, '2026-04-05').ewayBillNo ?? '', /12 digits — this one has 5/);
    assert.match(validateEwbForm({ ewayBillNo: '12345678901A', date: '2026-04-05', validUpto: null }, '2026-04-05').ewayBillNo ?? '', /digits only/);
    assert.match(validateEwbForm({ ewayBillNo: '', date: '2026-04-05', validUpto: null }, '2026-04-05').ewayBillNo ?? '', /Enter the 12-digit/);
  });

  it('checks the dates against the invoice', () => {
    const e = validateEwbForm({ ewayBillNo: '123456789012', date: '2026-04-04', validUpto: '2026-04-03' }, '2026-04-05');
    assert.match(e.date ?? '', /before the invoice date/);
    assert.match(e.validUpto ?? '', /on or after/);
    assert.match(validateEwbForm({ ewayBillNo: '123456789012', date: null, validUpto: null }, '2026-04-05').date ?? '', /Enter the date/);
  });
});

describe('IRP response import summary', () => {
  const base: EinvoiceImportResult = { records: 0, updated: [], unchanged: [], skipped: [], failed: [], warnings: [] };

  it('success, partial and nothing', () => {
    const ok = importSummary({ ...base, records: 2, updated: [{ voucherId: 1, number: 'S-1', irn: 'a', ackNo: '1', ewayBillNo: '111' }, { voucherId: 2, number: 'S-2', irn: 'b', ackNo: '2', ewayBillNo: null }] });
    assert.equal(ok.tone, 'success');
    assert.equal(ok.title, 'Imported 2 records from the IRP file');
    assert.deepEqual(ok.lines, ['2 invoices updated with the IRN (and e-way bill where given).']);

    const partial = importSummary({ ...base, records: 3, unchanged: [{ voucherId: 1, number: 'S-1' }], failed: [{ docNo: 'S-9', docDate: null, message: 'Duplicate IRN' }], skipped: [{ docNo: 'S-8', docDate: null, voucherId: null, reason: 'not found' }] });
    assert.equal(partial.tone, 'warning');
    assert.equal(partial.lines.length, 3);

    const none = importSummary({ ...base, records: 1, failed: [{ docNo: 'S-9', docDate: null, message: 'x' }] });
    assert.equal(none.tone, 'danger');
    assert.equal(importSummary(base).tone, 'info');
  });
});

describe('document trail', () => {
  it('labels events and flattens details as text', () => {
    assert.equal(docEventLabel({ kind: 'einvoice', action: 'generated' }), 'e-Invoice · IRN generated');
    assert.equal(docEventLabel({ kind: 'ewaybill', action: 'reissued' }), 'e-Way bill · Reissued');
    assert.equal(docEventDetail({ detail: { fileName: 'EINV_x.json', ackNo: '1234', empty: '' } }), 'File name: EINV_x.json · Ack no: 1234');
    assert.equal(docEventDetail({ detail: null }), '');
  });
});

describe('IRN cancellation', () => {
  it('formats instants in Indian time whatever the PC time zone', () => {
    // 12:30 UTC + 5:30 = 18:00 IST; 20:00 UTC = 01:30 IST the next day.
    assert.equal(formatIstDateTime('2026-05-10T12:30:00.000Z'), '10-May-2026 18:00');
    assert.equal(formatIstDateTime('2026-12-31T20:00:00.000Z'), '01-Jan-2027 01:30');
    assert.equal(formatIstDateTime('not a date'), 'not a date');
  });

  it('explains the 24-hour IRP window', () => {
    const until = '2026-05-10T12:30:00.000Z';
    assert.equal(cancelWindowText({ cancellableUntil: until, cancelWindowOpen: true, cancelledInBooks: false }), 'Can be cancelled on the IRP until 10-May-2026 18:00.');
    assert.match(cancelWindowText({ cancellableUntil: until, cancelWindowOpen: true, cancelledInBooks: true }), /^Cancelled in the books — cancel the IRN on the IRP before 10-May-2026 18:00\.$/);
    assert.match(cancelWindowText({ cancellableUntil: until, cancelWindowOpen: false, cancelledInBooks: false }), /closed on 10-May-2026 18:00\. To reverse this invoice, issue a credit note\.$/);
    assert.match(cancelWindowText({ cancellableUntil: null, cancelWindowOpen: false, cancelledInBooks: false }), /not recorded/);
  });

  it('builds the reason text; Others needs a remark', () => {
    assert.equal(irnCancelReasonText('data_entry', ''), 'Data entry mistake');
    assert.equal(irnCancelReasonText('duplicate', '  raised   twice '), 'Duplicate — raised twice');
    assert.equal(irnCancelReasonText('others', 'ab'), null);
    assert.equal(irnCancelReasonText('others', 'Buyer refused goods'), 'Others — Buyer refused goods');
    assert.equal(irnCancelReasonText('order_cancelled', 'x'.repeat(150))?.length, 'Order cancelled — '.length + 100);
  });
});

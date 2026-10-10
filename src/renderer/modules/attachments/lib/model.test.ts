import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AttachmentRegisterRow } from '../../../../shared/types/attachments.ts';
import { localDay, ownerTarget, pickedFileProblem, railLabel, registerExport, summaryText } from './model.ts';

const row = (over: Partial<AttachmentRegisterRow> = {}): AttachmentRegisterRow => ({
  id: 1,
  guid: 'g',
  entityType: 'voucher',
  entityId: 7,
  fileName: 'bill.pdf',
  ext: 'pdf',
  mime: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  note: null,
  createdAt: '2026-10-05T06:30:00.000Z',
  createdByName: 'Owner',
  fileOk: true,
  ownerLabel: 'Sales 42 (05-Oct-2026)',
  ownerDate: '2026-10-05',
  ...over,
});

describe('attachments UI model', () => {
  it('drills to the owner', () => {
    assert.deepEqual(ownerTarget(row()), { screen: 'vouchers.view', params: { id: 7 } });
    assert.deepEqual(ownerTarget(row({ entityType: 'ledger', entityId: 3 })), { screen: 'accounts.ledger.form', params: { id: 3 } });
    assert.deepEqual(ownerTarget(row({ entityType: 'stock_item', entityId: 4 })), { screen: 'inventory.item.form', params: { id: 4 } });
  });
  it('labels', () => {
    assert.equal(summaryText([]), 'No files attached');
    assert.equal(summaryText([row(), row({ sizeBytes: 1024 * 1024 })]), '2 files · 1.0 MB');
    assert.equal(railLabel(0), 'Attachments');
    assert.equal(railLabel(3), 'Attachments (3)');
  });
  it('checks a picked file before sending it', () => {
    assert.equal(pickedFileProblem('scan.PDF', 1000), null);
    assert.match(pickedFileProblem('virus.exe', 10) ?? '', /cannot be attached/);
    assert.match(pickedFileProblem('big.pdf', 26 * 1024 * 1024) ?? '', /at most 25\.0 MB/);
    assert.match(pickedFileProblem('empty.png', 0) ?? '', /empty/);
  });
  it('exports the register with local dates', () => {
    const e = registerExport([row()]);
    assert.equal(e.columns.length, e.rows[0].length);
    assert.equal(e.rows[0][3], 'bill.pdf');
    assert.equal(e.rows[0][4], 2);
    assert.match(localDay('2026-10-05T06:30:00.000Z'), /^2026-10-0[56]$/);
  });
});

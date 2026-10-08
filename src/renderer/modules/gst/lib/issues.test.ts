import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstIssue, GstIssueCode } from '../../../../shared/types/gst-returns.ts';
import { alterVoucherLink, codesPresent, countIssues, fixLinks, ISSUE_CODE_LABELS, issueSummaryText, issueVoucherLink, masterLink } from './issues.ts';

function issue(code: GstIssueCode, over: Partial<GstIssue> = {}): GstIssue {
  return {
    code,
    severity: 'error',
    voucherId: 42,
    voucherNumber: 'S-1',
    voucherTypeName: 'Sales',
    date: '2026-04-02',
    partyName: 'Acme Industries',
    section: 'b2b',
    message: 'm',
    fix: 'f',
    partyLedgerId: 7,
    itemId: null,
    lineLedgerId: null,
    ...over,
  };
}

describe('GST issue fix links', () => {
  it('HSN problem on an item line → stock item, then the voucher', () => {
    const links = fixLinks(issue('hsn_missing', { itemId: 9 }));
    assert.deepEqual(
      links.map((l) => [l.label, l.screen, l.params]),
      [
        ['Open stock item', 'inventory.item.form', { id: 9 }],
        ['Alter voucher', 'vouchers.entry', { id: 42 }],
      ],
    );
  });

  it('rate problem on an accounting line → its ledger', () => {
    const links = fixLinks(issue('rate_not_slab', { lineLedgerId: 15 }));
    assert.deepEqual(links[0], { label: 'Open ledger', screen: 'accounts.ledger.form', params: { id: 15 }, hint: 'Correct the HSN/SAC or GST rate in the sales / purchase ledger' });
  });

  it('GSTIN / state problems → party ledger, then the voucher', () => {
    const links = fixLinks(issue('gstin_invalid'));
    assert.deepEqual(
      links.map((l) => [l.screen, l.params]),
      [
        ['accounts.ledger.form', { id: 7 }],
        ['vouchers.entry', { id: 42 }],
      ],
    );
    assert.match(links[0].hint, /Acme Industries/);
    assert.deepEqual(fixLinks(issue('supplier_gstin_invalid')).map((l) => l.screen), ['accounts.ledger.form', 'vouchers.entry']);
  });

  it('voucher-only problems and period-level issues', () => {
    assert.deepEqual(fixLinks(issue('doc_no_invalid')).map((l) => l.screen), ['vouchers.entry']);
    // Issues produced before fix links existed (no ids) still offer the voucher.
    assert.deepEqual(fixLinks(issue('hsn_short', { itemId: undefined, partyLedgerId: undefined })).map((l) => l.screen), ['vouchers.entry']);
    const gap = issue('doc_series_gap', { voucherId: null, partyLedgerId: null, severity: 'warning' });
    assert.deepEqual(fixLinks(gap), []);
    assert.equal(issueVoucherLink(gap), null);
    assert.deepEqual(issueVoucherLink(issue('pos_missing'))?.params, { id: 42 });
  });

  it('counts and summarises', () => {
    const list = [issue('hsn_missing'), issue('hsn_missing'), issue('itc_time_limit', { severity: 'warning' })];
    assert.deepEqual(countIssues(list), { errors: 2, warnings: 1 });
    assert.equal(issueSummaryText(countIssues(list)), '2 errors and 1 warning');
    assert.equal(issueSummaryText({ errors: 0, warnings: 0 }), 'No problems found');
    assert.equal(issueSummaryText({ errors: 1, warnings: 0 }), '1 error');
    assert.deepEqual(codesPresent(list), [
      { code: 'hsn_missing', count: 2 },
      { code: 'itc_time_limit', count: 1 },
    ]);
  });

  it('has a plain-language label for every code', () => {
    for (const [code, label] of Object.entries(ISSUE_CODE_LABELS)) assert.ok(label.length > 3, code);
  });
});

describe('GST issue hotkey targets (Alt+M master, Alt+L voucher)', () => {
  it('Alt+M opens the master that holds the wrong data, Alt+L the voucher', () => {
    const hsn = issue('hsn_missing', { itemId: 9 });
    assert.deepEqual(masterLink(hsn)?.params, { id: 9 });
    assert.equal(masterLink(hsn)?.screen, 'inventory.item.form');
    assert.deepEqual(alterVoucherLink(hsn)?.params, { id: 42 });
    assert.equal(alterVoucherLink(hsn)?.screen, 'vouchers.entry');
    const gstin = issue('gstin_invalid');
    assert.equal(masterLink(gstin)?.screen, 'accounts.ledger.form');
    assert.deepEqual(masterLink(gstin)?.params, { id: 7 });
  });

  it('no master for voucher-only problems; nothing for period-level issues', () => {
    const note = issue('note_without_original');
    assert.equal(masterLink(note), null);
    assert.equal(alterVoucherLink(note)?.screen, 'vouchers.entry');
    const gap = issue('doc_series_gap', { voucherId: null, partyLedgerId: null });
    assert.equal(masterLink(gap), null);
    assert.equal(alterVoucherLink(gap), null);
  });
});

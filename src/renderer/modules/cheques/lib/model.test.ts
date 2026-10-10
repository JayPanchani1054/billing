import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequeRegisterResult, EPaymentCandidate } from '../../../../shared/types/cheques.ts';
import {
  alreadyExported,
  bookDraft,
  bookErrors,
  bookInput,
  bookLeaves,
  bookStatus,
  epaymentChosen,
  epaymentExport,
  ifscBank,
  leafActions,
  makeAndSavePaymentFile,
  padNo,
  payeeDraft,
  payeeErrors,
  payeeInput,
  pointError,
  readyPayments,
  REGISTER_VIEWS,
  registerExport,
  suggestedLayoutName,
  toggleAllReady,
  withPoint,
} from './model.ts';

describe('payee form rules', () => {
  it('account number typed twice, IFSC format, both or neither', () => {
    const d = { ...payeeDraft(null), accountNo: '1234 5678 9012', confirmAccountNo: '123456789012', ifsc: 'sbin0001234' };
    assert.deepEqual(payeeErrors(d), {});
    assert.match(payeeErrors({ ...d, confirmAccountNo: '123456789013' }).confirmAccountNo ?? '', /do not match/);
    assert.match(payeeErrors({ ...d, ifsc: 'SBIN1001234' }).ifsc ?? '', /IFSC format is invalid/);
    assert.match(payeeErrors({ ...d, ifsc: '' }).ifsc ?? '', /bank transfers need both/);
    assert.match(payeeErrors({ ...d, accountNo: '', confirmAccountNo: '' }).accountNo ?? '', /bank transfers need both/);
    assert.deepEqual(payeeErrors(payeeDraft(null)), {}, 'a cheque name alone is fine');
    assert.deepEqual(payeeInput(7, d), {
      ledgerId: 7,
      beneficiaryName: null,
      accountNo: '123456789012',
      ifsc: 'SBIN0001234',
      bankName: null,
      branch: null,
      accountType: null,
      chequeName: null,
      paymentMode: null,
    });
    assert.equal(ifscBank('hdfc0001234'), 'HDFC');
    assert.equal(ifscBank('HDFC1001234'), null);
  });

  it('layout points change one value at a time', () => {
    const spec = { date: { x: 1, y: 2, pitch: 5 }, payee: { x: 3, y: 4, w: 100 } } as unknown as Parameters<typeof withPoint>[0];
    const next = withPoint(spec, 'payee', 'w', 120);
    assert.deepEqual(next.payee, { x: 3, y: 4, w: 120 });
    assert.equal(next.date, spec.date);
  });
});

describe('exports', () => {
  it('register and e-payments export rows with amounts in paise and dates ISO', () => {
    const reg: ChequeRegisterResult = {
      bankLedgerId: 1,
      bankLedgerName: 'HDFC Bank',
      asOf: '2026-04-15',
      rows: [
        { key: '1:1', bookId: 1, bookName: 'B1', chequeNo: '000001', status: 'issued', postDated: true, voucherId: 3, voucherLabel: 'Payment 3', voucherDate: '2026-04-15', chequeDate: '2026-05-01', payee: 'X', amount: 1_000_00, bankDate: null, printedAt: null, reason: null },
        { key: '1:2', bookId: 1, bookName: 'B1', chequeNo: '000002', status: 'unused', postDated: false, voucherId: null, voucherLabel: null, voucherDate: null, chequeDate: null, payee: null, amount: null, bankDate: null, printedAt: null, reason: null },
      ],
      totals: { leaves: 2, unused: 1, issued: 1, cleared: 0, stale: 0, cancelled: 0, issuedAmount: 1_000_00, unclearedAmount: 1_000_00 },
    };
    const e = registerExport(reg);
    assert.deepEqual(e.rows[0].slice(0, 5), ['000001', 'Issued (post-dated)', '2026-05-01', 'X', 1_000_00]);
    assert.equal(e.totals?.[8], 'Uncleared 1,000.00');
    const c: EPaymentCandidate = { voucherId: 1, voucherLabel: 'Payment 1', date: '2026-04-15', bankLedgerId: 2, bankLedgerName: 'HDFC', payeeLedgerId: 3, payeeName: 'S', beneficiaryName: 'S', accountNo: '1', ifsc: 'X', amount: 5_00, mode: 'neft', problem: null, exportedAt: null };
    const bad = { ...c, voucherId: 2, problem: 'No bank details' };
    assert.deepEqual(readyPayments([c, bad]).map((r) => r.voucherId), [1]);
    const ex = epaymentExport([c, bad], { from: '2026-04-01', to: '2026-04-30' });
    assert.deepEqual(ex.rows.map((r) => r[8]), ['Ready', 'No bank details']);
    assert.equal(ex.totals?.[7], 10_00);
  });
});

describe('cheque book form', () => {
  it('mirrors the core checks: order, size, digits', () => {
    const d = { ...bookDraft(null), fromNo: 501, toNo: 525 };
    assert.deepEqual(bookErrors(d), {});
    assert.equal(bookLeaves(d), 25, '501 … 525 inclusive = 25 leaves');
    assert.match(bookErrors({ ...d, toNo: 500 }).toNo ?? '', /same as or after the first/);
    assert.match(bookErrors({ ...d, fromNo: 0, toNo: 10_000 }).toNo ?? '', /at most 10,000 leaves/, '0 … 10000 is 10,001 leaves');
    assert.deepEqual(bookErrors({ ...d, fromNo: 0, toNo: 9_999 }), {}, '0 … 9999 is exactly 10,000 leaves');
    assert.match(bookErrors({ ...d, digits: 2 }).toNo ?? '', /more than 2 digits/, '525 needs 3 digits');
    assert.deepEqual(bookErrors({ ...d, digits: 3 }), {}, '525 fits 3 digits');
    assert.match(bookErrors({ ...d, digits: 13 }).digits ?? '', /1 to 12 digits/);
    assert.match(bookErrors({ ...d, fromNo: null }).fromNo ?? '', /first cheque number/);
    assert.equal(bookLeaves({ fromNo: 10, toNo: 9 }), null);
    assert.deepEqual(bookInput(4, d), { bankLedgerId: 4, fromNo: 501, toNo: 525, digits: 6, isActive: true });
    assert.deepEqual(bookInput(4, { ...d, name: '  Book 2 ' }, 9), { id: 9, bankLedgerId: 4, name: 'Book 2', fromNo: 501, toNo: 525, digits: 6, isActive: true });
    assert.equal(padNo(501, 6), '000501');
    assert.equal(padNo(1234567, 6), '1234567', 'never cut');
  });

  it('status of a book in the list', () => {
    assert.deepEqual(bookStatus({ isActive: true, unused: 3, nextNo: '000503' }), { label: 'Next 000503', tone: 'success' });
    assert.deepEqual(bookStatus({ isActive: true, unused: 0, nextNo: null }), { label: 'Used up', tone: 'warning' });
    assert.deepEqual(bookStatus({ isActive: false, unused: 3, nextNo: '000503' }), { label: 'Inactive', tone: 'neutral' });
  });
});

describe('register and layout helpers', () => {
  it('cancel only unused leaves; re-open only leaves you cancelled', () => {
    assert.deepEqual(leafActions(null), { cancel: false, restore: false });
    assert.deepEqual(leafActions({ status: 'unused', voucherId: null, printedAt: null, reason: null }), { cancel: true, restore: false });
    assert.deepEqual(leafActions({ status: 'issued', voucherId: 3, printedAt: null, reason: null }), { cancel: false, restore: false });
    assert.deepEqual(leafActions({ status: 'cancelled', voucherId: null, printedAt: null, reason: 'Torn' }), { cancel: false, restore: true });
    assert.deepEqual(leafActions({ status: 'cancelled', voucherId: null, printedAt: '2026-04-15T10:00:00Z', reason: 'spoilt' }), { cancel: false, restore: false }, 'spoilt by a print stays cancelled');
    assert.deepEqual(REGISTER_VIEWS.map((v) => v.value), ['all', 'issued', 'stale', 'unused', 'cancelled', 'cleared'], 'Ctrl+1 … Ctrl+6');
  });

  it('position errors from the core land on the right cell', () => {
    const errors = { 'spec.payee.y': 'in the MICR band', 'spec.words': 'enter the position', 'spec.date.pitch': '3–8 mm' };
    assert.equal(pointError(errors, 'payee', 'y'), 'in the MICR band');
    assert.equal(pointError(errors, 'payee', 'x'), undefined);
    assert.equal(pointError(errors, 'words', 'x'), 'enter the position', 'a point-level issue shows on x');
    assert.equal(pointError(errors, 'words', 'y'), undefined);
    assert.equal(suggestedLayoutName('CTS-2010 standard leaf', 'HDFC Bank'), 'HDFC Bank - CTS-2010 standard leaf');
    assert.equal(suggestedLayoutName('x'.repeat(100)).length, 80);
  });
});

describe('e-payment selection', () => {
  const base: EPaymentCandidate = { voucherId: 1, voucherLabel: 'Payment 1', date: '2026-04-15', bankLedgerId: 2, bankLedgerName: 'HDFC', payeeLedgerId: 3, payeeName: 'S', beneficiaryName: 'S', accountNo: '1', ifsc: 'X', amount: 5_00, mode: 'neft', problem: null, exportedAt: null };
  const rows: EPaymentCandidate[] = [base, { ...base, voucherId: 2, problem: 'No bank details' }, { ...base, voucherId: 3, exportedAt: '2026-04-16T09:00:00Z' }];
  it('problem rows are never chosen; tick all ready toggles', () => {
    assert.deepEqual(epaymentChosen(rows, new Set([1, 2, 3])).map((r) => r.voucherId), [1, 3]);
    const all = toggleAllReady(rows, new Set());
    assert.deepEqual([...all].sort(), [1, 3]);
    assert.deepEqual([...toggleAllReady(rows, all)], [], 'all ready ticked → untick all');
    assert.deepEqual(alreadyExported(epaymentChosen(rows, all)).map((r) => r.voucherId), [3], 'warn before paying twice');
  });
});

describe('payment file: save or discard (review regression)', () => {
  const file = { batchId: 7, fileName: 'e-payments.csv' };
  it('keeps the batch when the file is saved', async () => {
    const discarded: number[] = [];
    const r = await makeAndSavePaymentFile({ make: async () => file, save: async () => ({ path: 'C:/x.csv' }), discard: async (id) => discarded.push(id) });
    assert.deepEqual(r.saved, { path: 'C:/x.csv' });
    assert.deepEqual(discarded, []);
  });
  it('discards the batch when the save dialog is cancelled', async () => {
    const discarded: number[] = [];
    const r = await makeAndSavePaymentFile({ make: async () => file, save: async () => null, discard: async (id) => discarded.push(id) });
    assert.equal(r.saved, null);
    assert.deepEqual(discarded, [7]);
  });
  it('discards the batch and reports the error when the write fails', async () => {
    const discarded: number[] = [];
    await assert.rejects(
      makeAndSavePaymentFile({ make: async () => file, save: async () => { throw new Error('disk full'); }, discard: async (id) => discarded.push(id) }),
      /disk full/,
    );
    assert.deepEqual(discarded, [7]);
  });
  it('a failing discard does not hide the outcome', async () => {
    const r = await makeAndSavePaymentFile({ make: async () => file, save: async () => null, discard: async () => { throw new Error('offline'); } });
    assert.equal(r.saved, null);
  });
});

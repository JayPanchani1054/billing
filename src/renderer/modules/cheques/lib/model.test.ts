import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequeRegisterResult, EPaymentCandidate } from '../../../../shared/types/cheques.ts';
import { epaymentExport, ifscBank, payeeDraft, payeeErrors, payeeInput, readyPayments, registerExport, withPoint } from './model.ts';

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

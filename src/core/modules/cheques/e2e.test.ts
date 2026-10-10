/**
 * Cheques end to end through the route dispatcher (what the screens call):
 *   F11 Cheque printing → cheque book 000501–000510 → payee bank details → Payment by cheque (number
 *   filled in: 000501) → print data → print record (edit log) → register (issued, printed) → leaf
 *   cancelled → NEFT payment → e-payment file. Permissions: printing and payment files are exports.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChequeBook, ChequePrintData, ChequeRegisterResult, EPaymentCandidate, EPaymentExportResult, PayeeBankDetails } from '../../../shared/types/cheques.ts';
import type { VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { setupKit } from '../vouchers/testkit.ts';

describe('cheques through the dispatcher', () => {
  test('book → payee → payment → print → register → e-payment file', async () => {
    const k = setupKit();
    const { t, L, vt } = k;
    t.db.run('UPDATE ledgers SET maintain_bill_wise = 0 WHERE id = :id', { id: L.supplier });

    const off = await t.call(routes, 'cheques.book.save', { bankLedgerId: L.bank, fromNo: 501, toNo: 510 });
    assert.equal(off.ok, false, 'cheque books need F11 › Cheque printing');
    await t.callOk(routes, 'company.features.save', { chequePrinting: true });
    const book = await t.callOk<ChequeBook>(routes, 'cheques.book.save', { bankLedgerId: L.bank, fromNo: 501, toNo: 510 });
    assert.equal(book.nextNo, '000501');

    const payee = await t.callOk<PayeeBankDetails>(routes, 'cheques.payee.save', { ledgerId: L.supplier, accountNo: '001122334455', ifsc: 'ICIC0001234', beneficiaryName: 'Supreme Suppliers' });
    assert.equal(payee.effectiveChequeName, 'Supreme Suppliers');

    const pay = await t.callOk<VoucherSaveResult>(routes, 'vouchers.save', {
      voucherTypeId: vt.payment,
      date: '2026-04-15',
      mode: 'ledger',
      acknowledgeWarnings: true,
      ledgers: [
        { ledgerId: L.supplier, amount: 47_500_00 },
        { ledgerId: L.bank, amount: -47_500_00, instrument: { type: 'cheque' } },
      ],
    });
    const data = await t.callOk<ChequePrintData>(routes, 'cheques.print.data', { voucherIds: [pay.id] });
    const c = data.cheques[0];
    // 47,500.00 → 'Forty Seven Thousand Five Hundred Only', figures '**47,500.00/-', 15-04-2026.
    assert.deepEqual([c.chequeNo, c.payee, c.amountWords, c.amountFigures, c.dateDigits], ['000501', 'Supreme Suppliers', 'Forty Seven Thousand Five Hundred Only', '**47,500.00/-', '15042026']);

    const dataEntry = t.sessionAs({ role: 'Data Entry' });
    const denied = await t.call(routes, 'cheques.print.record', { items: [{ voucherId: pay.id, lineNo: c.lineNo }] }, { session: dataEntry });
    assert.equal(denied.ok, false, 'printing a cheque is an export');
    await t.callOk(routes, 'cheques.print.record', { items: [{ voucherId: pay.id, lineNo: c.lineNo }] });

    await t.callOk(routes, 'cheques.leaf.cancel', { bankLedgerId: L.bank, chequeNo: '000502', reason: 'Signature smudged' });
    const reg = await t.callOk<ChequeRegisterResult>(routes, 'cheques.register', { bankLedgerId: L.bank });
    assert.deepEqual(
      reg.rows.slice(0, 3).map((r) => [r.chequeNo, r.status, r.printedAt !== null]),
      [
        ['000501', 'issued', true],
        ['000502', 'cancelled', false],
        ['000503', 'unused', false],
      ],
    );
    assert.equal(reg.totals.unclearedAmount, 47_500_00);

    const neft = await t.callOk<VoucherSaveResult>(routes, 'vouchers.save', {
      voucherTypeId: vt.payment,
      date: '2026-04-15',
      mode: 'ledger',
      acknowledgeWarnings: true,
      ledgers: [
        { ledgerId: L.supplier, amount: 12_000_00 },
        { ledgerId: L.bank, amount: -12_000_00, instrument: { type: 'neft' } },
      ],
    });
    const list = await t.callOk<EPaymentCandidate[]>(routes, 'cheques.epayment.list', { from: '2026-04-01', to: '2026-04-30' });
    assert.deepEqual(list.map((x) => [x.voucherId, x.mode, x.problem]), [[neft.id, 'neft', null]]);
    const file = await t.callOk<EPaymentExportResult>(routes, 'cheques.epayment.export', { voucherIds: [neft.id] });
    assert.equal(file.rows, 1);
    assert.match(new TextDecoder().decode(file.bytes), /NEFT,12000\.00,15\/04\/2026,Supreme Suppliers,001122334455,ICIC0001234/);
    const deniedFile = await t.call(routes, 'cheques.epayment.export', { voucherIds: [neft.id] }, { session: dataEntry });
    assert.equal(deniedFile.ok, false);
  });
});

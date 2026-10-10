/**
 * Print group main flow through the REAL runtime (createRuntime + runtime.dispatch, as Electron main
 * does): company → F11 Cheque printing → bank + supplier (e-mail, mobile) → payee bank details →
 * cheque book 001001–001025 → calibrated layout for the bank → Payment by cheque (leaf filled in on
 * save) → cheque print data (words, figures, date boxes) → print recorded (edit log, register) →
 * second payment takes the next leaf → a spoilt leaf is cancelled and skipped → stale as on a later
 * date → share context (party e-mail / mobile) + share logged as an export → NEFT payment → bulk
 * e-payment CSV → Trial Balance still balances.
 *
 * Figures: cheque ₹1,23,456.78 → 'One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy
 * Eight Paise Only', '**1,23,456.78/-', date 15-05-2026 → '15052026'.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ChequeBook, ChequeLayout, ChequePreset, ChequePrintData, ChequeRegisterResult, EPaymentCandidate, EPaymentExportResult } from '../../../shared/types/cheques.ts';
import type { ShareContext } from '../../../shared/types/print.ts';
import { makeGstin, TEST_PAN } from '../../testing/fixtures.ts';
import { P, startRuntime, type E2E } from '../../testing/e2e/harness.ts';

interface Row {
  id: number;
  name: string;
  [k: string]: unknown;
}

describe('cheques, sharing and e-payments end to end (runtime.dispatch)', () => {
  let e: E2E;
  let bank = 0;
  let supplier = 0;
  let paymentType = 0;
  let firstPay = 0;
  let secondPay = 0;

  before(() => {
    e = startRuntime('2026-05-15');
  });
  after(async () => {
    await e.close();
  });

  const pay = async (amount: number, instrument: { type: string; number?: string }): Promise<number> => {
    const r = await e.call<{ id: number }>('vouchers.save', {
      voucherTypeId: paymentType,
      date: '2026-05-15',
      mode: 'ledger',
      acknowledgeWarnings: true,
      ledgers: [
        { ledgerId: supplier, amount },
        { ledgerId: bank, amount: -amount, instrument },
      ],
    });
    return r.id;
  };

  it('creates the company, masters and turns cheque printing on (F11)', async () => {
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Cheque Traders E2E',
      stateCode: '27',
      gstRegistrationType: 'regular',
      gstin: makeGstin('27'),
      pan: TEST_PAN,
      booksFrom: '2026-04-01',
      fyStartMonth: 4,
      features: { inventory: false, billWise: false, gst: true },
    });
    const groups = await e.call<{ rows: Row[] }>('accounts.group.list', {});
    const gid = (name: string): number => {
      const g = groups.rows.find((x) => x.name === name);
      assert.ok(g, name);
      return g.id;
    };
    bank = (await e.call<Row>('accounts.ledger.save', { name: 'HDFC Bank', groupId: gid('Bank Accounts') })).id;
    supplier = (await e.call<Row>('accounts.ledger.save', { name: 'Supreme Suppliers', groupId: gid('Sundry Creditors'), email: 'accounts@supreme.example', mobile: '98765 43210' })).id;
    const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
    paymentType = types.rows.find((t) => t.baseType === 'payment' && t.isPredefined)?.id ?? 0;
    assert.ok(paymentType > 0);

    await e.fails('cheques.book.save', { bankLedgerId: bank, fromNo: 1001, toNo: 1025 }, 'BUSINESS_RULE', /Cheque printing/);
    const f = await e.call<{ chequePrinting: boolean }>('company.features.save', { chequePrinting: true });
    assert.equal(f.chequePrinting, true);
  });

  it('keeps payee bank details, a cheque book and a calibrated layout for the bank', async () => {
    await e.fails('cheques.payee.save', { ledgerId: supplier, accountNo: '001122334455', ifsc: 'ICIC1001234' }, 'VALIDATION');
    const payee = await e.call('cheques.payee.save', { ledgerId: supplier, beneficiaryName: 'Supreme Suppliers Pvt Ltd', accountNo: '001122334455', ifsc: 'icic0001234', bankName: 'ICICI Bank', paymentMode: 'neft' });
    assert.equal(payee.ifsc, 'ICIC0001234');
    assert.equal(payee.effectiveChequeName, 'Supreme Suppliers Pvt Ltd');

    const book = await e.call<ChequeBook>('cheques.book.save', { bankLedgerId: bank, fromNo: 1001, toNo: 1025, digits: 6 });
    assert.deepEqual([book.name, book.leaves, book.nextNo], ['001001–001025', 25, '001001']);
    await e.fails('cheques.book.save', { bankLedgerId: bank, fromNo: 1020, toNo: 1030 }, 'VALIDATION');

    const presets = await e.call<ChequePreset[]>('cheques.layout.presets', {});
    const cts = presets.find((p) => p.code === 'cts2010');
    assert.ok(cts);
    assert.deepEqual([cts.spec.widthMm, cts.spec.heightMm], [202, 92], 'CTS-2010 leaf');
    // The MICR band (bottom 16 mm) must stay clear: 92 − 16 = 76 mm is the lowest line.
    await e.fails('cheques.layout.save', { name: 'Bad', spec: { ...cts.spec, signatory: { x: 140, y: 80, w: 58 } } }, 'VALIDATION');
    const layout = await e.call<ChequeLayout>('cheques.layout.save', { name: 'HDFC leaves', preset: 'cts2010', spec: { ...cts.spec, offsetX: 1.5, offsetY: -0.5 } });
    const settings = await e.call('cheques.bank.save', { bankLedgerId: bank, layoutId: layout.id, signatory: 'Partner' });
    assert.equal(settings.layoutName, 'HDFC leaves');
  });

  it('fills the next leaf on a cheque payment and builds the cheque', async () => {
    firstPay = await pay(P(123_456.78), { type: 'cheque' });
    const data = await e.call<ChequePrintData>('cheques.print.data', { voucherIds: [firstPay] });
    assert.equal(data.cheques.length, 1);
    const c = data.cheques[0];
    assert.equal(c.chequeNo, '001001');
    assert.equal(c.payee, 'Supreme Suppliers Pvt Ltd');
    assert.equal(c.amountWords, 'One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
    assert.equal(c.amountFigures, '**1,23,456.78/-');
    assert.equal(c.dateDigits, '15052026');
    assert.equal(c.acPayee, true, 'crossed A/c Payee by default');
    assert.equal(c.signatory, 'Partner');
    assert.equal(c.layoutName, 'HDFC leaves');
    assert.deepEqual([c.spec.offsetX, c.spec.offsetY], [1.5, -0.5]);

    const rec = await e.call<{ recorded: number }>('cheques.print.record', { items: [{ voucherId: firstPay, lineNo: c.lineNo }] });
    assert.equal(rec.recorded, 1);
    const log = await e.call<{ rows: Array<{ action: string; entityLabel: string | null }> }>('security.audit.list', { actions: ['export'] });
    assert.ok(log.rows.some((r) => /cheque/i.test(r.entityLabel ?? '')), 'printing a cheque is in the edit log');

    secondPay = await pay(P(5_000), { type: 'cheque' });
    const second = await e.call<ChequePrintData>('cheques.print.data', { voucherIds: [secondPay] });
    assert.equal(second.cheques[0].chequeNo, '001002', 'the next leaf');
  });

  it('cancels a spoilt leaf, skips it, and shows stale cheques in the register', async () => {
    await e.call('cheques.leaf.cancel', { bankLedgerId: bank, chequeNo: '001003', reason: 'Spoilt while writing' });
    await e.fails('cheques.leaf.cancel', { bankLedgerId: bank, chequeNo: '001001', reason: 'x' }, 'BUSINESS_RULE', /issued on/);
    const next = await e.call<{ chequeNo: string } | null>('cheques.book.next', { bankLedgerId: bank });
    assert.equal(next?.chequeNo, '001004');

    const reg = await e.call<ChequeRegisterResult>('cheques.register', { bankLedgerId: bank });
    assert.deepEqual(
      reg.rows.slice(0, 4).map((r) => [r.chequeNo, r.status, r.printedAt !== null]),
      [
        ['001001', 'issued', true],
        ['001002', 'issued', false],
        ['001003', 'cancelled', false],
        ['001004', 'unused', false],
      ],
    );
    // Uncleared: 1,23,456.78 + 5,000.00 = 1,28,456.78.
    assert.equal(reg.totals.unclearedAmount, P(128_456.78));
    assert.deepEqual([reg.totals.leaves, reg.totals.issued, reg.totals.cancelled, reg.totals.unused], [25, 2, 1, 22]);

    // Cheques are valid for 3 months from their date: on 16-08-2026 both are stale.
    const later = await e.call<ChequeRegisterResult>('cheques.register', { bankLedgerId: bank, asOf: '2026-08-16', status: 'stale' });
    assert.deepEqual(later.rows.map((r) => r.chequeNo), ['001001', '001002']);
    const onTheDay = await e.call<ChequeRegisterResult>('cheques.register', { bankLedgerId: bank, asOf: '2026-08-15', status: 'stale' });
    assert.equal(onTheDay.rows.length, 0, 'still valid on the last day of the third month');
  });

  it('shares the payment voucher: recipient from the party ledger, logged as an export', async () => {
    const ctx = await e.call<ShareContext>('print.share.context', { voucherId: firstPay });
    assert.equal(ctx.email, 'accounts@supreme.example');
    assert.equal(ctx.mobile, '9876543210');
    assert.ok(ctx.subject.length > 0 && ctx.whatsappText.length > 0);
    await e.call('print.share.log', { voucherId: firstPay, channel: 'whatsapp', to: ctx.mobile ?? undefined, fileName: ctx.fileName });
    const log = await e.call<{ rows: Array<{ action: string; entityLabel: string | null }> }>('security.audit.list', { actions: ['export'] });
    assert.ok(log.rows.length >= 2, 'cheque print + share are both exports');
  });

  it('makes a bulk e-payment file of NEFT payments only; the books still balance', async () => {
    const neft = await pay(P(12_000), { type: 'neft' });
    const list = await e.call<EPaymentCandidate[]>('cheques.epayment.list', { from: '2026-05-01', to: '2026-05-31' });
    assert.deepEqual(list.map((x) => [x.voucherId, x.mode, x.problem]), [[neft, 'neft', null]], 'cheque payments never go into a payment file');
    const file = await e.call<EPaymentExportResult>('cheques.epayment.export', { voucherIds: [neft] });
    assert.equal(file.rows, 1);
    assert.equal(file.total, P(12_000));
    const csv = new TextDecoder().decode(file.bytes);
    assert.match(csv, /NEFT,12000\.00,15\/05\/2026,Supreme Suppliers Pvt Ltd,001122334455,ICIC0001234/);
    const again = await e.call<EPaymentCandidate[]>('cheques.epayment.list', { from: '2026-05-01', to: '2026-05-31' });
    assert.ok(again[0].exportedAt !== null, 'marked as put in a payment file');
    // Save dialog cancelled → the renderer discards the batch: no longer "already in a file", and both
    // the export and its discard stay in the edit log.
    await e.call('cheques.epayment.discard', { batchId: file.batchId });
    const discarded = await e.call<EPaymentCandidate[]>('cheques.epayment.list', { from: '2026-05-01', to: '2026-05-31' });
    assert.equal(discarded[0].exportedAt, null);
    await e.fails('cheques.epayment.discard', { batchId: file.batchId }, 'NOT_FOUND');
    const redo = await e.call<EPaymentExportResult>('cheques.epayment.export', { voucherIds: [neft] });
    assert.ok(redo.batchId > 0);

    const tb = await e.call<{ totals: { closing: { debit: number; credit: number } } }>('reports.trialBalance', { from: '2026-04-01', to: '2026-05-31' });
    // Three payments: 1,23,456.78 + 5,000 + 12,000 = 1,40,456.78 debited to the supplier, credited to the bank.
    assert.equal(tb.totals.closing.debit, P(140_456.78));
    assert.equal(tb.totals.closing.credit, P(140_456.78));
  });
});

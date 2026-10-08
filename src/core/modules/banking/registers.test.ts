/**
 * Cheque register, post-dated cheques and the deposit slip, from vouchers posted through the vouchers service.
 * Company today 30-Apr-2026 (books from 1-Apr-2026).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BankSummaryRow, ChequeRegisterResult, DepositSlip, PdcResult } from '../../../shared/types/banking.ts';
import { brs, setBankDates } from './brs.ts';
import { chequeRegister, depositSlip, postDatedCheques } from './registers.ts';
import { bankingRoutes } from './routes.ts';
import { cheque, contra, payment, receipt, rs, setupBank, type BankKit, type Posted } from './testkit.ts';

describe('cheque register and PDC', () => {
  let k: BankKit;
  let issued501: Posted;
  let issued502: Posted;
  let recvd: Posted;
  let neft: Posted;
  let pdcIn: Posted;
  let pdcOut: Posted;
  beforeEach(() => {
    k = setupBank();
    issued501 = payment(k, { date: '2026-04-03', amount: 40_000, other: k.L.supreme, instrument: { ...cheque('000501'), favouring: 'Supreme Suppliers' } });
    issued502 = payment(k, { date: '2026-04-20', amount: 15_000, other: k.L.rent, instrument: cheque('000502') });
    recvd = receipt(k, { date: '2026-04-28', amount: 12_000, other: k.L.bharat, instrument: cheque('778899', '2026-04-27', 'ICICI Bank') });
    neft = receipt(k, { date: '2026-04-02', amount: 25_000, other: k.L.acme, instrument: { type: 'neft', number: 'N1' } });
    pdcIn = receipt(k, { date: '2026-05-10', amount: 7_000, other: k.L.acme, postDated: true, instrument: cheque('112233', '2026-05-10', 'SBI') });
    pdcOut = payment(k, { date: '2026-05-05', amount: 2_000, other: k.L.supreme, postDated: true, instrument: cheque('000503', '2026-05-05') });
    setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: issued501.entryId, bankDate: '2026-04-06' }] });
  });
  afterEach(() => k.t.close());

  it('lists cheques issued and received with clearing status and totals (NEFT excluded)', async () => {
    const r = await k.t.callOk<ChequeRegisterResult>(bankingRoutes, 'banking.chequeRegister', { from: '2026-04-01', to: '2026-05-31' });
    assert.deepEqual(
      r.rows.map((x) => [x.ledgerEntryId, x.direction, x.instrumentNo, x.amount, x.status, x.bankDate]),
      [
        [issued501.entryId, 'issued', '000501', rs(40_000), 'cleared', '2026-04-06'],
        [issued502.entryId, 'issued', '000502', rs(15_000), 'uncleared', null],
        [recvd.entryId, 'received', '778899', rs(12_000), 'uncleared', null],
        [pdcOut.entryId, 'issued', '000503', rs(2_000), 'post_dated', null],
        [pdcIn.entryId, 'received', '112233', rs(7_000), 'post_dated', null],
      ],
    );
    assert.ok(!r.rows.some((x) => x.ledgerEntryId === neft.entryId));
    assert.equal(r.rows[0].favouring, 'Supreme Suppliers');
    assert.equal(r.rows[0].particulars, 'Supreme Suppliers');
    assert.equal(r.rows[2].drawnOn, 'ICICI Bank');
    // Issued: 40,000 + 15,000 + 2,000 = 57,000, uncleared 15,000 + 2,000 = 17,000. Received: 12,000 + 7,000 = 19,000, all uncleared.
    assert.deepEqual(r.totals, {
      issued: { count: 3, amount: rs(57_000), uncleared: 2, unclearedAmount: rs(17_000) },
      received: { count: 2, amount: rs(19_000), uncleared: 2, unclearedAmount: rs(19_000) },
      stale: 0,
    });
    const onlyUnclearedIssued = chequeRegister(k.t.db, k.t.today, { from: '2026-04-01', to: '2026-04-30', status: 'uncleared', direction: 'issued' });
    assert.deepEqual(onlyUnclearedIssued.rows.map((x) => x.ledgerEntryId), [issued502.entryId]);
  });

  it('marks uncleared cheques older than 3 months as stale', () => {
    k.t.clock.setToday('2026-07-25');
    const r = chequeRegister(k.t.db, '2026-07-25', { ledgerId: k.L.hdfc, from: '2026-04-01', to: '2026-04-30' });
    // 000502 dated 20-Apr → valid until 20-Jul < 25-Jul: stale. 778899 (cheque dated 27-Apr) is valid until 27-Jul.
    assert.deepEqual(r.rows.filter((x) => x.stale).map((x) => x.instrumentNo), ['000502']);
    assert.equal(r.totals.stale, 1);
  });

  it('post-dated cheques pending as of a date, maturity in days, and matured ones on request', async () => {
    const r = await k.t.callOk<PdcResult>(bankingRoutes, 'banking.pdc', { asOf: '2026-04-30' });
    assert.deepEqual(
      r.rows.map((x) => [x.ledgerEntryId, x.kind, x.amount, x.daysToMaturity, x.matured]),
      [
        [pdcOut.entryId, 'payable', rs(2_000), 5, false],
        [pdcIn.entryId, 'receivable', rs(7_000), 10, false],
      ],
    );
    assert.deepEqual(r.totals, { receivable: { count: 1, amount: rs(7_000) }, payable: { count: 1, amount: rs(2_000) } });
    const later = postDatedCheques(k.t.db, { asOf: '2026-05-06' });
    assert.deepEqual(later.rows.map((x) => x.ledgerEntryId), [pdcIn.entryId]);
    const all = postDatedCheques(k.t.db, { asOf: '2026-05-06', includeMatured: true });
    assert.deepEqual(all.rows.map((x) => [x.ledgerEntryId, x.daysToMaturity, x.matured]), [[pdcOut.entryId, -1, true], [pdcIn.entryId, 4, false]]);
    // PDCs are not in the books before their date: the BRS ignores them.
    const b = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-30' });
    assert.ok(!b.entries.some((e) => e.ledgerEntryId === pdcIn.entryId || e.ledgerEntryId === pdcOut.entryId));
  });
});

describe('deposit slip and summary route', () => {
  it('lists cheques/DDs and cash deposited on a day with totals in words', async () => {
    const k = setupBank();
    try {
      const c1 = receipt(k, { date: '2026-04-28', amount: 12_000, other: k.L.bharat, instrument: cheque('778899', '2026-04-27', 'ICICI Bank') });
      const c2 = receipt(k, { date: '2026-04-28', amount: 8_000, other: k.L.acme, instrument: { type: 'dd', number: '445566', bankName: 'Axis Bank' } });
      receipt(k, { date: '2026-04-28', amount: 1_000, other: k.L.acme, instrument: { type: 'neft', number: 'N9' } });
      receipt(k, { date: '2026-04-28', amount: 500, other: k.L.cash }); // Dr bank / Cr Cash: cash paid in
      contra(k, { date: '2026-04-28', amount: 4_500, other: k.L.cash, deposit: true });
      receipt(k, { date: '2026-04-29', amount: 3_000, other: k.L.acme, instrument: cheque('1') });
      const slip = await k.t.callOk<DepositSlip>(bankingRoutes, 'banking.depositSlip', { ledgerId: k.L.hdfc, date: '2026-04-28' });
      assert.deepEqual(slip.cheques.map((c) => [c.ledgerEntryId, c.instrumentType, c.instrumentNo, c.drawnOn, c.amount, c.particulars]), [
        [c2.entryId, 'dd', '445566', 'Axis Bank', rs(8_000), 'Acme Traders'],
        [c1.entryId, 'cheque', '778899', 'ICICI Bank', rs(12_000), 'Bharat Stores'],
      ]);
      // Cash: 500 + 4,500 = 5,000 (both credit the Cash ledger); NEFT is neither cheque nor cash.
      // Total 8,000 + 12,000 + 5,000 = 25,000.
      assert.deepEqual(slip.cash, { amount: rs(5_000), vouchers: 2 });
      assert.deepEqual(slip.totals, { chequeCount: 2, cheques: rs(20_000), cash: rs(5_000), total: rs(25_000) });
      assert.match(slip.amountInWords, /Twenty Five Thousand/);
      assert.equal(slip.bank.accountNo, '50100012345678');
      assert.equal(slip.bank.holder, 'Test Traders Pvt Ltd');
      const summary = await k.t.callOk<BankSummaryRow[]>(bankingRoutes, 'banking.summary', { asOf: '2026-04-30' });
      // HDFC: 1,00,000 + 12,000 + 8,000 + 1,000 + 500 + 4,500 + 3,000 = 1,29,000; nothing cleared → bank shows 1,00,000.
      const hdfc = summary.find((s) => s.id === k.L.hdfc);
      assert.deepEqual([hdfc?.balanceAsPerBooks, hdfc?.balanceAsPerBank, hdfc?.unreconciled.depositsCount], [rs(1_29_000), rs(1_00_000), 6]);
      assert.deepEqual(depositSlip(k.t.db, { ledgerId: k.L.hdfc, date: '2026-04-27' }).totals, { chequeCount: 0, cheques: 0, cash: 0, total: 0 });
    } finally {
      k.t.close();
    }
  });
});

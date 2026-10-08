/**
 * Bank Reconciliation Statement: balances (books ↔ bank), categories, statement balance and the explained
 * difference, bank-date entry rules and audit, and the per-bank summary. Vouchers are posted through the real
 * vouchers service (testkit.ts). Company: today 30-Apr-2026, books from 1-Apr-2026, HDFC opening ₹1,00,000 Dr.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BrsResult, StatementImportResult } from '../../../shared/types/banking.ts';
import { AppError } from '../../lib/errors.ts';
import { deleteVoucher } from '../vouchers/service.ts';
import { bankSummary, brs, setBankDates } from './brs.ts';
import { autoMatch } from './matching.ts';
import { bankingRoutes } from './routes.ts';
import { importStatement } from './statements.ts';
import { bankDateOf, cheque, payment, receipt, rs, setupBank, textBytes, type BankKit, type Posted } from './testkit.ts';

interface Scenario {
  k: BankKit;
  /** Receipt 02-Apr Acme ₹25,000 NEFT N091260001 */
  r1: Posted;
  /** Payment 03-Apr Supreme ₹40,000 cheque 000501 */
  p1: Posted;
  /** Payment 20-Apr rent ₹15,000 cheque 000502 (never presented) */
  p2: Posted;
  /** Receipt 28-Apr Bharat ₹12,000 cheque 778899 (not cleared) */
  r2: Posted;
  /** Payment 27-Apr Supreme ₹3,000 cheque 000503 dated 22-Apr (cleared 24-Apr, before the voucher date) */
  p3: Posted;
  /** Optional receipt ₹99,999 — never counts */
  opt: Posted;
  /** Post-dated receipt 10-May ₹7,000 — not yet in the books */
  pdc: Posted;
}

function scenario(): Scenario {
  const k = setupBank();
  const { L } = k;
  return {
    k,
    r1: receipt(k, { date: '2026-04-02', amount: 25_000, other: L.acme, instrument: { type: 'neft', number: 'N091260001' } }),
    p1: payment(k, { date: '2026-04-03', amount: 40_000, other: L.supreme, instrument: cheque('000501') }),
    p2: payment(k, { date: '2026-04-20', amount: 15_000, other: L.rent, instrument: cheque('000502') }),
    r2: receipt(k, { date: '2026-04-28', amount: 12_000, other: L.bharat, instrument: cheque('778899', '2026-04-27', 'ICICI Bank') }),
    p3: payment(k, { date: '2026-04-27', amount: 3_000, other: L.supreme, instrument: cheque('000503', '2026-04-22') }),
    opt: receipt(k, { date: '2026-04-10', amount: 99_999, other: L.acme, optional: true }),
    pdc: receipt(k, { date: '2026-05-10', amount: 7_000, other: L.acme, postDated: true, instrument: cheque('112233', '2026-05-10') }),
  };
}

const STATEMENT = [
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '02/04/26,NEFT CR-HDFC0000001-ACME TRADERS-N091260001,N091260001,02/04/26,,"25,000.00","1,25,000.00"',
  '06/04/26,CHQ PAID-MICR CTS-SUPREME SUPPLIERS,000501,06/04/26,"40,000.00",,"85,000.00"',
  '24/04/26,CHQ PAID-MICR CTS-SUPREME SUPPLIERS,000503,24/04/26,"3,000.00",,"82,000.00"',
  '30/04/26,SMS CHARGES QTR,,30/04/26,590.00,,"81,410.00"',
].join('\n');

function importHdfc(k: BankKit, csv = STATEMENT, fileName = 'hdfc-apr.csv'): StatementImportResult {
  const mapping = {
    preset: 'hdfc' as const,
    headerRow: 0,
    columns: { date: 0, description: 1, reference: 2, valueDate: 3, debit: 4, credit: 5, balance: 6 },
    dateOrder: 'dmy' as const,
  };
  return importStatement(k.t.ctx, { ledgerId: k.L.hdfc, fileName, bytes: textBytes(csv), mapping });
}

const pick = (r: BrsResult) => ({
  books: r.balanceAsPerBooks,
  issued: r.chequesIssuedNotPresented,
  deposited: r.chequesDepositedNotCleared,
  early: r.clearedBeforeVoucherDate,
  bank: r.balanceAsPerBank,
});

describe('BRS', () => {
  let s: Scenario;
  beforeEach(() => {
    s = scenario();
  });
  afterEach(() => s.k.t.close());

  it('reconciles books to bank with a statement: issued not presented, deposited not cleared, explained difference', () => {
    const { k } = s;
    importHdfc(k);
    const am = autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    assert.deepEqual(
      am.applied.map((a) => a.ledgerEntryId).sort((a, b) => a - b),
      [s.r1.entryId, s.p1.entryId, s.p3.entryId].sort((a, b) => a - b),
    );
    assert.equal(bankDateOf(k, s.p1.entryId), '2026-04-06');
    assert.equal(bankDateOf(k, s.p3.entryId), '2026-04-24');

    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-30' });
    // Books: 1,00,000 + 25,000 − 40,000 − 15,000 + 12,000 − 3,000 = 79,000 (optional and post-dated excluded).
    // Issued not presented: rent cheque 000502 = 15,000. Deposited not cleared: Bharat cheque = 12,000.
    // As per bank: 79,000 + 15,000 − 12,000 = 82,000 = 1,00,000 + 25,000 − 40,000 − 3,000 (entries with bank date ≤ 30-Apr).
    assert.deepEqual(pick(r), { books: rs(79_000), issued: rs(15_000), deposited: rs(12_000), early: 0, bank: rs(82_000) });
    // Statement closing 81,410; difference 81,410 − 82,000 = −590, fully explained by the unmatched SMS charges.
    assert.equal(r.statementBalance, rs(81_410));
    assert.equal(r.statementDate, '2026-04-30');
    assert.equal(r.difference, -rs(590));
    assert.deepEqual(r.amountsNotInBooks, { count: 1, deposits: 0, withdrawals: rs(590) });
    assert.equal(r.unexplainedDifference, 0);
    assert.deepEqual(r.counts, { issuedNotPresented: 1, depositedNotCleared: 1, clearedBeforeVoucher: 0, reconciledListed: 0 });
    assert.deepEqual(
      r.entries.map((e) => [e.ledgerEntryId, e.category, e.debit, e.credit, e.particulars]),
      [
        [s.p2.entryId, 'issued_not_presented', 0, rs(15_000), 'Office Rent'],
        [s.r2.entryId, 'deposited_not_cleared', rs(12_000), 0, 'Bharat Stores'],
      ],
    );
    const r2 = r.entries[1];
    assert.deepEqual([r2.instrumentType, r2.instrumentNo, r2.instrumentDate, r2.drawnOn, r2.voucherType], ['cheque', '778899', '2026-04-27', 'ICICI Bank', 'Receipt']);
  });

  it('compares the statement on its own last date, not with bank dates entered for later days', () => {
    const { k } = s;
    // Statement downloaded on 24-Apr (no SMS line yet); the Bharat cheque is then cleared by hand on 29-Apr.
    importHdfc(k, STATEMENT.split('\n').slice(0, 4).join('\n'));
    autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.r2.entryId, bankDate: '2026-04-29' }] });
    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-30' });
    // As per bank on 30-Apr: 79,000 + 15,000 (rent cheque) = 94,000.
    // On the statement date 24-Apr: 1,00,000 + 25,000 − 40,000 − 3,000 = 82,000 = statement balance → difference 0
    // (comparing with 94,000 would show a false −12,000).
    assert.deepEqual(pick(r), { books: rs(79_000), issued: rs(15_000), deposited: 0, early: 0, bank: rs(94_000) });
    assert.deepEqual([r.statementDate, r.statementBalance, r.balanceAsPerBankOnStatementDate, r.difference, r.unexplainedDifference], ['2026-04-24', rs(82_000), rs(82_000), 0, 0]);
    assert.equal(r.amountsNotInBooks.count, 0);
    const sum = bankSummary(k.t.db, k.t.today, '2026-04-30').find((b) => b.id === k.L.hdfc);
    assert.equal(sum?.lastStatement?.difference, 0);
  });

  it('lists entries the bank cleared before the voucher date (asOf between cheque date and voucher date)', () => {
    const { k } = s;
    setBankDates(k.t.ctx, {
      entries: [
        { ledgerEntryId: s.r1.entryId, bankDate: '2026-04-02' },
        { ledgerEntryId: s.p1.entryId, bankDate: '2026-04-06' },
        { ledgerEntryId: s.p3.entryId, bankDate: '2026-04-24' },
      ],
    });
    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-25', show: 'all' });
    // Books as of 25-Apr: 1,00,000 + 25,000 − 40,000 − 15,000 = 70,000.
    // Not presented: rent 15,000. Cleared early: payment of 27-Apr (cheque dated 22-Apr) cleared 24-Apr → −3,000.
    // As per bank: 70,000 + 15,000 − 0 − 3,000 = 82,000 = 1,00,000 + 25,000 − 40,000 − 3,000.
    assert.deepEqual(pick(r), { books: rs(70_000), issued: rs(15_000), deposited: 0, early: -rs(3_000), bank: rs(82_000) });
    assert.equal(r.statementBalance, null);
    assert.equal(r.difference, null);
    assert.equal(r.from, '2026-04-01');
    assert.deepEqual(
      r.entries.map((e) => [e.ledgerEntryId, e.category]),
      [
        [s.r1.entryId, 'reconciled'],
        [s.p1.entryId, 'reconciled'],
        [s.p2.entryId, 'issued_not_presented'],
        [s.p3.entryId, 'cleared_before_voucher'],
      ],
    );
    assert.equal(r.counts.reconciledListed, 2);
    assert.equal(r.counts.clearedBeforeVoucher, 1);
  });

  it('show reconciled lists only entries cleared on/before asOf from the start date; a later bank date is still unreconciled', () => {
    const { k } = s;
    setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.r1.entryId, bankDate: '2026-04-02' }, { ledgerEntryId: s.p1.entryId, bankDate: '2026-04-16' }] });
    const rec = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-15', show: 'reconciled' });
    assert.deepEqual(rec.entries.map((e) => e.ledgerEntryId), [s.r1.entryId]);
    const un = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-15' });
    // Cheque 000501 cleared on 16-Apr is outstanding as at 15-Apr: as per bank = 85,000 + 40,000 = 1,25,000.
    assert.deepEqual(un.entries.map((e) => [e.ledgerEntryId, e.category, e.bankDate]), [[s.p1.entryId, 'issued_not_presented', '2026-04-16']]);
    assert.deepEqual(pick(un), { books: rs(85_000), issued: rs(40_000), deposited: 0, early: 0, bank: rs(1_25_000) });
  });

  it('works for a Bank OD ledger (Cr balance) and refuses non-bank ledgers', () => {
    const { k } = s;
    const od = payment(k, { date: '2026-04-05', amount: 10_000, other: k.L.supreme, bank: k.L.sbiOd, instrument: cheque('900001') });
    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.sbiOd, asOf: '2026-04-30' });
    // Books −2,00,000 − 10,000 = −2,10,000 (Cr, overdrawn); cheque not presented → bank shows −2,00,000.
    assert.equal(r.ledger.isOd, true);
    assert.deepEqual(pick(r), { books: -rs(2_10_000), issued: rs(10_000), deposited: 0, early: 0, bank: -rs(2_00_000) });
    assert.deepEqual(r.entries.map((e) => e.ledgerEntryId), [od.entryId]);
    assert.throws(
      () => brs(k.t.db, k.t.today, { ledgerId: k.L.rent, asOf: '2026-04-30' }),
      (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /Bank Accounts or Bank OD.*Office Rent.*Indirect Expenses/.test(e.message),
    );
  });

  it('summary: books vs bank per bank ledger, unreconciled counts and statement status', () => {
    const { k } = s;
    importHdfc(k);
    autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    const rows = bankSummary(k.t.db, k.t.today, '2026-04-30');
    const hdfc = rows.find((r) => r.id === k.L.hdfc);
    const od = rows.find((r) => r.id === k.L.sbiOd);
    assert.ok(hdfc && od);
    assert.equal(hdfc.balanceAsPerBooks, rs(79_000));
    assert.equal(hdfc.balanceAsPerBank, rs(82_000));
    assert.deepEqual(hdfc.unreconciled, { count: 2, depositsCount: 1, deposits: rs(12_000), issuedCount: 1, issued: rs(15_000) });
    assert.equal(hdfc.lastReconciledDate, '2026-04-24');
    // Statement 81,410 − bank as per books on 30-Apr 82,000 = −590 (the SMS charges not yet entered).
    assert.deepEqual(hdfc.lastStatement, { date: '2026-04-30', balance: rs(81_410), importedAt: hdfc.lastStatement?.importedAt, difference: -rs(590) });
    assert.deepEqual(hdfc.statementLines, { unmatched: 1, matched: 3, created: 0, ignored: 0 });
    assert.equal(od.balanceAsPerBooks, -rs(2_00_000));
    assert.equal(od.lastStatement, null);
  });
});

describe('setBankDates', () => {
  let s: Scenario;
  beforeEach(() => {
    s = scenario();
  });
  afterEach(() => s.k.t.close());

  const ruleError = (re: RegExp) => (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && re.test(e.message);

  it('sets, keeps and clears bank dates and audits one entry per bank ledger', () => {
    const { k } = s;
    const res = setBankDates(k.t.ctx, {
      entries: [
        { ledgerEntryId: s.r1.entryId, bankDate: '2026-04-02' },
        { ledgerEntryId: s.p1.entryId, bankDate: '2026-04-07' },
      ],
    });
    assert.deepEqual(res, { updated: 2, unchanged: 0, unmatchedLines: 0 });
    const again = setBankDates(k.t.ctx, {
      entries: [
        { ledgerEntryId: s.r1.entryId, bankDate: '2026-04-02' },
        { ledgerEntryId: s.p1.entryId, bankDate: null },
      ],
    });
    assert.deepEqual(again, { updated: 1, unchanged: 1, unmatchedLines: 0 });
    assert.equal(bankDateOf(k, s.p1.entryId), null);
    const audits = k.t.db.all<{ action: string; entity_type: string; entity_id: number; after_json: string }>(
      `SELECT action, entity_type, entity_id, after_json FROM audit_log WHERE entity_type = 'bank_reconciliation' ORDER BY id`,
    );
    assert.equal(audits.length, 2);
    assert.deepEqual([audits[0].action, audits[0].entity_id], ['alter', k.L.hdfc]);
    assert.equal((JSON.parse(audits[1].after_json) as { entries: unknown[][] }).entries[0][3], null);
  });

  it('accepts a bank date on/after the cheque date even when the voucher is dated later', () => {
    const { k } = s;
    // p3: voucher 27-Apr, cheque 22-Apr → 22-Apr is the earliest allowed date.
    setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p3.entryId, bankDate: '2026-04-22' }] });
    assert.equal(bankDateOf(k, s.p3.entryId), '2026-04-22');
    assert.throws(
      () => setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p3.entryId, bankDate: '2026-04-21' }] }),
      ruleError(/before the cheque date 22-Apr-2026/),
    );
  });

  it('rejects a bank date before the voucher date, after today, on a non-bank line, optional and future post-dated vouchers', () => {
    const { k } = s;
    assert.throws(() => setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p1.entryId, bankDate: '2026-04-02' }] }), ruleError(/before the voucher date 03-Apr-2026/));
    assert.throws(() => setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p1.entryId, bankDate: '2026-05-01' }] }), ruleError(/after today/));
    const rentLine = k.t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :v AND ledger_id = :l', { v: s.p2.voucherId, l: k.L.rent }) as number;
    assert.throws(() => setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: rentLine, bankDate: '2026-04-21' }] }), ruleError(/not a bank ledger/));
    assert.throws(() => setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.opt.entryId, bankDate: '2026-04-21' }] }), ruleError(/optional or cancelled/));
    assert.throws(() => setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.pdc.entryId, bankDate: '2026-04-29' }] }), ruleError(/post-dated voucher that is not yet due/));
    assert.throws(
      () =>
        setBankDates(k.t.ctx, {
          entries: [
            { ledgerEntryId: s.r1.entryId, bankDate: '2026-04-02' },
            { ledgerEntryId: s.r1.entryId, bankDate: '2026-04-03' },
          ],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION',
    );
    // Nothing was written by the failed calls.
    assert.equal(bankDateOf(k, s.r1.entryId), null);
    assert.equal(bankDateOf(k, s.p1.entryId), null);
  });

  it('clearing the bank date of a matched entry unmatches its statement line', () => {
    const { k } = s;
    importHdfc(k);
    autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    const res = setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p1.entryId, bankDate: null }] });
    assert.deepEqual(res, { updated: 1, unchanged: 0, unmatchedLines: 1 });
    const line = k.t.db.get<{ status: string; matched_entry_id: number | null }>(`SELECT status, matched_entry_id FROM bank_statement_lines WHERE reference = '000501'`);
    assert.deepEqual(line, { status: 'unmatched', matched_entry_id: null });
  });

  it('an early auto-match can be resent unchanged; moving a matched bank date to another day unmatches the line', () => {
    const { k } = s;
    // Rent cheque 000502 is dated 20-Apr; the bank shows it on 19-Apr (1 day early, inside the 2-day tolerance).
    const csv = [
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '06/04/26,CHQ PAID-MICR CTS-SUPREME SUPPLIERS,000501,06/04/26,"40,000.00",,"60,000.00"',
      '19/04/26,CHQ PAID-OFFICE RENT,000502,19/04/26,"15,000.00",,"45,000.00"',
    ].join('\n');
    importHdfc(k, csv);
    const am = autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    assert.deepEqual(am.applied.map((a) => a.ledgerEntryId).sort((a, b) => a - b), [s.p1.entryId, s.p2.entryId].sort((a, b) => a - b));
    assert.equal(bankDateOf(k, s.p2.entryId), '2026-04-19');
    // The BRS grid resends the row as it is: no "before the voucher date" error, nothing changes.
    assert.deepEqual(setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p2.entryId, bankDate: '2026-04-19' }] }), { updated: 0, unchanged: 1, unmatchedLines: 0 });
    // A new date for a matched entry must follow the rules and unlinks the statement line (it no longer agrees).
    assert.throws(() => setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p2.entryId, bankDate: '2026-04-18' }] }), ruleError(/before the voucher date 20-Apr-2026/));
    assert.deepEqual(setBankDates(k.t.ctx, { entries: [{ ledgerEntryId: s.p1.entryId, bankDate: '2026-04-07' }] }), { updated: 1, unchanged: 0, unmatchedLines: 1 });
    assert.equal(bankDateOf(k, s.p1.entryId), '2026-04-07');
    const line = k.t.db.get<{ status: string; matched_entry_id: number | null }>(`SELECT status, matched_entry_id FROM bank_statement_lines WHERE reference = '000501'`);
    assert.deepEqual(line, { status: 'unmatched', matched_entry_id: null });
  });

  it('a deleted voucher drops out of the BRS and its statement line becomes unmatched', () => {
    const { k } = s;
    importHdfc(k);
    autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    deleteVoucher(k.t.ctx, s.p3.voucherId);
    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-30' });
    // Books 79,000 + 3,000 = 82,000; as per bank 82,000 + 15,000 − 12,000 = 85,000; statement 81,410:
    // difference −3,590 = unmatched withdrawals 3,000 + 590.
    assert.deepEqual(pick(r), { books: rs(82_000), issued: rs(15_000), deposited: rs(12_000), early: 0, bank: rs(85_000) });
    assert.equal(r.difference, -rs(3_590));
    assert.deepEqual(r.amountsNotInBooks, { count: 2, deposits: 0, withdrawals: rs(3_590) });
    assert.equal(r.unexplainedDifference, 0);
  });

  it('routes: validation of bankDate (null allowed, missing refused) and reports.view for the BRS', async () => {
    const { k } = s;
    const missing = await k.t.call(bankingRoutes, 'banking.setBankDates', { entries: [{ ledgerEntryId: s.r1.entryId }] });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'VALIDATION');
    const ok = await k.t.callOk<{ updated: number }>(bankingRoutes, 'banking.setBankDates', { entries: [{ ledgerEntryId: s.r1.entryId, bankDate: '2026-04-03' }] });
    assert.equal(ok.updated, 1);
    const auditor = k.t.sessionAs({ role: 'Auditor' });
    const view = await k.t.call(bankingRoutes, 'banking.brs', { ledgerId: k.L.hdfc, asOf: '2026-04-30' }, { session: auditor });
    assert.equal(view.ok, true);
    const denied = await k.t.call(bankingRoutes, 'banking.setBankDates', { entries: [{ ledgerEntryId: s.r1.entryId, bankDate: null }] }, { session: auditor });
    assert.equal(!denied.ok && denied.error.code, 'FORBIDDEN');
    assert.equal(bankDateOf(k, s.r1.entryId), '2026-04-03');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrsResult } from '../../../../shared/types/banking.ts';
import {
  bankDateProblem,
  earliestBankDate,
  evaluateRows,
  explainBrs,
  fillBankDates,
  parseBankDateCell,
  pendingSave,
  projectedBankBalance,
  type BankDateEntry,
} from './brsGrid.ts';

const TODAY = '2026-04-30';
const REF = '2026-04-30';

const row = (id: number, date: string, debit: number, credit: number, more: Partial<BankDateEntry> = {}): BankDateEntry => ({
  ledgerEntryId: id,
  date,
  instrumentDate: null,
  bankDate: null,
  debit,
  credit,
  isPostDated: false,
  ...more,
});

describe('BRS grid: typing bank dates', () => {
  const e = { date: '2026-04-10', instrumentDate: null };

  it('understands date shorthand, v (voucher date), ditto and clearing', () => {
    assert.deepEqual(parseBankDateCell('12', e, REF, null), { kind: 'date', iso: '2026-04-12' });
    assert.deepEqual(parseBankDateCell('12-4', e, REF, null), { kind: 'date', iso: '2026-04-12' });
    assert.deepEqual(parseBankDateCell('12042026', e, REF, null), { kind: 'date', iso: '2026-04-12' });
    assert.deepEqual(parseBankDateCell('30-Apr-2026', e, REF, null), { kind: 'date', iso: '2026-04-30' });
    // v is the voucher date, even when the cheque is dated earlier.
    assert.deepEqual(parseBankDateCell('V', { date: '2026-04-10', instrumentDate: '2026-04-08' }, REF, null), { kind: 'date', iso: '2026-04-10' });
    assert.deepEqual(parseBankDateCell('.', e, REF, '2026-04-15'), { kind: 'date', iso: '2026-04-15' });
    assert.equal(parseBankDateCell('"', e, REF, null).kind, 'invalid');
    assert.deepEqual(parseBankDateCell('  ', e, REF, null), { kind: 'clear' });
    assert.equal(parseBankDateCell('abc', e, REF, null).kind, 'invalid');
  });

  it('applies the server rules: not before the voucher/cheque date, not after today', () => {
    assert.equal(earliestBankDate({ date: '2026-04-10', instrumentDate: '2026-04-12' }), '2026-04-10');
    assert.equal(bankDateProblem('2026-04-10', e, TODAY), null);
    assert.match(bankDateProblem('2026-04-09', e, TODAY) ?? '', /Before the voucher date 10-Apr-2026/);
    assert.match(bankDateProblem('2026-04-07', { date: '2026-04-10', instrumentDate: '2026-04-08' }, TODAY) ?? '', /Before the cheque date 08-Apr-2026/);
    assert.match(bankDateProblem('2026-05-01', e, TODAY) ?? '', /After today/);
  });

  it('evaluates rows in order (ditto uses the row above), collects changes and errors', () => {
    const rows = [row(1, '2026-04-02', 0, 40000), row(2, '2026-04-05', 25000, 0), row(3, '2026-04-20', 0, 1500, { bankDate: '2026-04-21' }), row(4, '2026-04-25', 0, 900)];
    const drafts = new Map([
      [1, '6'],
      [2, '.'],
      [3, ''],
      [4, '24'],
    ]);
    const st = evaluateRows(rows, drafts, REF, TODAY);
    assert.deepEqual(st.get(1), { effective: '2026-04-06', changed: true, error: null });
    assert.deepEqual(st.get(2), { effective: '2026-04-06', changed: true, error: null });
    assert.deepEqual(st.get(3), { effective: null, changed: true, error: null });
    assert.equal(st.get(4)?.changed, false);
    assert.match(st.get(4)?.error ?? '', /Before the voucher date 25-Apr-2026/);
    assert.deepEqual(pendingSave(rows, st), {
      entries: [
        { ledgerEntryId: 1, bankDate: '2026-04-06' },
        { ledgerEntryId: 2, bankDate: '2026-04-06' },
        { ledgerEntryId: 3, bankDate: null },
      ],
      errors: 1,
    });
    // Typing the saved date again is not a change.
    const same = evaluateRows(rows, new Map([[3, '21-4-2026']]), REF, TODAY);
    assert.deepEqual(same.get(3), { effective: '2026-04-21', changed: false, error: null });
    // Nor an error when the saved date (from an auto-match 2 days early) predates the voucher.
    const early = [row(5, '2026-04-20', 0, 1500, { bankDate: '2026-04-18' })];
    assert.deepEqual(evaluateRows(early, new Map([[5, '18']]), REF, TODAY).get(5), { effective: '2026-04-18', changed: false, error: null });
    assert.match(evaluateRows(early, new Map([[5, '19']]), REF, TODAY).get(5)?.error ?? '', /Before the voucher date/);
  });

  it('Alt+R fills rows without a bank date with the statement date, skipping rows dated later', () => {
    const rows = [row(1, '2026-04-02', 0, 100), row(2, '2026-04-29', 100, 0), row(3, '2026-04-03', 0, 100, { bankDate: '2026-04-04' }), row(4, '2026-04-04', 0, 50)];
    const out = fillBankDates(rows, new Map([[4, '10']]), '2026-04-28', TODAY);
    assert.deepEqual([out.filled, out.skipped], [1, 1]);
    assert.deepEqual([...out.drafts.entries()], [
      [4, '10'],
      [1, '28-Apr-2026'],
    ]);
  });

  it('projects the balance as per bank after saving', () => {
    const rows = [row(1, '2026-04-02', 0, 40000), row(2, '2026-04-05', 25000, 0), row(3, '2026-04-20', 0, 1500, { bankDate: '2026-04-21' })];
    const st = evaluateRows(
      rows,
      new Map([
        [1, '6'],
        [2, '1-5-2026'],
        [3, ''],
      ]),
      REF,
      '2026-05-31',
    );
    // As per bank 1,00,000: −40,000 now reflected; +25,000 cleared after asOf (no change); +1,500 no longer reflected.
    // 1,00,000 − 40,000 + 1,500 = 61,500.
    assert.equal(projectedBankBalance({ balanceAsPerBank: 100000, asOf: '2026-04-30' }, rows, st), 61500);
  });
});

describe('BRS explanation', () => {
  const base: BrsResult = {
    ledger: { id: 1, name: 'HDFC Bank', isOd: false, accountNo: null, bankName: null, ifsc: null, branch: null },
    asOf: '2026-04-30',
    from: '2026-04-01',
    show: 'unreconciled',
    balanceAsPerBooks: 7900000,
    chequesIssuedNotPresented: 1500000,
    chequesDepositedNotCleared: 1200000,
    clearedBeforeVoucherDate: 0,
    balanceAsPerBank: 8200000,
    statementBalance: 8141000,
    statementDate: '2026-04-30',
    balanceAsPerBankOnStatementDate: 8200000,
    difference: -59000,
    amountsNotInBooks: { count: 1, deposits: 0, withdrawals: 59000 },
    unexplainedDifference: 0,
    counts: { issuedNotPresented: 1, depositedNotCleared: 1, clearedBeforeVoucher: 0, reconciledListed: 0 },
    entries: [],
    truncated: false,
  };
  const fmt = (p: number) => `₹${p / 100}`;

  it('explains a difference covered by statement lines not in the books', () => {
    const x = explainBrs(base, fmt);
    assert.equal(x.status, 'explained');
    assert.match(x.message, /₹590 is fully explained by 1 statement line/);
    assert.deepEqual(x.lines.map((l) => [l.key, l.op ?? '', l.amount]), [
      ['books', '', 7900000],
      ['issued', '+', 1500000],
      ['deposited', '−', 1200000],
      ['bank', '', 8200000],
      ['statement', '', 8141000],
      ['difference', '', -59000],
      ['notInBooks', '', -59000],
      ['unexplained', '', 0],
    ]);
  });

  it('a statement ending before the BRS date is compared on its own last date', () => {
    // Statement to 24-Apr: 82,000 = bank per books on 24-Apr; a cheque cleared on 29-Apr makes the BRS bank 94,000.
    const r: BrsResult = { ...base, balanceAsPerBank: 9400000, statementDate: '2026-04-24', statementBalance: 8200000, balanceAsPerBankOnStatementDate: 8200000, difference: 0, amountsNotInBooks: { count: 0, deposits: 0, withdrawals: 0 }, unexplainedDifference: 0 };
    const x = explainBrs(r, fmt);
    assert.equal(x.status, 'agrees');
    assert.deepEqual(x.lines.slice(-4).map((l) => [l.key, l.amount]), [['bank', 9400000], ['bankOnStatement', 8200000], ['statement', 8200000], ['difference', 0]]);
    assert.match(x.lines[x.lines.length - 1].label, /^Difference on 24-Apr-2026/);
  });

  it('agrees, unexplained and no-statement states', () => {
    assert.equal(explainBrs({ ...base, statementBalance: 8200000, difference: 0, amountsNotInBooks: { count: 0, deposits: 0, withdrawals: 0 }, unexplainedDifference: 0 }, fmt).status, 'agrees');
    const un = explainBrs({ ...base, unexplainedDifference: -10000 }, fmt);
    assert.equal(un.status, 'unexplained');
    assert.match(un.message, /^₹100 is not explained/);
    const none = explainBrs({ ...base, statementBalance: null, statementDate: null, difference: null, unexplainedDifference: null, clearedBeforeVoucherDate: -300000 }, fmt);
    assert.equal(none.status, 'no_statement');
    assert.deepEqual(none.lines.map((l) => [l.key, l.op ?? '']), [['books', ''], ['issued', '+'], ['deposited', '−'], ['early', '−'], ['bank', '']]);
  });
});

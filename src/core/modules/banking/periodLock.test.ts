/**
 * Bank dates and the period lock (follow-up): a bank date on or before the locked-up-to date belongs to a
 * closed reconciliation. Setting, moving or clearing one — by hand (BRS), by matching / unmatching a
 * statement line, by deleting a statement with "unmatch" — needs the right to lock and unlock the books
 * (period.lock; Owners always). Clearing a locked month's cheque in an open month stays ordinary work.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AutoMatchResult, StatementImportResult, StatementMapping, StatementPreview } from '../../../shared/types/banking.ts';
import { setPeriodLock } from '../company/service.ts';
import { vouchersRoutes } from '../vouchers/routes.ts';
import { bankingRoutes } from './routes.ts';
import { bankDateOf, cheque, receipt, setupBank, textBytes, type BankKit } from './testkit.ts';

const STATEMENT = [
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '05/04/26,NEFT CR-HDFC0000001-ACME TRADERS-N091260001,N091260001,05/04/26,,"25,000.00","1,25,000.00"',
  '20/04/26,NEFT CR-BHARAT STORES-N091260002,N091260002,20/04/26,,"5,000.00","1,30,000.00"',
];

describe('banking: bank dates in the locked period', () => {
  let k: BankKit;
  /** May reconcile, may not lock / unlock the books. */
  let clerk: ReturnType<BankKit['t']['sessionAs']>;
  beforeEach(() => {
    k = setupBank();
    clerk = k.t.sessionAs({ permissions: ['banking.reconcile', 'reports.view', 'vouchers.view'] });
  });
  afterEach(() => k.t.close());

  const lock = (date: string) => k.t.db.transaction(() => setPeriodLock(k.t.ctx, date));
  const setDate = (entryId: number, bankDate: string | null, session = clerk) =>
    k.t.call(bankingRoutes, 'banking.setBankDates', { entries: [{ ledgerEntryId: entryId, bankDate }] }, { session });
  const code = (r: Awaited<ReturnType<BankKit['t']['call']>>) => (r.ok ? 'ok' : r.error.code);

  it('BRS: a clerk cannot set, move or clear a bank date in the locked period; an open-period date is fine; the Owner may', async () => {
    const a = receipt(k, { date: '2026-04-02', amount: 25_000, other: k.L.acme });
    const b = receipt(k, { date: '2026-04-03', amount: 1_000, other: k.L.bharat });
    const c = receipt(k, { date: '2026-04-04', amount: 2_000, other: k.L.bharat });
    assert.equal(code(await setDate(a.entryId, '2026-04-05')), 'ok');
    lock('2026-04-10');

    const moved = await setDate(a.entryId, '2026-04-12');
    assert.equal(code(moved), 'LOCKED');
    assert.match(moved.ok ? '' : moved.error.message, /Books are locked up to 10-Apr-2026\. .* bank date 05-Apr-2026, which is in the locked period/);
    assert.equal(code(await setDate(a.entryId, null)), 'LOCKED', 'clearing a locked bank date');
    assert.equal(code(await setDate(b.entryId, '2026-04-09')), 'LOCKED', 'a new bank date inside the lock');
    assert.equal(bankDateOf(k, a.entryId), '2026-04-05');
    assert.equal(bankDateOf(k, b.entryId), null);

    // A locked month's receipt clearing in the open period is ordinary work.
    assert.equal(code(await setDate(c.entryId, '2026-04-15')), 'ok');
    assert.equal(bankDateOf(k, c.entryId), '2026-04-15');
    // Someone who may lock and unlock the books (Owner, or period.lock) may change it.
    const owner = k.t.sessionAs({ role: 'Owner' });
    assert.equal(code(await setDate(a.entryId, '2026-04-06', owner)), 'ok');
    const withLockRight = k.t.sessionAs({ permissions: ['banking.reconcile', 'period.lock'] });
    assert.equal(code(await setDate(b.entryId, '2026-04-09', withLockRight)), 'ok');
  });

  it('statement lines: auto-match leaves locked lines for later; manual match, unmatch and delete-with-unmatch are refused', async () => {
    const a = receipt(k, { date: '2026-04-05', amount: 25_000, other: k.L.acme });
    const b = receipt(k, { date: '2026-04-20', amount: 5_000, other: k.L.bharat });
    const p = await k.t.callOk<StatementPreview>(bankingRoutes, 'banking.statement.preview', { ledgerId: k.L.hdfc, fileName: 'hdfc.csv', bytes: textBytes(STATEMENT.join('\n')) });
    const imp = await k.t.callOk<StatementImportResult>(bankingRoutes, 'banking.statement.import', {
      ledgerId: k.L.hdfc,
      fileName: 'hdfc.csv',
      bytes: textBytes(STATEMENT.join('\n')),
      mapping: p.mapping as StatementMapping,
    });
    lock('2026-04-10');

    // The clerk's auto-match matches only the open-period line (20-Apr).
    const auto = await k.t.callOk<AutoMatchResult>(bankingRoutes, 'banking.autoMatch', { ledgerId: k.L.hdfc }, { session: clerk });
    assert.deepEqual(auto.applied.map((x) => x.ledgerEntryId), [b.entryId]);
    assert.equal(bankDateOf(k, a.entryId), null);
    assert.equal(bankDateOf(k, b.entryId), '2026-04-20');

    const lineOf = (date: string) => k.t.db.value<number>('SELECT id FROM bank_statement_lines WHERE txn_date = :d', { d: date }) as number;
    assert.equal(code(await k.t.call(bankingRoutes, 'banking.match', { lineId: lineOf('2026-04-05'), ledgerEntryId: a.entryId }, { session: clerk })), 'LOCKED');
    // The Owner matches it (bank date 05-Apr, in the lock).
    await k.t.callOk(bankingRoutes, 'banking.match', { lineId: lineOf('2026-04-05'), ledgerEntryId: a.entryId });
    assert.equal(bankDateOf(k, a.entryId), '2026-04-05');

    assert.equal(code(await k.t.call(bankingRoutes, 'banking.unmatch', { lineId: lineOf('2026-04-05') }, { session: clerk })), 'LOCKED');
    // Deleting the statement with "unmatch" would clear the locked bank date: refused, nothing changed.
    const del = await k.t.call(bankingRoutes, 'banking.statement.deleteBatch', { batchId: imp.batchId, unmatch: true }, { session: clerk });
    assert.equal(code(del), 'LOCKED');
    assert.match(del.ok ? '' : del.error.message, /Deleting this statement with "unmatch" would change the bank date 05-Apr-2026/);
    assert.equal(bankDateOf(k, a.entryId), '2026-04-05');
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM bank_statement_lines'), 2);
    // An unmatch of the open-period line is fine.
    assert.equal(code(await k.t.call(bankingRoutes, 'banking.unmatch', { lineId: lineOf('2026-04-20') }, { session: clerk })), 'ok');
    assert.equal(bankDateOf(k, b.entryId), null);
  });

  it('vouchers: deleting, cancelling or altering an open-period voucher whose bank date is in the locked period needs period.lock', async () => {
    // Dated 11-Apr (open) for a cheque dated 08-Apr that cleared on 09-Apr — then the books are locked up to 10-Apr.
    const a = receipt(k, { date: '2026-04-11', amount: 4_000, other: k.L.acme, instrument: cheque('400123', '2026-04-08') });
    assert.equal(code(await setDate(a.entryId, '2026-04-09')), 'ok');
    lock('2026-04-10');
    const staff = k.t.sessionAs({ permissions: ['vouchers.view', 'vouchers.create', 'vouchers.alter', 'vouchers.delete', 'vouchers.backdate'] });

    const del = await k.t.call(vouchersRoutes, 'vouchers.delete', { id: a.voucherId }, { session: staff });
    assert.equal(code(del), 'LOCKED');
    assert.match(del.ok ? '' : del.error.message, /Deleting this voucher would clear the bank date 09-Apr-2026, which is in the locked period/);
    assert.equal(code(await k.t.call(vouchersRoutes, 'vouchers.cancel', { id: a.voucherId, reason: 'wrong party' }, { session: staff })), 'LOCKED');
    // Altering the amount drops the bank entry's reconciliation: refused too; nothing changed.
    const alter = await k.t.call(
      vouchersRoutes,
      'vouchers.save',
      {
        id: a.voucherId,
        voucherTypeId: k.vt.receipt,
        date: '2026-04-11',
        mode: 'ledger',
        ledgers: [
          { ledgerId: k.L.hdfc, amount: 450_000 },
          { ledgerId: k.L.acme, amount: -450_000 },
        ],
        acknowledgeWarnings: true,
      },
      { session: staff },
    );
    assert.equal(code(alter), 'LOCKED');
    assert.equal(bankDateOf(k, a.entryId), '2026-04-09');
    // A narration-only alteration keeps the bank date: allowed.
    const kept = await k.t.call(
      vouchersRoutes,
      'vouchers.save',
      {
        id: a.voucherId,
        voucherTypeId: k.vt.receipt,
        date: '2026-04-11',
        mode: 'ledger',
        narration: 'Advance',
        ledgers: [
          { ledgerId: k.L.hdfc, amount: 400_000, instrument: cheque('400123', '2026-04-08') },
          { ledgerId: k.L.acme, amount: -400_000 },
        ],
        acknowledgeWarnings: true,
      },
      { session: staff },
    );
    assert.equal(code(kept), 'ok');
    const entry = k.t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :v AND ledger_id = :l', { v: a.voucherId, l: k.L.hdfc }) as number;
    assert.equal(bankDateOf(k, entry), '2026-04-09');
    // Someone who may lock and unlock the books may delete it.
    const withLockRight = k.t.sessionAs({ permissions: ['vouchers.view', 'vouchers.delete', 'vouchers.backdate', 'period.lock'] });
    assert.equal(code(await k.t.call(vouchersRoutes, 'vouchers.delete', { id: a.voucherId }, { session: withLockRight })), 'ok');
  });
});

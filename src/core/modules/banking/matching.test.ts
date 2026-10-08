/**
 * Reconciling imported statement lines with vouchers posted through the vouchers service: auto-match (apply,
 * dry run, batch filter, books filter), suggestions, manual match / unmatch / ignore with their rules, voucher
 * alteration keeping the match, and permissions through the dispatcher.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AutoMatchResult, MatchCandidate, StatementLineView } from '../../../shared/types/banking.ts';
import { AppError } from '../../lib/errors.ts';
import { getVoucher } from '../vouchers/queries.ts';
import { cancelVoucher, saveVoucher } from '../vouchers/service.ts';
import { autoMatch, ignoreLine, matchLine, suggestions, unmatchLine } from './matching.ts';
import { bankingRoutes } from './routes.ts';
import { importStatement } from './statements.ts';
import { bankDateOf, cheque, lineIds, lineStatus, payment, receipt, setupBank, textBytes, type BankKit, type Posted } from './testkit.ts';

const HEADER = 'Date,Narration,Ref,Withdrawal,Deposit,Balance';
const MAPPING = {
  preset: 'generic' as const,
  headerRow: 0,
  columns: { date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5 },
  dateOrder: 'dmy' as const,
};

function load(k: BankKit, rows: string[], fileName = 'stmt.csv'): number {
  const res = importStatement(k.t.ctx, { ledgerId: k.L.hdfc, fileName, bytes: textBytes([HEADER, ...rows].join('\n')), mapping: MAPPING });
  return res.batchId as number;
}

const isRule = (re: RegExp) => (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && re.test(e.message);

describe('auto-match against posted vouchers', () => {
  let k: BankKit;
  let rcpt: Posted;
  let chq501: Posted;
  let chq502: Posted;
  let rentA: Posted;
  let rentB: Posted;
  beforeEach(() => {
    k = setupBank();
    rcpt = receipt(k, { date: '2026-04-02', amount: 25_000, other: k.L.acme, instrument: { type: 'neft', number: 'N091260001' } });
    chq501 = payment(k, { date: '2026-04-08', amount: 15_000, other: k.L.supreme, instrument: cheque('000501') });
    chq502 = payment(k, { date: '2026-04-10', amount: 15_000, other: k.L.supreme, instrument: cheque('000502') });
    rentA = payment(k, { date: '2026-04-15', amount: 9_000, other: k.L.rent });
    rentB = payment(k, { date: '2026-04-15', amount: 9_000, other: k.L.rent });
    load(k, [
      '03/04/2026,NEFT CR-ACME TRADERS-N091260001,N091260001,,25000.00,125000.00',
      '10/04/2026,CHQ PAID-MICR CTS-000501,000501,15000.00,,110000.00',
      '16/04/2026,TRANSFER TO LANDLORD,,9000.00,,101000.00',
      '20/04/2026,SMS CHARGES,,59.00,,100941.00',
    ]);
  });
  afterEach(() => k.t.close());

  it('applies exact and reference-boosted matches, leaves ambiguity as a suggestion and audits', async () => {
    const res = await k.t.callOk<AutoMatchResult>(bankingRoutes, 'banking.autoMatch', { ledgerId: k.L.hdfc });
    const [l1, l2, l3, l4] = lineIds(k);
    // Receipt: 50 + (25 − 3) + 30 (UTR) + 15 (ACME) + 5 (NEFT) = 122 → 100.
    // Cheque 000501 (2 days late) beats the same-amount 000502 of the statement date by the cheque number.
    assert.deepEqual(
      res.applied.map((a) => [a.lineId, a.ledgerEntryId, a.score]),
      [
        [l1, rcpt.entryId, 100],
        [l2, chq501.entryId, 100],
      ],
    );
    assert.equal(res.considered, 4);
    assert.equal(res.withoutCandidates, 1, 'SMS charges have no voucher');
    assert.equal(res.suggestions.length, 1);
    const sug = res.suggestions[0];
    assert.equal(sug.line.id, l3);
    assert.equal(sug.reason, 'ambiguous');
    assert.deepEqual(sug.candidates.map((c) => c.ledgerEntryId).sort((a, b) => a - b), [rentA.entryId, rentB.entryId].sort((a, b) => a - b));
    assert.equal(sug.candidates[0].particulars, 'Office Rent');
    assert.equal(sug.candidates[0].dayGap, 1);

    assert.equal(bankDateOf(k, rcpt.entryId), '2026-04-03');
    assert.equal(bankDateOf(k, chq501.entryId), '2026-04-10');
    assert.equal(bankDateOf(k, chq502.entryId), null);
    assert.deepEqual(lineStatus(k, l1), { status: 'matched', matched_entry_id: rcpt.entryId, match_method: 'auto' });
    assert.equal(lineStatus(k, l4).status, 'unmatched');
    const audit = k.t.db.get<{ entity_label: string }>(`SELECT entity_label FROM audit_log WHERE entity_type = 'bank_reconciliation'`);
    assert.equal(audit?.entity_label, 'Auto-match: HDFC Bank (2 lines)');

    // Running again finds nothing new to apply.
    const again = autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    assert.deepEqual([again.applied.length, again.considered], [0, 2]);
  });

  it('dry run reports the same matches without writing; the batch filter limits the lines', () => {
    const dry = autoMatch(k.t.ctx, { ledgerId: k.L.hdfc, apply: false });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.applied.length, 2);
    assert.equal(bankDateOf(k, rcpt.entryId), null);
    assert.ok(lineIds(k).every((id) => lineStatus(k, id).status === 'unmatched'));

    const b2 = load(k, ['18/04/2026,CHQ PAID 000502,000502,15000.00,,85941.00'], 'second.csv');
    const only = autoMatch(k.t.ctx, { ledgerId: k.L.hdfc, batchId: b2 });
    assert.equal(only.considered, 1);
    // 000502 dated 10-Apr presented 18-Apr: 8 days > 7-day window, but its cheque number is in the line (92-day window).
    assert.deepEqual(only.applied.map((a) => a.ledgerEntryId), [chq502.entryId]);
  });

  it('suggestions for a line, then a manual match and unmatch (bank date follows)', async () => {
    const l3 = lineIds(k)[2];
    const cands = await k.t.callOk<MatchCandidate[]>(bankingRoutes, 'banking.suggestions', { lineId: l3 });
    assert.deepEqual(cands.map((c) => c.amount), [-900000, -900000]);
    assert.ok(cands.every((c) => c.reasons[0].code === 'amount'));
    const view = await k.t.callOk<StatementLineView>(bankingRoutes, 'banking.match', { lineId: l3, ledgerEntryId: rentB.entryId });
    assert.equal(view.status, 'matched');
    assert.equal(view.matchMethod, 'manual');
    assert.equal(view.matched?.voucherId, rentB.voucherId);
    assert.equal(bankDateOf(k, rentB.entryId), '2026-04-16');
    // The same pair again is a no-op; another entry for a matched line is refused.
    assert.equal(matchLine(k.t.ctx, l3, rentB.entryId).status, 'matched');
    assert.throws(() => matchLine(k.t.ctx, l3, rentA.entryId), isRule(/already matched with Payment/));

    const un = unmatchLine(k.t.ctx, l3);
    assert.equal(un.status, 'unmatched');
    assert.equal(un.matched, null);
    assert.equal(bankDateOf(k, rentB.entryId), null);
    assert.throws(() => unmatchLine(k.t.ctx, l3), isRule(/is not matched with any voucher/));
  });

  it('manual match rules: amount, other bank, entry already matched, too early, optional / not-yet-due vouchers', () => {
    const [l1, l2, l3, l4] = lineIds(k);
    assert.throws(() => matchLine(k.t.ctx, l4, rentA.entryId), isRule(/Amounts differ: the statement shows a withdrawal of ₹ ?59\.00/));
    const od = payment(k, { date: '2026-04-16', amount: 9_000, other: k.L.rent, bank: k.L.sbiOd });
    assert.throws(() => matchLine(k.t.ctx, l3, od.entryId), isRule(/does not touch this bank account/));
    matchLine(k.t.ctx, l3, rentA.entryId);
    const extra = load(k, ['17/04/2026,TRANSFER TO LANDLORD AGAIN,,9000.00,,91941.00'], 'extra.csv');
    const lExtra = k.t.db.value<number>('SELECT id FROM bank_statement_lines WHERE batch_id = :b', { b: extra }) as number;
    assert.throws(() => matchLine(k.t.ctx, lExtra, rentA.entryId), isRule(/already matched with statement line 16-Apr-2026/));
    const late = payment(k, { date: '2026-04-25', amount: 9_000, other: k.L.rent });
    assert.throws(() => matchLine(k.t.ctx, lExtra, late.entryId), isRule(/more than 2 days before Payment/));
    const opt = payment(k, { date: '2026-04-17', amount: 9_000, other: k.L.rent, optional: true });
    assert.throws(() => matchLine(k.t.ctx, lExtra, opt.entryId), isRule(/optional or cancelled/));
    const pdc = payment(k, { date: '2026-05-05', amount: 9_000, other: k.L.rent, postDated: true });
    assert.throws(() => matchLine(k.t.ctx, lExtra, pdc.entryId), isRule(/post-dated voucher that is not yet due/));
    // Optional and future post-dated vouchers are never offered either; the 25-Apr payment is 8 days after the line.
    assert.deepEqual(suggestions(k.t.db, k.t.today, lExtra).map((c) => c.ledgerEntryId), [rentB.entryId]);
    assert.equal(lineStatus(k, l1).status, 'unmatched');
    assert.equal(lineStatus(k, l2).status, 'unmatched');
  });

  it('ignore and restore a line; a matched line cannot be ignored', async () => {
    const [, , l3, l4] = lineIds(k);
    const ig = await k.t.callOk<StatementLineView>(bankingRoutes, 'banking.ignoreLine', { lineId: l4, ignore: true });
    assert.equal(ig.status, 'ignored');
    const res = autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    assert.equal(res.considered, 3, 'ignored lines are not considered');
    assert.equal(ignoreLine(k.t.ctx, l4, false).status, 'unmatched');
    matchLine(k.t.ctx, l3, rentA.entryId);
    assert.throws(() => ignoreLine(k.t.ctx, l3, true), isRule(/Unmatch it before ignoring it/));
    assert.equal(k.t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'bank_statement_line'`), 3);
  });

  it('altering a matched voucher keeps the match when the bank amount is unchanged; cancelling unmatches it', () => {
    autoMatch(k.t.ctx, { ledgerId: k.L.hdfc });
    const l1 = lineIds(k)[0];
    const detail = getVoucher(k.t.db, rcpt.voucherId);
    saveVoucher(k.t.ctx, { ...detail.input, narration: 'Received against invoice 12', acknowledgeWarnings: true });
    const newEntry = k.t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :v AND ledger_id = :l', { v: rcpt.voucherId, l: k.L.hdfc }) as number;
    assert.equal(bankDateOf(k, newEntry), '2026-04-03');
    assert.deepEqual(lineStatus(k, l1), { status: 'matched', matched_entry_id: newEntry, match_method: 'auto' });
    cancelVoucher(k.t.ctx, rcpt.voucherId, 'Duplicate entry');
    assert.equal(lineStatus(k, l1).status, 'unmatched');
  });

  it('permissions: reports.view alone cannot match; Accountant can', async () => {
    const [, , l3] = lineIds(k);
    const viewer = k.t.sessionAs({ permissions: ['reports.view', 'vouchers.view'] });
    for (const [route, input] of [
      ['banking.autoMatch', { ledgerId: k.L.hdfc }],
      ['banking.match', { lineId: l3, ledgerEntryId: rentA.entryId }],
      ['banking.unmatch', { lineId: l3 }],
      ['banking.ignoreLine', { lineId: l3, ignore: true }],
      ['banking.suggestions', { lineId: l3 }],
    ] as const) {
      const r = await k.t.call(bankingRoutes, route, input, { session: viewer });
      assert.equal(!r.ok && r.error.code, 'FORBIDDEN', route);
    }
    const accountant = k.t.sessionAs({ role: 'Accountant' });
    const ok = await k.t.call(bankingRoutes, 'banking.match', { lineId: l3, ledgerEntryId: rentA.entryId }, { session: accountant });
    assert.equal(ok.ok, true);
  });
});

/**
 * Vouchers created from statement lines through the real vouchers service: posting, numbering, bank date and
 * line status, instrument from the narration, the kind/ledger rules, all-or-nothing bulk creation and
 * permissions.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { CreateFromLineResult } from '../../../shared/types/banking.ts';
import { AppError } from '../../lib/errors.ts';
import { getVoucher } from '../vouchers/queries.ts';
import { brs } from './brs.ts';
import { createFromLine, createFromLines } from './create.ts';
import { unmatchLine } from './matching.ts';
import { bankingRoutes } from './routes.ts';
import { importStatement } from './statements.ts';
import { bankDateOf, lineIds, lineStatus, payment, receipt, rs, setupBank, textBytes, type BankKit } from './testkit.ts';

const CSV = [
  'Date,Narration,Ref,Withdrawal,Deposit,Balance',
  '05/04/2026,SMS CHARGES QTR,,590.00,,99410.00',
  '12/04/2026,NEFT CR INTEREST ON FD,N555,,1250.00,100660.00',
  '20/04/2026,ATM WDL FORT,,5000.00,,95660.00',
].join('\n');

describe('vouchers from statement lines', () => {
  let k: BankKit;
  let sms: number;
  let interest: number;
  let atm: number;
  beforeEach(() => {
    k = setupBank();
    importStatement(k.t.ctx, {
      ledgerId: k.L.hdfc,
      fileName: 'apr.csv',
      bytes: textBytes(CSV),
      mapping: { preset: 'generic', headerRow: 0, columns: { date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5 }, dateOrder: 'dmy' },
    });
    [sms, interest, atm] = lineIds(k);
  });
  afterEach(() => k.t.close());

  const isRule = (re: RegExp) => (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && re.test(e.message);

  it('payment for bank charges: Dr Bank Charges / Cr bank on the statement date, reconciled and audited', async () => {
    const res = await k.t.callOk<CreateFromLineResult>(bankingRoutes, 'banking.createVoucher', { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges });
    const v = getVoucher(k.t.db, res.voucherId);
    assert.equal(v.voucherType.baseType, 'payment');
    assert.equal(v.date, '2026-04-05');
    assert.equal(v.narration, 'SMS CHARGES QTR');
    assert.equal(res.number, v.number);
    assert.deepEqual(
      v.entries.map((e) => [e.ledgerId, e.amount]),
      [
        [k.L.charges, rs(590)],
        [k.L.hdfc, -rs(590)],
      ],
    );
    assert.equal(bankDateOf(k, res.ledgerEntryId), '2026-04-05');
    assert.deepEqual(lineStatus(k, sms), { status: 'created', matched_entry_id: res.ledgerEntryId, match_method: 'created' });
    assert.equal(k.t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'voucher' AND action = 'create'`), 1);
    assert.equal(k.t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'bank_statement_line'`), 1);
    // BRS: books 1,00,000 − 590 = 99,410 = statement balance on 05-Apr … as of 30-Apr the other two lines are still unexplained.
    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-05' });
    assert.deepEqual([r.balanceAsPerBooks, r.balanceAsPerBank, r.statementBalance, r.difference], [rs(99_410), rs(99_410), rs(99_410), 0]);
  });

  it('receipt for interest takes NEFT and the reference as instrument; contra for an ATM withdrawal debits Cash', () => {
    const rec = createFromLine(k.t.ctx, { lineId: interest, kind: 'receipt', contraLedgerId: k.L.interest, narration: 'FD interest April' });
    const rv = getVoucher(k.t.db, rec.voucherId);
    const bankLine = rv.entries.find((e) => e.ledgerId === k.L.hdfc);
    assert.deepEqual([bankLine?.amount, bankLine?.instrument?.type, bankLine?.instrument?.number], [rs(1_250), 'neft', 'N555']);
    assert.equal(rv.narration, 'FD interest April');
    const con = createFromLine(k.t.ctx, { lineId: atm, kind: 'contra', contraLedgerId: k.L.cash });
    const cv = getVoucher(k.t.db, con.voucherId);
    assert.equal(cv.voucherType.baseType, 'contra');
    assert.deepEqual(cv.entries.map((e) => [e.ledgerId, e.amount]), [[k.L.cash, rs(5_000)], [k.L.hdfc, -rs(5_000)]]);
    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-30' });
    // Books 1,00,000 + 1,250 − 5,000 = 96,250 (both cleared → as per bank too); statement closing 95,660:
    // difference 95,660 − 96,250 = −590 = the SMS charges line that still has no voucher.
    assert.equal(r.balanceAsPerBooks, rs(96_250));
    assert.equal(r.difference, -rs(590));
    assert.equal(r.unexplainedDifference, 0);
  });

  it('refuses the wrong kind for the direction, Cash/Bank ledgers in receipts/payments, non-cash in contra, a matched line', () => {
    assert.throws(() => createFromLine(k.t.ctx, { lineId: sms, kind: 'receipt', contraLedgerId: k.L.charges }), isRule(/is a withdrawal\. Record it as a Payment/));
    assert.throws(() => createFromLine(k.t.ctx, { lineId: interest, kind: 'payment', contraLedgerId: k.L.charges }), isRule(/is a deposit\. Record it as a Receipt/));
    assert.throws(() => createFromLine(k.t.ctx, { lineId: atm, kind: 'payment', contraLedgerId: k.L.cash }), isRule(/Cash\/Bank ledger.*Contra/));
    assert.throws(() => createFromLine(k.t.ctx, { lineId: atm, kind: 'contra', contraLedgerId: k.L.rent }), isRule(/not a Cash or Bank ledger/));
    assert.throws(() => createFromLine(k.t.ctx, { lineId: atm, kind: 'contra', contraLedgerId: k.L.hdfc }), isRule(/not HDFC Bank itself/));
    assert.throws(
      () => createFromLine(k.t.ctx, { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges, voucherTypeId: k.vt.receipt }),
      isRule(/is not a Payment type/),
    );
    createFromLine(k.t.ctx, { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges });
    assert.throws(() => createFromLine(k.t.ctx, { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges }), isRule(/already matched with Payment/));
    assert.equal(k.t.db.value<number>(`SELECT COUNT(*) FROM vouchers`), 1);
  });

  it('bulk creation is all-or-nothing: a failing item rolls back the others and names the item', async () => {
    const before = k.t.db.value<number>('SELECT COUNT(*) FROM vouchers');
    const bad = await k.t.call(bankingRoutes, 'banking.createVouchers', {
      items: [
        { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges },
        { lineId: interest, kind: 'payment', contraLedgerId: k.L.charges },
      ],
    });
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.error.message : '', /^Item 2 of 2: .*is a deposit.*Nothing was saved\.$/);
    assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM vouchers'), before);
    assert.equal(lineStatus(k, sms).status, 'unmatched');

    const twice = await k.t.call(bankingRoutes, 'banking.createVouchers', {
      items: [
        { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges },
        { lineId: sms, kind: 'payment', contraLedgerId: k.L.rent },
      ],
    });
    assert.equal(!twice.ok && twice.error.code, 'VALIDATION');

    const ok = createFromLines(k.t.ctx, [
      { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges },
      { lineId: atm, kind: 'contra', contraLedgerId: k.L.cash },
      { lineId: interest, kind: 'receipt', contraLedgerId: k.L.interest },
    ]);
    assert.equal(ok.length, 3);
    assert.ok(lineIds(k).every((id) => lineStatus(k, id).status === 'created'));
    const r = brs(k.t.db, k.t.today, { ledgerId: k.L.hdfc, asOf: '2026-04-30' });
    // 1,00,000 − 590 + 1,250 − 5,000 = 95,660 = statement closing balance.
    assert.deepEqual([r.balanceAsPerBooks, r.balanceAsPerBank, r.statementBalance, r.difference], [rs(95_660), rs(95_660), rs(95_660), 0]);
  });

  it('duplicate guard: a line that may already be in the books needs confirmation; nothing is saved until confirmed', async () => {
    // The SMS charges were already entered by hand on 05-Apr (₹590, not matched with the statement).
    const manual = payment(k, { date: '2026-04-05', amount: 590, other: k.L.charges });
    const vouchers = (): number => k.t.db.value<number>('SELECT COUNT(*) FROM vouchers') ?? 0;
    const res = await k.t.call(bankingRoutes, 'banking.createVoucher', { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.code, 'BUSINESS_RULE');
    assert.match(res.error.message, /may already be entered in the books/);
    const details = res.error.details as { needsConfirmation: boolean; warnings: string[]; possibleDuplicates: Array<{ lineId: number; candidates: Array<{ ledgerEntryId: number }> }> };
    assert.equal(details.needsConfirmation, true);
    assert.equal(details.warnings.length, 1);
    assert.match(details.warnings[0], /^Payment \S+ dated 05-Apr-2026 — Bank Charges, ₹ ?590\.00 — is already in the books/);
    assert.deepEqual(details.possibleDuplicates.map((p) => [p.lineId, p.candidates.map((c) => c.ledgerEntryId)]), [[sms, [manual.entryId]]]);
    assert.equal(vouchers(), 1);
    assert.equal(lineStatus(k, sms).status, 'unmatched');
    // Confirmed: a second voucher is created on purpose.
    const ok = createFromLine(k.t.ctx, { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges, acknowledgeWarnings: true });
    assert.equal(vouchers(), 2);
    assert.equal(lineStatus(k, sms).matched_entry_id, ok.ledgerEntryId);
  });

  it('duplicate guard: unmatching a created line and creating again flags the voucher created before', () => {
    const first = createFromLine(k.t.ctx, { lineId: atm, kind: 'contra', contraLedgerId: k.L.cash });
    unmatchLine(k.t.ctx, atm);
    assert.throws(
      () => createFromLine(k.t.ctx, { lineId: atm, kind: 'contra', contraLedgerId: k.L.cash }),
      (e: unknown) =>
        e instanceof AppError &&
        e.code === 'BUSINESS_RULE' &&
        (e.details as { possibleDuplicates: Array<{ candidates: Array<{ voucherId: number }> }> }).possibleDuplicates[0].candidates[0].voucherId === first.voucherId,
    );
    // A line with an amount the books do not have is created without any question.
    assert.equal(createFromLine(k.t.ctx, { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges }).lineId, sms);
  });

  it('duplicate guard in bulk: one confirmation lists every flagged item; nothing is saved until confirmed', async () => {
    payment(k, { date: '2026-04-04', amount: 590, other: k.L.charges }); // 1 day before the SMS line
    receipt(k, { date: '2026-04-12', amount: 1_250, other: k.L.interest }); // same day as the interest line
    const before = k.t.db.value<number>('SELECT COUNT(*) FROM vouchers');
    const items = [
      { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges },
      { lineId: atm, kind: 'contra', contraLedgerId: k.L.cash },
      { lineId: interest, kind: 'receipt', contraLedgerId: k.L.interest },
    ];
    const res = await k.t.call(bankingRoutes, 'banking.createVouchers', { items });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error.message, /^2 of the 3 statement lines may already be entered/);
    const d = res.error.details as { needsConfirmation: boolean; warnings: string[]; possibleDuplicates: Array<{ lineId: number }> };
    assert.equal(d.needsConfirmation, true);
    assert.deepEqual(d.possibleDuplicates.map((p) => p.lineId), [sms, interest]);
    assert.match(d.warnings[0], /^Item 1 \(05-Apr-2026 withdrawal ₹ ?590\.00 \(SMS CHARGES QTR\)\): Payment/);
    assert.match(d.warnings[1], /^Item 3 \(12-Apr-2026 deposit/);
    assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM vouchers'), before);
    const ok = await k.t.callOk<CreateFromLineResult[]>(bankingRoutes, 'banking.createVouchers', { items, acknowledgeWarnings: true });
    assert.equal(ok.length, 3);
    assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM vouchers'), (before ?? 0) + 3);
  });

  it('permissions: banking.reconcile and vouchers.create are both required', async () => {
    const input = { lineId: sms, kind: 'payment', contraLedgerId: k.L.charges };
    const dataEntry = k.t.sessionAs({ role: 'Data Entry' }); // vouchers.create, no banking.reconcile
    const r1 = await k.t.call(bankingRoutes, 'banking.createVoucher', input, { session: dataEntry });
    assert.equal(!r1.ok && r1.error.code, 'FORBIDDEN');
    const reconciler = k.t.sessionAs({ permissions: ['banking.reconcile', 'reports.view', 'vouchers.view'] });
    const r2 = await k.t.call(bankingRoutes, 'banking.createVoucher', input, { session: reconciler });
    assert.equal(!r2.ok && r2.error.code, 'FORBIDDEN');
    assert.match(!r2.ok ? r2.error.message : '', /permission to create vouchers/);
    const accountant = k.t.sessionAs({ role: 'Accountant' });
    const r3 = await k.t.call(bankingRoutes, 'banking.createVoucher', input, { session: accountant });
    assert.equal(r3.ok, true);
  });
});

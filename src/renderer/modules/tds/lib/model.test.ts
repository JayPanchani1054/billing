import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blankRate,
  challanErrors,
  challanInput,
  challanTotal,
  enabledKinds,
  initialKind,
  lineSummary,
  monthChoices,
  natureErrors,
  panError,
  previousMonth,
  quarterChoices,
  tanError,
  tdsApplies,
  withNature,
  withOverride,
  applyOverrideEdits,
  ledgerDraftOf,
  ledgerErrors,
  ledgerSaveInput,
  overrideEditsOf,
  overrideErrors,
  statementStatusText,
  dueNoticeText,
  type ChallanDraft,
} from './model.ts';
import type { TdsLedgerDetails, TdsOutstandingRow, TdsStatementRow, TdsVoucherLine } from '../../../../shared/types/tds.ts';

const draft = (over: Partial<ChallanDraft> = {}): ChallanDraft => ({
  kind: 'tds',
  section: '194C',
  period: '2026-04',
  date: '2026-05-07',
  depositDate: '2026-05-07',
  bankLedgerId: 7,
  bsrCode: '0510001',
  challanNo: '12345',
  minorHead: '200',
  tax: 80_000,
  surcharge: null,
  cess: null,
  interest: null,
  fee: null,
  others: null,
  ...over,
});

describe('tds renderer model', () => {
  it('feature gating: kinds on, initial kind, entry panel base types', () => {
    assert.deepEqual(enabledKinds({ tds: true, tcs: false }), ['tds']);
    assert.equal(initialKind('tcs', { tds: true, tcs: false }), 'tds');
    assert.equal(initialKind('tcs', { tds: true, tcs: true }), 'tcs');
    assert.equal(initialKind(undefined, { tds: false, tcs: false }), null);
    assert.equal(tdsApplies('purchase', { tds: true, tcs: false }), true);
    assert.equal(tdsApplies('sales', { tds: true, tcs: false }), false);
    assert.equal(tdsApplies('sales', { tds: false, tcs: true }), true);
    assert.equal(tdsApplies('receipt', { tds: true, tcs: true }), false);
  });

  it('periods: quarters, months and the previous month', () => {
    assert.deepEqual(quarterChoices('2027-02-10'), { fyStart: 2026, quarter: 4, years: [2026, 2025, 2024] });
    assert.equal(previousMonth('2026-01-15'), '2025-12');
    const m = monthChoices('2026-02-01', 3);
    assert.deepEqual(m.map((x) => x.value), ['2026-02', '2026-01', '2025-12']);
  });

  it('PAN / TAN checks', () => {
    assert.equal(panError(''), undefined);
    assert.equal(panError('abcfs1234c'), undefined);
    assert.match(panError('ABCXS1234C') ?? '', /holder type/);
    assert.equal(tanError('MUMA12345B'), undefined);
    assert.match(tanError('MUM12345B') ?? '', /TAN/);
  });

  it('challan draft: errors, total and the voucher input (blank amounts dropped)', () => {
    assert.deepEqual(challanErrors(draft()), {});
    const e = challanErrors(draft({ bsrCode: '123', challanNo: '123456', tax: null, bankLedgerId: null }));
    assert.deepEqual(Object.keys(e).sort(), ['bankLedgerId', 'bsrCode', 'challanNo', 'tax']);
    assert.equal(challanTotal(draft({ interest: 2_400 })), 82_400);
    assert.deepEqual(challanInput(draft({ interest: 2_400 })), {
      kind: 'tds',
      section: '194C',
      period: '2026-04',
      bsrCode: '0510001',
      challanNo: '12345',
      depositDate: '2026-05-07',
      minorHead: '200',
      tax: 80_000,
      interest: 2_400,
    });
  });

  it('nature form checks', () => {
    assert.deepEqual(natureErrors({ name: 'Contracts', section: '194C', rates: [blankRate('2025-04-01')] }), {});
    const e = natureErrors({ name: '', section: 'abc', rates: [blankRate('2025-04-01'), { ...blankRate('2025-04-01'), thresholdBasis: 'excess' }] });
    assert.deepEqual(Object.keys(e).sort(), ['name', 'rates[1].applicableFrom', 'rates[1].thresholdBasis', 'section']);
  });

  it('overrides and the advance nature compose into VoucherInput.tds (null = automatic)', () => {
    let t = withOverride(null, 5, 0, ' Declaration u/s 194C(6) ');
    assert.deepEqual(t, { overrides: [{ natureId: 5, amount: 0, reason: 'Declaration u/s 194C(6)' }] });
    t = withNature(t, 9);
    assert.deepEqual(t, { overrides: [{ natureId: 5, amount: 0, reason: 'Declaration u/s 194C(6)' }], natureId: 9 });
    t = withOverride(t, 5, null, '');
    assert.deepEqual(t, { natureId: 9 });
    assert.equal(withNature(t, null), null);
  });

  it('line summary for the entry panel', () => {
    const l = { kind: 'tds', section: '194C', rate: 2, base: 4_000_000, amount: 80_000, status: 'deducted' } as TdsVoucherLine;
    assert.equal(lineSummary(l), 'TDS u/s 194C @ 2% on ₹ 40,000.00');
    assert.equal(lineSummary({ ...l, amount: 0, status: 'below_threshold' }), 'TDS u/s 194C: nil — below threshold');
  });
});

describe('tds renderer model: ledger details, statements and the entry dialog', () => {
  it('ledger details: party checks (PAN, certificate, TAN) and the save input', () => {
    const party: TdsLedgerDetails = {
      ledgerId: 5,
      ledgerName: 'Sharma Contractors',
      groupName: 'Sundry Creditors',
      role: 'party',
      applicable: true,
      natureId: 3,
      deducteeType: 'firm',
      nonResident: false,
      pan: 'ABCFS1234C',
      panStatus: 'valid',
      certificate: null,
      deductorTan: null,
      legacySection: null,
    };
    const d = ledgerDraftOf(party);
    assert.deepEqual(ledgerErrors(d), {});
    assert.ok(ledgerErrors({ ...d, pan: 'ABC123' }).pan);
    const cert = { ...d, hasCertificate: true, certNumber: '', certRate: null, certFrom: '2026-04-01', certTo: '2026-03-31' };
    const e = ledgerErrors(cert);
    assert.ok(e['certificate.number'] && e['certificate.rate'] && e['certificate.validTo']);
    assert.ok(ledgerErrors({ ...d, deductorTan: 'MUM12345B' }).deductorTan);
    const input = ledgerSaveInput(5, { ...d, pan: ' abcfs1234c ', hasCertificate: true, certNumber: 'C1', certRate: 0.5, certFrom: '2026-04-01', certTo: '2027-03-31', certLimit: 0 });
    assert.equal(input.pan, 'ABCFS1234C');
    assert.deepEqual(input.certificate, { number: 'C1', rate: 0.5, validFrom: '2026-04-01', validTo: '2027-03-31', limit: null, natureId: null });
    assert.equal(input.deductorTan, null);
  });

  it('ledger details: an applicable expense ledger needs a nature; its input carries only applicable + nature', () => {
    const exp = ledgerDraftOf({
      ledgerId: 9, ledgerName: 'Contract Charges', groupName: 'Direct Expenses', role: 'expense', applicable: true, natureId: null,
      deducteeType: null, nonResident: false, pan: null, panStatus: 'not_applicable', certificate: null, deductorTan: null, legacySection: null,
    });
    assert.ok(ledgerErrors(exp).natureId);
    assert.deepEqual(ledgerSaveInput(9, { ...exp, natureId: 2 }), { ledgerId: 9, applicable: true, natureId: 2 });
    assert.deepEqual(ledgerSaveInput(9, { ...exp, applicable: false, natureId: 2 }), { ledgerId: 9, applicable: false, natureId: null });
  });

  it('statement status text: filed late shows the s.234E fee; not filed shows what has run up', () => {
    assert.match(statementStatusText({ dueDate: '2026-07-31', filedOn: '2026-08-05', tokenNo: '123', lateFee: 100000, daysLate: 5 }), /5 day\(s\) late, fee u\/s 234E ₹ ?1,000\.00/);
    assert.match(statementStatusText({ dueDate: '2026-07-31', filedOn: null, tokenNo: null, lateFee: 0, daysLate: 0 }), /Not filed yet \(due 31-Jul-2026\)/);
  });

  it('entry dialog: a changed amount needs a reason; the computed amount drops the override; nature kept', () => {
    const line = { natureId: 7, computed: 300000 } as TdsVoucherLine;
    const edits = overrideEditsOf([line], { overrides: [{ natureId: 7, amount: 0, reason: 'Nil certificate pending' }] });
    assert.deepEqual(edits, [{ natureId: 7, computed: 300000, amount: 0, reason: 'Nil certificate pending' }]);
    assert.deepEqual(overrideErrors([{ ...edits[0], reason: ' ' }]), { 7: 'Say why the amount differs from the computed one.' });
    assert.deepEqual(applyOverrideEdits({ overrides: [{ natureId: 7, amount: 0, reason: 'x' }] }, [{ ...edits[0], amount: 300000 }], undefined), null);
    assert.deepEqual(applyOverrideEdits(null, [{ natureId: 7, computed: 300000, amount: 250000, reason: ' rounded by party ' }], 4), {
      natureId: 4,
      overrides: [{ natureId: 7, amount: 250000, reason: 'rounded by party' }],
    });
    // Blank amount = the computed one.
    assert.deepEqual(applyOverrideEdits(null, [{ natureId: 7, computed: 300000, amount: null, reason: '' }], null), null);
  });
});

describe('tds renderer model: Gateway notice', () => {
  const row = (over: Partial<TdsOutstandingRow>): TdsOutstandingRow => ({
    key: 'k', kind: 'tds', section: '194C', period: '2026-08', periodLabel: 'Aug 2026', payableLedgerName: 'TDS Payable – 194C', deducted: 80000, deposited: 0,
    balance: 80000, dueDate: '2026-09-07', daysOverdue: 0, status: 'due', interest: 0, interestPaid: 0, lastDeposit: null, lines: 1, ...over,
  });
  it('overdue first (with interest), then due within a week, then an overdue statement; else nothing', () => {
    const over = dueNoticeText({ kind: 'tds', asOf: '2026-09-10', rows: [row({ status: 'overdue', interest: 2400 })], statements: [] });
    assert.equal(over?.tone, 'danger');
    assert.match(over?.text ?? '', /TDS of ₹ ?800\.00 is overdue .* Interest so far ₹ ?24\.00/);
    const soon = dueNoticeText({ kind: 'tcs', asOf: '2026-09-02', rows: [row({ kind: 'tcs' })], statements: [] });
    assert.deepEqual(soon && { tone: soon.tone, ok: /TCS of ₹ ?800\.00 is due by 07-Sep-2026/.test(soon.text) }, { tone: 'warning', ok: true });
    assert.equal(dueNoticeText({ kind: 'tds', asOf: '2026-08-20', rows: [row({})], statements: [] }), null);
    const stmt: TdsStatementRow = { key: 's', form: '26Q', fyStart: 2026, quarter: 1, label: 'Q1 2026-27', dueDate: '2026-07-31', filedOn: null, tokenNo: null, tax: 80000, lines: 1, daysLate: 10, lateFee: 200000, status: 'overdue' };
    assert.match(dueNoticeText({ kind: 'tds', asOf: '2026-08-10', rows: [], statements: [stmt] })?.text ?? '', /Form 26Q for Q1 2026-27 was due on 31-Jul-2026/);
  });
});

describe('tds renderer model: review fixes', () => {
  it('nature choices: kind of the ledger, features on, inactive only while still in use', async () => {
    const { natureOptionsFor } = await import('./model.ts');
    const natures = [
      { id: 1, kind: 'tds' as const, section: '194C', name: 'Contractors', isActive: true },
      { id: 2, kind: 'tds' as const, section: '194H', name: 'Commission', isActive: false },
      { id: 3, kind: 'tcs' as const, section: '206C(1)', name: 'Scrap', isActive: true },
    ];
    const both = { tds: true, tcs: true };
    assert.deepEqual(natureOptionsFor(natures, 'expense', both, [null]).map((o) => o.value), ['1']);
    assert.deepEqual(natureOptionsFor(natures, 'expense', both, [2]).map((o) => o.label), ['194C — Contractors', '194H — Commission (inactive)']);
    assert.deepEqual(natureOptionsFor(natures, 'income', both, [null]).map((o) => o.label), ['TCS 206C(1) — Scrap']);
    assert.deepEqual(natureOptionsFor(natures, 'party', { tds: true, tcs: false }, [null]).map((o) => o.value), ['1']);
  });

  it('a statement can be recorded as filed from the day after the quarter ends', async () => {
    const { earliestFilingDate } = await import('./model.ts');
    assert.equal(earliestFilingDate('2026-06-30'), '2026-07-01');
    assert.equal(earliestFilingDate('2027-03-31'), '2027-04-01');
  });
});

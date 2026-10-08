import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BankSummaryRow, BrsResult, DepositSlip, StatementIssue, StatementMapping } from '../../../../shared/types/banking.ts';
import { brsExport, chequeRegisterExport, depositSlipExport, summaryExport } from './exports.ts';
import {
  assignRole,
  blankDraft,
  columnCaptions,
  draftFromMapping,
  draftProblems,
  groupIssues,
  importResultText,
  previewSummaryText,
  previewWarnings,
  roleOfColumn,
  toMapping,
} from './importMapping.ts';
import { allowedKinds, buildCreateItems, countTabs, defaultKind, ledgerFitsKind, suggestLedger, tabOf, type LedgerOption } from './matchReview.ts';

describe('import mapping editor', () => {
  const hdfc: StatementMapping = {
    preset: 'hdfc',
    headerRow: 0,
    columns: { date: 0, description: 1, reference: 2, valueDate: 3, debit: 4, credit: 5, balance: 6 },
    dateOrder: 'auto',
  };

  it('round-trips a mapping and keeps one role per column', () => {
    const d = draftFromMapping(hdfc);
    assert.equal(roleOfColumn(d, 4), 'debit');
    assert.deepEqual(toMapping(d), { ...hdfc, sheet: null, delimiter: null, amountSign: 'deposit_positive' });
    // Making column 1 the date moves Date off column 0 and the narration role off column 1.
    const moved = assignRole(d, 1, 'date');
    assert.equal(roleOfColumn(moved, 0), null);
    assert.equal(moved.columns.date, 1);
    assert.equal(moved.columns.description, undefined);
    assert.equal(roleOfColumn(assignRole(d, 6, null), 6), null);
  });

  it('Withdrawal/Deposit and a single Amount exclude each other', () => {
    const amount = assignRole(draftFromMapping(hdfc), 4, 'amount');
    assert.deepEqual([amount.columns.amount, amount.columns.debit, amount.columns.credit], [4, undefined, undefined]);
    const withDrCr = assignRole(amount, 5, 'drCr');
    const back = assignRole(withDrCr, 5, 'credit');
    assert.deepEqual([back.columns.credit, back.columns.amount, back.columns.drCr], [5, undefined, undefined]);
  });

  it('reports what is missing in plain words', () => {
    assert.deepEqual(draftProblems(blankDraft(), 4), ['Choose the Date column.', 'Choose the Withdrawal and Deposit columns, or a single Amount column.']);
    const d = assignRole(assignRole(assignRole(blankDraft(), 0, 'date'), 2, 'drCr'), 3, 'balanceDrCr');
    assert.deepEqual(draftProblems(d, 4), [
      'Choose the Withdrawal and Deposit columns, or a single Amount column.',
      'A Dr/Cr column needs the Amount column it belongs to.',
      'A balance Dr/Cr column needs the Balance column.',
    ]);
    assert.match(draftProblems(assignRole(assignRole(blankDraft(), 0, 'date'), 9, 'amount'), 4)[0], /column 10, but the heading row has 4 columns/);
    assert.equal(toMapping(blankDraft()), null);
  });

  it('labels columns from the heading row and groups skipped rows', () => {
    assert.deepEqual(columnCaptions([['Account', ':'], ['Date', '', 'Amount'], ['01/04/2026', 'x', '5']], 1), ['Date', 'Column 2', 'Amount']);
    const issues: StatementIssue[] = [
      { row: 2, level: 'info', reason: 'Separator row', text: '' },
      { row: 9, level: 'info', reason: 'Separator row', text: '' },
      { row: 4, level: 'warning', reason: 'Unreadable date "31/02/2026"', text: '' },
      { row: 7, level: 'warning', reason: 'Unreadable date "xx"', text: '' },
    ];
    assert.deepEqual(groupIssues(issues), [
      { reason: 'Unreadable date', level: 'warning', count: 2, rows: [4, 7] },
      { reason: 'Separator row', level: 'info', count: 2, rows: [2, 9] },
    ]);
  });

  it('summarises preview and import results', () => {
    const summary = {
      lineCount: 42,
      depositCount: 10,
      withdrawalCount: 32,
      totalDeposits: 0,
      totalWithdrawals: 0,
      from: '2026-04-01',
      to: '2026-04-30',
      openingBalance: null,
      closingBalance: null,
      order: 'descending' as const,
      balanceCheck: { checked: 41, mismatches: 3, firstMismatchRow: 12, swappedLikely: false },
      duplicates: 3,
      skippedRows: 5,
    };
    assert.equal(
      previewSummaryText({ summary }, (d) => d ?? ''),
      '42 transactions from 2026-04-01 to 2026-04-30 · 3 lines already imported (will be skipped) · 5 rows skipped · newest-first file read bottom-up',
    );
    assert.match(previewWarnings({ summary, lines: [] })[0], /does not agree on 3 rows \(first at row 12\)/);
    assert.match(previewWarnings({ summary: { ...summary, balanceCheck: { ...summary.balanceCheck, swappedLikely: true } }, lines: [] })[0], /probably swapped/);
    const base = { batchId: 1, from: null, to: null, totalDeposits: 0, totalWithdrawals: 0, closingBalance: null };
    assert.equal(importResultText({ ...base, imported: 40, duplicates: 2, skippedRows: 1 }), 'Imported 40 transactions, skipped 2 duplicates, 1 row was not a transaction.');
    assert.equal(importResultText({ ...base, batchId: null, imported: 0, duplicates: 12, skippedRows: 0 }), 'Nothing new to import — all 12 transactions were imported before.');
  });
});

describe('match review', () => {
  const L = (id: number, name: string, classes: LedgerOption['classes'], groupName = ''): LedgerOption => ({ id, name, groupName, classes });
  const ledgers = [
    L(1, 'HDFC Bank', ['bank', 'cash_bank']),
    L(2, 'Cash', ['cash', 'cash_bank']),
    L(3, 'Bank Charges', ['expense']),
    L(4, 'Interest Received', ['income']),
    L(5, 'Acme Traders', ['party', 'debtor']),
    L(6, 'Office Rent', ['expense']),
    L(7, 'SBI Current A/c', ['bank', 'cash_bank']),
  ];

  it('puts lines on tabs and counts them', () => {
    const lines = [
      { id: 1, status: 'matched' as const },
      { id: 2, status: 'created' as const },
      { id: 3, status: 'unmatched' as const },
      { id: 4, status: 'unmatched' as const },
      { id: 5, status: 'ignored' as const },
    ];
    const sug = new Set([4]);
    assert.equal(tabOf(lines[3], sug), 'suggestions');
    assert.deepEqual(countTabs(lines, sug), { matched: 2, suggestions: 1, unmatched: 1, ignored: 1 });
  });

  it('proposes the voucher kind from the direction and narration', () => {
    assert.equal(defaultKind({ amount: 10000, description: 'NEFT CR ACME' }), 'receipt');
    assert.equal(defaultKind({ amount: -59000, description: 'SMS CHARGES' }), 'payment');
    assert.equal(defaultKind({ amount: -500000, description: 'ATM WDL FORT' }), 'contra');
    assert.equal(defaultKind({ amount: 2000000, description: 'BY CASH DEPOSIT' }), 'contra');
    assert.deepEqual(allowedKinds(-1), ['payment', 'contra']);
  });

  it('filters ledgers by kind and suggests one from the narration (synonyms, no ties)', () => {
    assert.equal(ledgerFitsKind(ledgers[1], 'contra', 1), true);
    assert.equal(ledgerFitsKind(ledgers[0], 'contra', 1), false, 'not the bank itself');
    assert.equal(ledgerFitsKind(ledgers[2], 'contra', 1), false);
    assert.equal(ledgerFitsKind(ledgers[2], 'payment', 1), true);
    assert.equal(suggestLedger({ description: 'SMS CHGS QTR', amount: -590 }, ledgers, 'payment', 1)?.name, 'Bank Charges');
    assert.equal(suggestLedger({ description: 'INT.PD:01-04-2026 TO 30-04-2026', amount: 31250 }, ledgers, 'receipt', 1)?.name, 'Interest Received');
    assert.equal(suggestLedger({ description: 'NEFT CR-HDFC0000001-ACME TRADERS', amount: 100 }, ledgers, 'receipt', 1)?.name, 'Acme Traders');
    assert.equal(suggestLedger({ description: 'TRF TO SBI', amount: -100 }, ledgers, 'contra', 1)?.name, 'SBI Current A/c');
    assert.equal(suggestLedger({ description: 'UPI/9876543210', amount: -100 }, ledgers, 'payment', 1), null);
  });

  it('builds the bulk request and lists lines still missing a ledger', () => {
    const drafts = new Map([
      [10, { kind: 'payment' as const, contraLedgerId: 3, narration: '  ' }],
      [11, { kind: 'receipt' as const, contraLedgerId: null, narration: '' }],
      [12, { kind: 'contra' as const, contraLedgerId: 2, narration: 'Cash withdrawn' }],
    ]);
    assert.deepEqual(buildCreateItems([10, 11, 12, 13], drafts), {
      items: [
        { lineId: 10, kind: 'payment', contraLedgerId: 3 },
        { lineId: 12, kind: 'contra', contraLedgerId: 2, narration: 'Cash withdrawn' },
      ],
      missing: [11, 13],
    });
  });
});

describe('exports', () => {
  it('deposit slip lists cheques then cash with a total', () => {
    const slip: DepositSlip = {
      company: { name: 'Test Traders', gstin: null },
      bank: { id: 1, name: 'HDFC Bank', isOd: false, accountNo: '5010', bankName: 'HDFC Bank', ifsc: 'HDFC0000001', branch: 'Fort', holder: null },
      date: '2026-04-28',
      cheques: [
        { ledgerEntryId: 1, voucherId: 1, voucherType: 'Receipt', number: '1', particulars: 'Acme', instrumentType: 'dd', instrumentNo: '445566', instrumentDate: null, drawnOn: 'Axis', amount: 800000 },
      ],
      cash: { amount: 500000, vouchers: 2 },
      totals: { chequeCount: 1, cheques: 800000, cash: 500000, total: 1300000 },
      amountInWords: 'Rupees Thirteen Thousand Only',
    };
    const d = depositSlipExport(slip);
    assert.deepEqual(d.rows, [
      [1, 'DD 445566', null, 'Axis', 'Acme', 800000],
      [null, 'Cash', null, '', '2 cash deposits', 500000],
    ]);
    assert.deepEqual(d.totals, [null, '', null, '', 'Total', 1300000]);
    assert.match(d.notes ?? '', /Rupees Thirteen Thousand Only\nAccount holder: Test Traders · IFSC HDFC0000001/);
  });

  it('cheque register marks stale cheques and totals the amounts', () => {
    const base = {
      ledgerEntryId: 1,
      voucherId: 1,
      date: '2026-04-20',
      voucherType: 'Payment',
      baseType: 'payment' as const,
      number: '7',
      particulars: 'Office Rent',
      bankLedgerId: 1,
      bankLedgerName: 'HDFC Bank',
      direction: 'issued' as const,
      instrumentType: 'cheque' as const,
      instrumentNo: '000502',
      instrumentDate: null,
      drawnOn: null,
      favouring: null,
      amount: 1500000,
      bankDate: null,
      status: 'uncleared' as const,
      stale: true,
    };
    const d = chequeRegisterExport([base, { ...base, ledgerEntryId: 2, stale: false, status: 'cleared', bankDate: '2026-04-22', amount: 100 }]);
    assert.equal(d.rows[0][11], 'Stale (over 3 months)');
    assert.equal(d.rows[1][11], 'Cleared');
    assert.equal(d.totals?.[9], 1500100);
  });

  it('BRS notes reconcile books to bank and compare the statement on its own date', () => {
    const r: BrsResult = {
      ledger: { id: 1, name: 'HDFC Bank', isOd: false, accountNo: null, bankName: null, ifsc: null, branch: null },
      asOf: '2026-04-30',
      from: '2026-04-01',
      show: 'unreconciled',
      balanceAsPerBooks: 7900000,
      chequesIssuedNotPresented: 1500000,
      chequesDepositedNotCleared: 0,
      clearedBeforeVoucherDate: 0,
      balanceAsPerBank: 9400000,
      statementBalance: 8141000,
      statementDate: '2026-04-24',
      balanceAsPerBankOnStatementDate: 8200000,
      difference: -59000,
      amountsNotInBooks: { count: 1, deposits: 0, withdrawals: 59000 },
      unexplainedDifference: 0,
      counts: { issuedNotPresented: 1, depositedNotCleared: 0, clearedBeforeVoucher: 0, reconciledListed: 0 },
      entries: [],
      truncated: false,
    };
    const notes = (brsExport(r).notes ?? '').split('\n');
    // 79,000 Dr + 15,000 = 94,000 Dr as per bank; on 24-Apr 82,000 Dr vs statement 81,410 → −590 (= 590 Cr), explained.
    assert.deepEqual(notes, [
      'Balance as per company books: 79,000.00 Dr',
      'Add: cheques issued but not presented: 15,000.00',
      'Less: cheques deposited but not cleared: 0.00',
      'Balance as per bank: 94,000.00 Dr',
      'Balance as per bank on 24-Apr-2026 (from the books): 82,000.00 Dr',
      'Imported statement balance on 24-Apr-2026: 81,410.00 Dr',
      'Difference (statement − bank as per books): 590.00 Cr',
      'Statement lines not in the books (1): 590.00 Cr',
      'Unexplained: 0.00',
    ]);
  });

  it('bank overview export carries the statement difference', () => {
    const row: BankSummaryRow = {
      id: 1,
      name: 'HDFC Bank',
      isOd: false,
      accountNo: '5010',
      bankName: 'HDFC Bank',
      ifsc: null,
      branch: null,
      balanceAsPerBooks: 7900000,
      balanceAsPerBank: 8200000,
      unreconciled: { count: 2, depositsCount: 1, deposits: 1200000, issuedCount: 1, issued: 1500000 },
      lastReconciledDate: '2026-04-24',
      lastStatement: { date: '2026-04-30', balance: 8141000, importedAt: '2026-05-01T10:00:00.000Z', difference: -59000 },
      statementLines: { unmatched: 1, matched: 3, created: 0, ignored: 0 },
    };
    const d = summaryExport([row]);
    assert.equal(d.columns.length, d.rows[0].length);
    assert.deepEqual(d.rows[0].slice(7), ['2026-04-30', 8141000, -59000, 1]);
    assert.equal(d.totals?.length, d.columns.length);
  });
});

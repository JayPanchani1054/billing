import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgeingResult, LedgerBillsResult, OutstandingBillRow, PartySummaryResult } from '../../../../shared/types/outstanding.ts';
import {
  ageingExport,
  billsExport,
  bucketText,
  keyBills,
  overdueText,
  overdueTone,
  parseBucketText,
  partiesExport,
  partyTreeRows,
  refTypeLabel,
  summaryKpis,
  utilisationTone,
} from './model.ts';

const bill = (over: Partial<OutstandingBillRow> = {}): OutstandingBillRow => ({
  ledgerId: 1,
  ledgerName: 'Acme Traders',
  groupId: 9,
  groupName: 'Sundry Debtors',
  billWise: true,
  billName: 'INV-1',
  billDate: '2026-04-10',
  dueDate: '2026-05-10',
  creditDays: 30,
  originalAmount: 1_18_000_00,
  pendingAmount: 68_000_00,
  overdueDays: 143,
  refType: 'new',
  voucherId: 7,
  ...over,
});

describe('ageing periods text', () => {
  it('parses commas, spaces and semicolons and round-trips', () => {
    assert.deepEqual(parseBucketText(' 30, 60 ;90  180 '), { ok: true, buckets: [30, 60, 90, 180] });
    assert.equal(bucketText([30, 60, 90, 180]), '30, 60, 90, 180');
  });

  it('explains every mistake the way the server would reject it', () => {
    assert.deepEqual(parseBucketText(''), { ok: false, error: 'Enter the ageing periods in days, e.g. 30, 60, 90, 180' });
    assert.deepEqual(parseBucketText('30, 15'), { ok: false, error: 'Enter the periods in increasing order, e.g. 30, 60, 90, 180' });
    assert.deepEqual(parseBucketText('30, 4.5'), { ok: false, error: '“4.5” is not a whole number of days' });
    assert.deepEqual(parseBucketText('0, 30'), { ok: false, error: 'Each ageing period must be from 1 to 3650 days' });
    assert.deepEqual(parseBucketText(Array.from({ length: 13 }, (_, i) => i + 1).join(',')), { ok: false, error: 'Enter at most 12 ageing periods' });
  });
});

describe('labels and tones', () => {
  it('maps overdue days and credit-limit use to tones', () => {
    assert.deepEqual([0, 1, 60, 61].map(overdueTone), ['neutral', 'warning', 'warning', 'danger']);
    assert.deepEqual([0, 1, 45].map(overdueText), ['', '1 day', '45 days']);
    assert.deepEqual([null, 79.99, 80, 100, 100.01].map(utilisationTone), ['brand', 'brand', 'warning', 'warning', 'danger']);
    assert.equal(refTypeLabel('on_account'), 'On Account');
  });
});

describe('keyBills', () => {
  it('gives every row a unique, stable key even for same-named FIFO slices', () => {
    const rows = keyBills([bill(), bill({ refType: 'fifo', voucherId: null, billName: 'Opening Balance' }), bill({ refType: 'fifo', voucherId: null, billName: 'Opening Balance' })]);
    assert.equal(new Set(rows.map((r) => r.key)).size, 3);
    assert.equal(rows[0].key, '1|new|7|INV-1|2026-04-10');
    assert.equal(rows[2].key, `${rows[1].key}#1`);
  });
});

describe('partyTreeRows', () => {
  it('lists each bill followed by its history lines (level 1) with running pending', () => {
    const r: Pick<LedgerBillsResult, 'bills'> = {
      bills: [
        {
          billName: 'INV-1',
          billDate: '2026-04-10',
          dueDate: '2026-05-10',
          creditDays: 30,
          refType: 'new',
          originalAmount: 1_18_000_00,
          pendingAmount: 68_000_00,
          overdueDays: 143,
          voucherId: 7,
          history: [
            { kind: 'new', voucherId: 7, voucherNumber: 'INV-1', voucherType: 'Sales', baseType: 'sales', date: '2026-04-10', amount: 1_18_000_00, runningPending: 1_18_000_00, narration: null },
            { kind: 'against', voucherId: 9, voucherNumber: 'R-1', voucherType: 'Receipt', baseType: 'receipt', date: '2026-05-05', amount: -50_000_00, runningPending: 68_000_00, narration: null },
          ],
        },
      ],
    };
    const rows = partyTreeRows(r);
    assert.deepEqual(
      rows.map((x) => [x.level, x.isBill, x.label, x.voucherId, x.amount, x.pending]),
      [
        [0, true, 'INV-1', 7, 1_18_000_00, 68_000_00],
        [1, false, 'New ref', 7, 1_18_000_00, 1_18_000_00],
        [1, false, 'Agst ref', 9, -50_000_00, 68_000_00],
      ],
    );
    assert.equal(new Set(rows.map((x) => x.key)).size, 3);
  });
});

describe('exports and KPIs', () => {
  const summary: PartySummaryResult = {
    side: 'receivable',
    asOf: '2026-09-30',
    rows: [
      {
        ledgerId: 1,
        ledgerName: 'Acme Traders',
        groupId: 9,
        groupName: 'Sundry Debtors',
        billWise: true,
        pending: 1_15_000_00,
        billsPending: 1_20_000_00,
        overdue: 80_000_00,
        notDue: 40_000_00,
        advance: 0,
        onAccount: -5_000_00,
        billCount: 2,
        overdueBillCount: 1,
        oldestDueDays: 91,
        creditLimit: 1_00_000_00,
        creditDays: 30,
        utilisationPercent: 115,
        overLimit: true,
        mobile: null,
        email: null,
      },
    ],
    totals: { pending: 1_15_000_00, billsPending: 1_20_000_00, overdue: 80_000_00, notDue: 40_000_00, advance: 0, onAccount: -5_000_00, partyCount: 1, overLimitCount: 1 },
  };

  it('builds the party-wise export with totals', () => {
    const e = partiesExport(summary);
    assert.equal(e.columns[0].header, 'Customer');
    assert.deepEqual(e.rows[0], ['Acme Traders', 'Sundry Debtors', 1_15_000_00, 80_000_00, 40_000_00, 0, -5_000_00, 91, 1_00_000_00, 115]);
    assert.deepEqual(e.totals?.slice(0, 7), ['Total', '', 1_15_000_00, 80_000_00, 40_000_00, 0, -5_000_00]);
    assert.equal(e.rows[0].length, e.columns.length);
  });

  it('builds bill-wise and ageing exports aligned with their columns', () => {
    const b = billsExport({ side: 'payable', asOf: '2026-09-30', rows: [bill()], total: 1, totals: { pending: 68_000_00, overdue: 68_000_00, notDue: 0, advance: 0, onAccount: 0, billCount: 1, overdueCount: 1 } });
    assert.equal(b.columns[2].header, 'Supplier');
    // Payables are shown ledger-signed (Cr −) so the report prints "Cr" rather than a bare minus.
    assert.deepEqual(b.rows[0], ['2026-04-10', 'INV-1', 'Acme Traders', 'Bill', '2026-05-10', 143, -1_18_000_00, -68_000_00]);
    assert.deepEqual(b.columns.slice(-2).map((c) => c.kind), ['drcr', 'drcr']);
    const ag: AgeingResult = {
      side: 'receivable',
      asOf: '2026-09-30',
      basis: 'due_date',
      buckets: [
        { index: 0, label: 'Not due', minDays: null, maxDays: 0 },
        { index: 1, label: '1–30 days', minDays: 1, maxDays: 30 },
        { index: 2, label: '> 30 days', minDays: 31, maxDays: null },
      ],
      rows: [{ ledgerId: 1, ledgerName: 'Acme Traders', groupId: 9, groupName: 'Sundry Debtors', billWise: true, amounts: [1, 2, 3], advance: -1, onAccount: 0, total: 5 }],
      totals: { amounts: [1, 2, 3], advance: -1, onAccount: 0, total: 5 },
    };
    const a = ageingExport(ag);
    assert.deepEqual(a.columns.map((c) => c.header), ['Customer', 'Not due', '1–30 days', '> 30 days', 'Advance', 'On account', 'Total']);
    assert.deepEqual(a.rows[0], ['Acme Traders', 1, 2, 3, -1, 0, 5]);
    assert.deepEqual(a.totals, ['Total', 1, 2, 3, -1, 0, 5]);
  });

  it('summarises the KPI strip', () => {
    const k = summaryKpis(summary);
    assert.deepEqual(
      k.map((x) => [x.id, x.value, x.amount]),
      [
        ['total', 1_15_000_00, true],
        ['overdue', 80_000_00, true],
        ['notDue', 40_000_00, true],
        ['unadjusted', -5_000_00, true],
        ['overLimit', 1, false],
      ],
    );
    assert.equal(k[0].label, 'Total receivable');
    assert.equal(k[1].caption, '67% of bills'); // 80,000 ÷ 1,20,000
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReminderLetter, StatementResult } from '../../../../shared/types/outstanding.ts';
import { buildLettersHtml, buildStatementHtml, pdfName } from './printHtml.ts';

const EVIL = '<script>alert("x")</script> & Sons';

function statement(over: Partial<StatementResult> = {}): StatementResult {
  return {
    company: {
      name: 'Test Traders Pvt Ltd',
      mailingName: null,
      address: '12 MG Road\nFort',
      stateCode: '27',
      stateName: 'Maharashtra',
      pincode: '400001',
      phone: '022-4000 1234',
      mobile: null,
      email: 'accounts@test.example',
      gstin: '27AAPFU0939F1ZV',
      pan: 'AAPFU0939F',
    },
    party: {
      ledgerId: 5,
      name: EVIL,
      mailingName: null,
      address: '45 Industrial Area\nPhase 2',
      stateCode: '29',
      stateName: 'Karnataka',
      pincode: '560001',
      gstin: '29AAPFU0939F1ZT',
      pan: null,
      contactPerson: 'Mr. Rao',
      phone: null,
      mobile: null,
      email: null,
      groupName: 'Sundry Debtors',
      billWise: true,
      creditDays: 30,
      creditLimit: 2_00_000_00,
    },
    from: '2026-05-01',
    to: '2026-07-31',
    generatedOn: '2026-09-30',
    openingBalance: 1_28_000_00,
    transactions: [
      { date: '2026-05-05', voucherId: 2, voucherType: 'Receipt', baseType: 'receipt', voucherNumber: 'R-1', referenceNo: null, particulars: 'Cash', narration: 'Cheque <123>', debit: 0, credit: 60_000_00, balance: 68_000_00 },
      { date: '2026-06-20', voucherId: 3, voucherType: 'Sales', baseType: 'sales', voucherNumber: 'INV-2', referenceNo: null, particulars: 'Sales', narration: null, debit: 23_600_00, credit: 0, balance: 91_600_00 },
    ],
    totals: { debit: 23_600_00, credit: 60_000_00 },
    closingBalance: 91_600_00,
    pendingBills: {
      asOf: '2026-07-31',
      method: 'bill_wise',
      buckets: [
        { index: 0, label: 'Not due', minDays: null, maxDays: 0 },
        { index: 1, label: '1–30 days', minDays: 1, maxDays: 30 },
        { index: 2, label: '> 30 days', minDays: 31, maxDays: null },
      ],
      rows: [
        { billName: 'INV-1', billDate: '2026-04-10', dueDate: '2026-05-10', refType: 'new', pendingAmount: 68_000_00, overdueDays: 82, ageDays: 82, bucketIndex: 2 },
        { billName: 'INV-2', billDate: '2026-06-20', dueDate: '2026-07-20', refType: 'new', pendingAmount: 23_600_00, overdueDays: 11, ageDays: 11, bucketIndex: 1 },
      ],
      bucketTotals: [0, 23_600_00, 68_000_00],
      advance: 0,
      onAccount: 0,
      total: 91_600_00,
    },
    ...over,
  };
}

const letter = (party: string): ReminderLetter => ({
  date: '30-Sep-2026',
  from: ['Test Traders Pvt Ltd', '12 MG Road', 'Maharashtra - 400001'],
  to: ['To,', party, 'Karnataka - 560001'],
  subject: 'Payment reminder: overdue bill — ₹ 11,800.00',
  salutation: 'Dear Sir/Madam,',
  opening: ['We hope this letter finds you well.'],
  table: { columns: ['Bill No.', 'Bill Date', 'Due Date', 'Overdue (days)', 'Amount (₹)'], rows: [['A-1', '10-Sep-2026', '10-Sep-2026', '20', '11,800.00']], total: ['Total overdue', '', '', '', '11,800.00'] },
  closing: ['Thank you for your continued business.'],
  signOff: ['Yours faithfully,', 'For Test Traders Pvt Ltd', '', '', 'Authorised Signatory'],
  text: '',
});

describe('buildStatementHtml', () => {
  it('prints letterhead, party, opening, running balances, closing and aged pending bills', () => {
    const html = buildStatementHtml(statement(), { printedOn: '2026-09-30' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /<div class="company">Test Traders Pvt Ltd<\/div>/);
    assert.match(html, /Maharashtra - 400001/);
    assert.match(html, /GSTIN: 27AAPFU0939F1ZV · PAN: AAPFU0939F/);
    assert.match(html, /<h1>Statement of Account<\/h1>/);
    assert.match(html, /01-May-2026 to 31-Jul-2026/);
    assert.match(html, /Opening Balance<\/td><td><\/td><td><\/td><td class="num"><\/td><td class="num"><\/td><td class="num">1,28,000.00 Dr/);
    assert.match(html, /60,000.00<\/td><td class="num">68,000.00 Dr/);
    assert.match(html, /Closing Balance<\/td><td><\/td><td><\/td><td><\/td><td><\/td><td class="num">91,600.00 Dr/);
    assert.match(html, /<th class="num">1–30 days<\/th>/);
    assert.match(html, /INV-1<\/td><td>10-Apr-2026<\/td><td>10-May-2026<\/td><td class="num">82<\/td><td class="num">68,000.00 Dr/);
    assert.match(html, /Credit period: 30 days/);
    assert.match(html, /Printed on 30-Sep-2026/);
  });

  it('escapes every party-supplied value', () => {
    const html = buildStatementHtml(statement());
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; Sons/);
    assert.match(html, /Cheque &lt;123&gt;/);
  });

  it('says so when there are no transactions or bills', () => {
    const html = buildStatementHtml(statement({ transactions: [], pendingBills: { ...statement().pendingBills, rows: [] } }));
    assert.match(html, /No transactions in this period\./);
    assert.match(html, /No pending bills\./);
  });
});

describe('buildLettersHtml', () => {
  it('prints one page per letter with right-aligned number columns, escaped', () => {
    const html = buildLettersHtml([letter('Acme Traders'), letter(EVIL)], { printedOn: '2026-09-30' });
    assert.equal(html.match(/<section class="letter">/g)?.length, 2);
    assert.match(html, /\.letter \{ break-after: page; \}/);
    assert.match(html, /<title>Payment reminders \(2\)<\/title>/);
    assert.match(html, /<th>Bill No\.<\/th><th>Bill Date<\/th><th>Due Date<\/th><th class="num">Overdue \(days\)<\/th><th class="num">Amount \(₹\)<\/th>/);
    assert.match(html, /<td class="num">11,800.00<\/td>/);
    assert.match(html, /Subject: Payment reminder: overdue bill — ₹ 11,800.00/);
    assert.match(html, /<div class="gap"><\/div>/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('names a single letter after the party', () => {
    assert.match(buildLettersHtml([letter('Acme Traders')]), /<title>Payment reminder — Acme Traders<\/title>/);
  });
});

describe('pdfName', () => {
  it('builds file-safe names', () => {
    assert.equal(pdfName('Statement', 'Acme & Sons / Pune', '2026-04-01', '2026-09-30'), 'Statement-Acme-Sons-Pune_01-04-2026_to_30-09-2026.pdf');
    assert.equal(pdfName('Reminders', null), 'Reminders.pdf');
  });
});

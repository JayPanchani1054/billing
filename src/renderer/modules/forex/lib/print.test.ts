import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrintForex } from '../../../../shared/types/forex.ts';
import type { PrintVoucherData } from '../../../../shared/types/print.ts';
import { forexInvoiceBlock, forexVoucherLines } from './print.ts';

type Doc = Pick<PrintVoucherData, 'layout' | 'lines' | 'charges' | 'totals' | 'forex'>;

const fx = (over: Partial<PrintForex> = {}): PrintForex => ({
  currency: { symbol: '$', isoCode: 'USD', formalName: 'US Dollar', decimalPlaces: 2 },
  rate: 84,
  lines: [{ rate: 125.5, amount: 502 }],
  charges: [],
  tax: 90.36,
  total: 592.36,
  totalInWords: 'US Dollar Five Hundred Ninety Two and 36/100 Only',
  note: 'Amounts in USD. Rupee equivalents at ₹84.00 per USD; GST is computed and payable in rupees.',
  entries: [],
  ...over,
});

// The export invoice of src/core/modules/forex/print.test.ts: 4 × $125.50 = $502.00 at ₹84 = ₹42,168.00;
// IGST 18% ₹7,590.24 → ₹49,758.24; in dollars 502 + 90.36 = $592.36.
const doc = (over: Partial<Doc> = {}): Doc =>
  ({
    layout: 'invoice',
    lines: [{ name: 'Granite Slab', amount: 4_216_800 }],
    charges: [],
    totals: { taxable: 4_216_800, tax: 759_024, charges: 0, roundOff: 0, grandTotal: 4_975_824 },
    forex: fx(),
    ...over,
  }) as unknown as Doc;

test('export invoice: lines, GST and total in both currencies; the columns add up', () => {
  const b = forexInvoiceBlock(doc());
  assert.ok(b);
  assert.equal(b.code, 'USD');
  assert.equal(b.title, 'Amounts in US Dollar (USD) @ ₹84.00 per USD');
  assert.deepEqual(
    b.rows.map((r) => [r.kind, r.label, r.rate, r.foreign, r.rupees]),
    [
      ['line', 'Granite Slab', '125.50', '502.00', '42,168.00'],
      ['tax', 'GST (computed and payable in rupees)', '', '90.36', '7,590.24'],
      ['total', 'Total', '', '592.36', '49,758.24'],
    ],
  );
  assert.equal(b.words, 'US Dollar Five Hundred Ninety Two and 36/100 Only');
});

test('export under LUT (no GST): no tax row; a charge gets its own row', () => {
  // $500 + freight $20 at ₹84 = ₹42,000 + ₹1,680 = ₹43,680.
  const b = forexInvoiceBlock(
    doc({
      lines: [{ name: 'Granite Slab', amount: 4_200_000 }] as PrintVoucherData['lines'],
      charges: [{ name: 'Freight', amount: 168_000 }],
      totals: { taxable: 4_200_000, tax: 0, charges: 168_000, roundOff: 0, grandTotal: 4_368_000 } as PrintVoucherData['totals'],
      forex: fx({ lines: [{ rate: 125, amount: 500 }], charges: [20], tax: 0, total: 520 }),
    }),
  );
  assert.deepEqual(
    b?.rows.map((r) => [r.kind, r.foreign, r.rupees]),
    [
      ['line', '500.00', '42,000.00'],
      ['charge', '20.00', '1,680.00'],
      ['total', '520.00', '43,680.00'],
    ],
  );
});

test('no block for rupee documents, misaligned data or the voucher layout', () => {
  assert.equal(forexInvoiceBlock(doc({ forex: null })), null);
  assert.equal(forexInvoiceBlock(doc({ forex: fx({ lines: [] }) })), null, 'lines must align with the print lines');
  assert.equal(forexInvoiceBlock(doc({ layout: 'voucher' })), null);
  assert.deepEqual(forexVoucherLines(doc()), [], 'an invoice prints the table, not voucher lines');
});

test('receipt in a currency: one line per foreign entry', () => {
  const d = doc({ layout: 'voucher', forex: fx({ rate: null, total: null, lines: [], entries: [{ ledgerName: 'Pacific Retail LLC', forexAmount: -1000, rate: 84.5, text: '$ 1,000.00 @ ₹84.50' }] }) });
  assert.deepEqual(forexVoucherLines(d), ['Pacific Retail LLC: $ 1,000.00 @ ₹84.50']);
  assert.equal(forexInvoiceBlock(d), null);
});

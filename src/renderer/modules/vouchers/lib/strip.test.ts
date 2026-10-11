import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PendingBill } from '../../../../shared/types/vouchers.ts';
import { formReducer, newForm } from './formState.ts';
import type { VoucherForm } from './formState.ts';
import { taxBreakup } from './masters.ts';
import { acceptMessage, NO_LINES_NOTE, overdueOf, partyLine, stripAmount, stripNotes, stripSum, stripTooltip, totalsStrip } from './strip.ts';
import { computeInvoiceTotals } from './totals.ts';
import type { ClientItemInfo, ClientLedgerTax, TotalsEnv } from './totals.ts';

// Fixtures as in totals.test.ts: rice 5 %, soap 18 %, GST freight, a non-GST TCS line after tax.
const RICE: ClientItemInfo = { id: 1, isService: false, unitSymbol: 'KGS', gst: { rate: 5, cessRate: 0, cessPerUnit: 0, taxability: 'taxable', hsnSac: '1006' } };
const SOAP: ClientItemInfo = { id: 2, isService: false, unitSymbol: 'NOS', gst: { rate: 18, cessRate: 0, cessPerUnit: 0, taxability: 'taxable', hsnSac: '3401' } };
const PAN_MASALA: ClientItemInfo = { id: 4, isService: false, unitSymbol: 'NOS', gst: { rate: 28, cessRate: 12, cessPerUnit: 0, taxability: 'taxable', hsnSac: '2106' } };
const ledger = (over: Partial<ClientLedgerTax> = {}): ClientLedgerTax => ({
  isSales: false,
  isPurchase: false,
  plAccount: true,
  gstApplicable: false,
  taxability: null,
  rate: null,
  cessRate: null,
  hsnSac: null,
  supplyType: null,
  isReverseCharge: false,
  includeInAssessable: null,
  appropriateBy: null,
  history: [],
  ...over,
});
const LEDGERS = new Map<number, ClientLedgerTax>([
  [10, ledger({ isSales: true, gstApplicable: true, taxability: 'taxable' })],
  [11, ledger({ isPurchase: true, gstApplicable: true, taxability: 'taxable' })],
  [20, ledger({ gstApplicable: true, taxability: 'taxable', rate: 18, hsnSac: '996511', supplyType: 'services' })],
  [30, ledger({ plAccount: false })],
]);
const env = (over: Partial<TotalsEnv> = {}): TotalsEnv => ({
  direction: 'outward',
  gstOn: true,
  companyStateCode: '27',
  companyRegistration: 'regular',
  party: { registrationType: 'regular', stateCode: '27', gstin: '27AAPFU0939F1ZV' },
  roundOff: { enabled: true, method: 'nearest', unit: 100 },
  items: new Map([
    [1, RICE],
    [2, SOAP],
    [4, PAN_MASALA],
  ]),
  ledgerTax: (id) => LEDGERS.get(id),
  defaultLedgerId: 10,
  ...over,
});

function salesForm(extra = true): VoucherForm {
  let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
  f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 1, qty: 10, rate: 50 } });
  f = formReducer(f, { type: 'item', key: f.items[1].key, patch: { itemId: 2, qty: 3, rate: 118.5, discountPct: 10 } });
  if (!extra) return f;
  f = formReducer(f, { type: 'ledger', key: f.ledgers[0].key, patch: { ledgerId: 20, amount: 10000 } });
  f = formReducer(f, { type: 'ledger', key: f.ledgers[1].key, patch: { ledgerId: 30, amount: 100 } });
  return f;
}

const stripOf = (f: VoucherForm, e: TotalsEnv) => {
  const t = computeInvoiceTotals(f, e);
  return { t, s: totalsStrip({ taxable: t.taxable, tax: taxBreakup(t.computation, '27'), outside: t.outside, roundOff: t.roundOff, grandTotal: t.grandTotal }) };
};

describe('totals strip (D13): Taxable · tax heads by name · Round off · Total = grandTotal', () => {
  it('intra-state: CGST and SGST summed over the rates, other charges, round off — the items add up to the Total', () => {
    const { t, s } = stripOf(salesForm(), env());
    assert.deepEqual(
      s.items.map((i) => [i.label, i.amount]),
      [
        ['Taxable', 91995],
        ['CGST', 1250 + 3780],
        ['SGST', 1250 + 3780],
        ['Other charges', 100],
        ['Round off', 45],
      ],
    );
    assert.equal(s.total, t.grandTotal);
    assert.equal(s.total, 102200);
    assert.equal(stripSum(s), s.total, 'drawn items = Total');
  });

  it('inter-state: IGST only; no round-off item when it is zero', () => {
    const { t, s } = stripOf(salesForm(false), env({ party: { registrationType: 'regular', stateCode: '29', gstin: '29AAPFU0939F1ZQ' }, roundOff: { enabled: false, method: 'nearest', unit: 100 } }));
    assert.deepEqual(
      s.items.map((i) => i.label),
      ['Taxable', 'IGST'],
    );
    assert.equal(s.total, t.grandTotal);
    assert.equal(stripSum(s), s.total);
  });

  it('cess comes after the GST heads; a union territory without legislature says UTGST', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 4, qty: 2, rate: 1000 } });
    const t = computeInvoiceTotals(f, env());
    const s = totalsStrip({ taxable: t.taxable, tax: taxBreakup(t.computation, '27'), outside: t.outside, roundOff: t.roundOff, grandTotal: t.grandTotal });
    assert.deepEqual(
      s.items.map((i) => i.label),
      ['Taxable', 'CGST', 'SGST', 'Cess'],
    );
    assert.equal(stripSum(s), t.grandTotal);
    const ut = totalsStrip({
      taxable: 1000,
      tax: [
        { key: 'cgst:18', label: 'CGST @ 9%', amount: 90 },
        { key: 'sgst:18', label: 'UTGST @ 9%', amount: 90 },
      ],
      outside: 0,
      roundOff: 0,
      grandTotal: 1180,
    });
    assert.deepEqual(
      ut.items.map((i) => i.label),
      ['Taxable', 'CGST', 'UTGST'],
    );
  });

  it('reverse-charge tax is one muted item outside the total', () => {
    const s = totalsStrip({
      taxable: 10000,
      tax: [
        { key: 'rc:cgst:18', label: 'CGST @ 9% (reverse charge)', amount: 900 },
        { key: 'rc:sgst:18', label: 'SGST @ 9% (reverse charge)', amount: 900 },
      ],
      outside: 0,
      roundOff: 0,
      grandTotal: 10000,
    });
    assert.deepEqual(s.items.at(-1), { key: 'rc', label: 'Reverse charge tax', amount: 1800, muted: true });
    assert.equal(stripSum(s), 10000);
  });

  it('an empty invoice: Taxable 0 and Total 0; deductions read "(−)"', () => {
    const f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
    const { t, s } = stripOf(f, env());
    // The note the strip holds back until a save attempt is the GST engine's own words (a rename would show it again).
    assert.ok(t.warnings.includes(NO_LINES_NOTE), `the engine says "${NO_LINES_NOTE}": ${JSON.stringify(t.warnings)}`);
    assert.deepEqual(s.items, [{ key: 'taxable', label: 'Taxable', amount: 0 }]);
    assert.equal(s.total, 0);
    assert.equal(totalsStrip({ taxable: 500, tax: [], outside: 0, roundOff: 0, grandTotal: 500, gst: false }).items[0].label, 'Value', 'no GST: no "Taxable"');
    assert.equal(stripAmount(-1000), '(−) 10.00');
    assert.equal(stripAmount(272140), '2,721.40');
  });
});

describe('what moved off the strip', () => {
  it('the Total tooltip: supply kind, GSTR-1 table and the amount in words', () => {
    assert.equal(stripTooltip({ gst: { interState: false, nature: 'b2cs', reverseCharge: false }, total: 2714000, words: true }), 'Intra-state · GSTR-1: B2C small\nRupees Twenty Seven Thousand One Hundred Forty Only');
    assert.equal(stripTooltip({ gst: { interState: true, nature: 'b2b', reverseCharge: true }, total: 0, words: true }), 'Inter-state · GSTR-1: B2B · Reverse charge');
    assert.equal(stripTooltip({ gst: null, total: 100, words: false }), '');
  });

  it('"Invoice has no lines" only after a save attempt; the server figure when it differs', () => {
    assert.deepEqual(stripNotes({ warnings: [NO_LINES_NOTE], saveAttempted: false, serverTotal: null, total: 0 }), []);
    assert.deepEqual(stripNotes({ warnings: [NO_LINES_NOTE], saveAttempted: true, serverTotal: null, total: 0 }), [NO_LINES_NOTE]);
    assert.deepEqual(stripNotes({ warnings: [], saveAttempted: false, serverTotal: 1000, total: 1000 }), []);
    assert.deepEqual(stripNotes({ warnings: ['Other note'], saveAttempted: false, serverTotal: 118000, total: 117900 }), ['Other note', 'The books will record ₹ 1,180.00 (checked with the saved masters).']);
  });
});

const bill = (over: Partial<PendingBill>): PendingBill => ({ billName: 'INV-1', billDate: '2026-04-01', dueDate: null, amount: 0, originalAmount: 0, source: 'voucher', voucherId: 1, ...over });

describe('party line (D15)', () => {
  const party = { balance: 5435600, creditLimit: null, gstin: '27AAPFU0939F1ZV', pendingBills: [] as PendingBill[] };

  it('the balance always; overdue (with the oldest overdue bill age) only when > 0', () => {
    assert.deepEqual(partyLine({ baseType: 'sales', date: '2026-10-10', side: 'dr', party, voucherEffect: 0 }), [{ key: 'balance', text: 'Cur bal 54,356.00 Dr' }]);
    const bills = [
      bill({ billName: 'A', dueDate: '2026-04-03', amount: 1000000 }),
      bill({ billName: 'B', dueDate: '2026-09-30', amount: 464400 }),
      bill({ billName: 'C', dueDate: '2026-11-30', amount: 99900 }), // not due yet
      bill({ billName: 'D', dueDate: '2026-04-01', amount: -50000 }), // an advance, not overdue
    ];
    assert.deepEqual(overdueOf(bills, '2026-10-10', 'dr'), { amount: 1464400, days: 190 });
    assert.deepEqual(partyLine({ baseType: 'sales', date: '2026-10-10', side: 'dr', party: { ...party, pendingBills: bills }, voucherEffect: 0 })[1], {
      key: 'overdue',
      text: 'Overdue 14,644.00 (190 d)',
      danger: true,
    });
    // A supplier: the payable (Cr) bills are the overdue ones.
    assert.deepEqual(overdueOf(bills, '2026-10-10', 'cr'), { amount: 50000, days: 192 });
  });

  it('"Limit exceeded" only when this voucher would cross the credit limit; a zero balance reads 0.00', () => {
    const p = { ...party, balance: 0, creditLimit: 1000000 };
    assert.deepEqual(
      partyLine({ baseType: 'sales', date: '2026-10-10', side: 'dr', party: p, voucherEffect: 900000 }).map((s) => s.text),
      ['Cur bal 0.00'],
    );
    assert.deepEqual(
      partyLine({ baseType: 'sales', date: '2026-10-10', side: 'dr', party: p, voucherEffect: 1000100 }).map((s) => s.text),
      ['Cur bal 0.00', 'Limit exceeded'],
    );
  });

  it('a purchase from a supplier without GSTIN says "Unregistered"; receipts show the balance only', () => {
    const p = { ...party, balance: -120000, gstin: null, pendingBills: [bill({ dueDate: '2026-01-01', amount: -120000 })] };
    assert.deepEqual(
      partyLine({ baseType: 'purchase', date: '2026-10-10', side: 'cr', party: p, voucherEffect: -5000 }).map((s) => s.key),
      ['balance', 'overdue', 'unregistered'],
    );
    assert.deepEqual(
      partyLine({ baseType: 'sales', date: '2026-10-10', side: 'dr', party: { ...p, balance: 0 }, voucherEffect: 0 }).map((s) => s.key),
      ['balance'],
      'a sale never says Unregistered',
    );
    assert.deepEqual(
      partyLine({ baseType: 'receipt', date: '2026-10-10', side: 'dr', party: p, voucherEffect: 0 }).map((s) => s.text),
      ['Cur bal 1,200.00 Cr'],
    );
  });
});

describe('Accept? reads the amount back (D19)', () => {
  it('an invoice: figures, words and the party', () => {
    assert.equal(
      acceptMessage({ typeName: 'Sales', kind: 'invoice', total: 2714000, partyName: 'Asha Retail' }),
      'Sales for ₹ 27,140.00 (Rupees Twenty Seven Thousand One Hundred Forty Only) to Asha Retail.',
    );
    assert.equal(acceptMessage({ typeName: 'Sales', kind: 'invoice', total: 0 }), 'Sales for ₹ 0.00.');
    assert.equal(acceptMessage({ typeName: 'Sales', kind: 'invoice', total: 1, totalText: '$ 2,000.00', partyName: 'Acme Inc.' }), 'Sales for $ 2,000.00 to Acme Inc.');
  });

  it('(V6) a purchase reads "from" the supplier, never "to"', () => {
    assert.equal(
      acceptMessage({ typeName: 'Purchase', kind: 'invoice', total: 5000000, partyName: 'Patel Paints', fromParty: true }),
      'Purchase for ₹ 50,000.00 (Rupees Fifty Thousand Only) from Patel Paints.',
    );
    // A debit note goes to the supplier: "to" stays.
    assert.equal(acceptMessage({ typeName: 'Debit Note', kind: 'invoice', total: 100000, partyName: 'Patel Paints' }), 'Debit Note for ₹ 1,000.00 (Rupees One Thousand Only) to Patel Paints.');
  });

  it('a ledger voucher: Dr = Cr and the words once balanced; a stock document: its line count', () => {
    assert.equal(acceptMessage({ typeName: 'Receipt', kind: 'ledger', total: 0, debit: 5000000, credit: 0 }), 'Receipt: Dr ₹ 50,000.00 = Cr ₹ 50,000.00 (Rupees Fifty Thousand Only).');
    assert.equal(acceptMessage({ typeName: 'Journal', kind: 'ledger', total: 0, debit: 2500000, credit: 2450000 }), 'Journal: Dr ₹ 25,000.00 = Cr ₹ 24,500.00.');
    assert.equal(acceptMessage({ typeName: 'Delivery Note', kind: 'stock', total: 0, itemLines: 3 }), 'Delivery Note with 3 item line(s).');
  });
});

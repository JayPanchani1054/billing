import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeInvoice } from '../../../../shared/gst/index.ts';
import type { InvoiceContext } from '../../../../shared/gst/index.ts';
import type { LedgerDetail } from '../../../../shared/types/accounts.ts';
import type { ItemPickerRow } from '../../../../shared/types/inventory.ts';
import type { TrackingDoc } from '../../../../shared/types/vouchers.ts';
import { defaultItemRate, ledgerAllowed, priceSide, rowsFromTrackingDoc, taxBreakup, toClientLedgerTax } from './masters.ts';
import { voucherGotoItems, voucherMenuEntries } from './menu.ts';

const item = (over: Partial<ItemPickerRow> = {}): ItemPickerRow => ({
  id: 1,
  name: 'Basmati Rice',
  alias: null,
  partNo: null,
  barcode: null,
  unitSymbol: 'KGS',
  unitDecimals: 2,
  altUnit: null,
  groupName: 'Grains',
  gst: { rate: 5, cessRate: 0, cessPerUnit: 0, taxability: 'taxable', hsnSac: '1006' },
  sellingPrice: 9000,
  purchasePrice: 7550,
  mrp: null,
  priceLevel: null,
  stockQty: 100,
  isService: false,
  maintainBatches: false,
  ...over,
});

describe('ledger slots', () => {
  it('invoice lines refuse parties and cash/bank; contra lines are cash/bank only', () => {
    assert.equal(ledgerAllowed('invoiceLine', 'sales', ['income']), true);
    assert.equal(ledgerAllowed('invoiceLine', 'sales', ['sales', 'income']), true);
    assert.equal(ledgerAllowed('invoiceLine', 'sales', ['party', 'debtor']), false);
    assert.equal(ledgerAllowed('invoiceLine', 'purchase', ['cash', 'cash_bank']), false);
    assert.equal(ledgerAllowed('particular', 'contra', ['bank', 'cash_bank']), true);
    assert.equal(ledgerAllowed('particular', 'contra', ['expense']), false);
    assert.equal(ledgerAllowed('particular', 'journal', ['cash', 'cash_bank']), false);
    assert.equal(ledgerAllowed('particular', 'payment', ['cash', 'cash_bank']), true);
    assert.equal(ledgerAllowed('account', 'receipt', ['bank', 'cash_bank']), true);
  });

  it('party: a sale may be to Cash; a Credit Note is never issued to a supplier', () => {
    assert.equal(ledgerAllowed('party', 'sales', ['cash', 'cash_bank']), true);
    assert.equal(ledgerAllowed('party', 'sales', ['party', 'creditor']), true);
    assert.equal(ledgerAllowed('party', 'credit_note', ['party', 'creditor']), false);
    assert.equal(ledgerAllowed('party', 'credit_note', ['party', 'debtor']), true);
    assert.equal(ledgerAllowed('party', 'sales', ['expense']), false);
  });

  it('item ledgers follow the GST direction', () => {
    assert.equal(ledgerAllowed('itemLedger', 'sales', ['sales', 'income'], 'outward'), true);
    assert.equal(ledgerAllowed('itemLedger', 'purchase', ['sales', 'income'], 'inward'), false);
    assert.equal(ledgerAllowed('itemLedger', 'purchase', ['purchase', 'expense'], 'inward'), true);
  });
});

describe('ledger GST profile for live totals', () => {
  it('maps the ledger master (classes, fixed assets, history)', () => {
    const d = {
      classes: ['expense'],
      primaryGroupCode: 'INDIRECT_EXPENSES',
      gstApplicable: true,
      gstTaxability: 'taxable',
      gstRate: 18,
      cessRate: 0,
      hsnSac: '996511',
      gstSupplyType: 'services',
      isReverseCharge: false,
      includeInAssessable: 'goods',
      appropriateBy: 'value',
      gstRateHistory: [{ id: 1, applicableFrom: '2025-04-01', hsnSac: '996511', taxability: 'taxable', rate: 12, cessRate: 0, cessPerUnit: 0 }],
    } as unknown as LedgerDetail;
    const t = toClientLedgerTax(d);
    assert.equal(t.plAccount, true);
    assert.equal(t.isSales, false);
    assert.equal(t.includeInAssessable, 'goods');
    assert.deepEqual(t.history, [{ applicableFrom: '2025-04-01', hsnSac: '996511', taxability: 'taxable', rate: 12, cessRate: 0 }]);
    const fa = toClientLedgerTax({ ...d, classes: ['asset'], primaryGroupCode: 'FIXED_ASSETS' } as LedgerDetail);
    assert.equal(fa.plAccount, true);
    const loan = toClientLedgerTax({ ...d, classes: ['liability'], primaryGroupCode: 'LOANS_LIABILITY' } as LedgerDetail);
    assert.equal(loan.plAccount, false);
  });
});

describe('item defaults', () => {
  it('price level slab, else selling / purchase price (paise → rupees)', () => {
    assert.deepEqual(defaultItemRate(item(), 'sales'), { rate: 90, discountPct: null });
    assert.deepEqual(defaultItemRate(item(), 'purchase'), { rate: 75.5, discountPct: null });
    assert.deepEqual(defaultItemRate(item({ priceLevel: { rate: 85, discountPct: 2 } }), 'sales'), { rate: 85, discountPct: 2 });
    // Price lists are for sales: purchase ignores them.
    assert.deepEqual(defaultItemRate(item({ priceLevel: { rate: 85, discountPct: 2 } }), 'purchase'), { rate: 75.5, discountPct: null });
    assert.equal(defaultItemRate(item({ sellingPrice: null }), 'sales'), null);
  });

  it('price side follows the direction', () => {
    assert.equal(priceSide('sales', 'outward'), 'sales');
    assert.equal(priceSide('debit_note', 'outward'), 'sales');
    assert.equal(priceSide('purchase', 'inward'), 'purchase');
    assert.equal(priceSide('stock_journal', 'outward'), 'purchase');
  });

  it('tracking documents fill only pending quantities, into trackingRef (notes) or orderRef (orders)', () => {
    const doc: TrackingDoc = {
      voucherId: 9,
      voucherTypeName: 'Delivery Note',
      number: 'DN/7',
      date: '2026-10-01',
      ref: 'DN/7',
      lines: [
        { itemId: 1, itemName: 'Rice', unit: 'KGS', godownId: 2, batchName: null, qty: 10, pendingQty: 4, rate: 90, discountPct: 0, ledgerId: 5 },
        { itemId: 2, itemName: 'Soap', unit: 'NOS', godownId: null, batchName: 'B1', qty: 5, pendingQty: 0, rate: 30, discountPct: 5, ledgerId: null },
      ],
    };
    assert.deepEqual(rowsFromTrackingDoc(doc, 'delivery'), [
      { itemId: 1, godownId: 2, batchName: '', qty: 4, rate: 90, discountPct: null, ledgerId: 5, trackingRef: 'DN/7', orderRef: '' },
    ]);
    assert.equal(rowsFromTrackingDoc(doc, 'sales_order')[0].orderRef, 'DN/7');
    assert.equal(rowsFromTrackingDoc(doc, 'sales_order')[0].trackingRef, '');
  });
});

describe('tax breakup', () => {
  const ctx = (party: string): InvoiceContext => ({
    direction: 'outward',
    invoiceDate: '2026-10-05',
    companyStateCode: '27',
    companyRegistration: 'regular',
    partyRegistration: 'regular',
    partyStateCode: party,
    partyGstin: null,
    roundOff: { enabled: false, method: 'nearest', unit: 100 },
  });
  const lines = [
    { key: 'a', kind: 'item' as const, qty: 10, rate: 100, taxability: 'taxable' as const, gstRate: 18, hsnSac: '3401', supplyKind: 'goods' as const },
    { key: 'b', kind: 'item' as const, qty: 4, rate: 250, taxability: 'taxable' as const, gstRate: 5, hsnSac: '1006', supplyKind: 'goods' as const },
  ];

  it('intra-state: CGST + SGST per rate, halves of the slab', () => {
    // Line a: 10 × ₹100 = ₹1,000 @ 18% → CGST ₹90 + SGST ₹90. Line b: 4 × ₹250 = ₹1,000 @ 5% → ₹25 + ₹25.
    const rows = taxBreakup(computeInvoice(lines, ctx('27')), '27');
    assert.deepEqual(
      rows.map((r) => [r.label, r.amount]),
      // Buckets come in ascending rate order.
      [
        ['CGST @ 2.5%', 2500],
        ['SGST @ 2.5%', 2500],
        ['CGST @ 9%', 9000],
        ['SGST @ 9%', 9000],
      ],
    );
  });

  it('inter-state: IGST at the full rate', () => {
    // ₹1,000 @ 18% = ₹180; ₹1,000 @ 5% = ₹50.
    const rows = taxBreakup(computeInvoice(lines, ctx('29')), '27');
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.amount]));
    assert.deepEqual(byLabel, { 'IGST @ 18%': 18000, 'IGST @ 5%': 5000 });
  });

  it('union territory without legislature: UTGST', () => {
    const rows = taxBreakup(computeInvoice(lines, { ...ctx('04'), companyStateCode: '04' }), '04');
    assert.ok(rows.some((r) => r.label === 'UTGST @ 9%' && r.amount === 9000));
    assert.equal(taxBreakup(null, '27').length, 0);
  });
});

describe('menu and Go To', () => {
  it('lists voucher types with hotkeys and feature requirements', () => {
    const m = voucherMenuEntries({ sales_order: 'orderProcessing', rejection_in: 'rejectionNotes', stock_journal: 'inventory' });
    const sales = m.find((e) => e.baseType === 'sales');
    assert.equal(sales?.hotkey, 'F8');
    assert.equal(sales?.label, 'Sales');
    assert.equal(m.find((e) => e.baseType === 'sales_order')?.feature, 'orderProcessing');
    assert.equal(m.find((e) => e.baseType === 'payment')?.feature, undefined);
    assert.ok(m.findIndex((e) => e.baseType === 'sales') < m.findIndex((e) => e.baseType === 'purchase'));
  });

  it('voucher Go To items open alteration, cancelled ones the view', () => {
    const base = {
      id: 7,
      date: '2026-10-05',
      number: 'S/12',
      voucherTypeId: 1,
      voucherTypeName: 'Sales',
      baseType: 'sales' as const,
      partyLedgerId: 3,
      partyName: 'Sharma & Sons',
      narration: null,
      amount: 118000,
      taxable: 100000,
      tax: 18000,
      referenceNo: null,
      gstNature: null,
      isOptional: false,
      isCancelled: false,
      isPostDated: false,
      irnStatus: null,
    };
    const [a, b] = voucherGotoItems([base, { ...base, id: 8, isCancelled: true }]);
    assert.equal(a.label, 'Sales S/12');
    assert.equal(a.screen, 'vouchers.entry');
    assert.equal(a.description, '05-Oct-2026 · Sharma & Sons · ₹ 1,180.00');
    assert.equal(b.screen, 'vouchers.view');
    assert.match(b.description, /Cancelled/);
  });
});

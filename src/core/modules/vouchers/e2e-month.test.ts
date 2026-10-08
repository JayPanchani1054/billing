/**
 * End-to-end: one realistic month (April 2026) of a Maharashtra (27) trader, posted through the real
 * vouchers service, then checked the way an auditor would:
 *   - every voucher's entries sum to 0 and the trial balance (openings + books) sums to 0;
 *   - every ledger's closing balance equals a hand-computed figure;
 *   - Output / Input / RCM tax ledgers equal the gst_lines totals per head and direction;
 *   - each party's pending bills add up to its ledger balance;
 *   - each item's stock equals opening ± movements (delivery note billed once, never twice);
 *   - optional, cancelled and post-dated vouchers stay out of the books until they should count.
 *
 * Amounts are paise. Arithmetic is shown next to each voucher.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { pendingBills } from './bills.ts';
import { getVoucher, trackingRefs } from './queries.ts';
import { cancelVoucher, deleteVoucher, previewVoucher, saveVoucher, setVoucherOptional } from './service.ts';

const MONTH_END = '2026-04-30';

interface World {
  t: TestCompany;
  vt: TestCompany['ids']['voucherTypes'];
  L: Record<string, number>;
  I: Record<string, number>;
  /** Voucher ids by short name. */
  V: Record<string, VoucherSaveResult>;
}

/** Save and require exactly these warning codes (none by default): no silent false positives. */
function post(w: World, name: string, input: VoucherInput, expectWarnings: string[] = []): VoucherSaveResult {
  const p = previewVoucher(w.t.ctx, input);
  assert.deepEqual(p.warnings.map((x) => x.code).sort(), [...expectWarnings].sort(), `${name}: warnings ${JSON.stringify(p.warnings)}`);
  assert.equal(p.entries.reduce((a, e) => a + e.amount, 0), 0, `${name}: preview Σ = 0`);
  const res = saveVoucher(w.t.ctx, { ...input, acknowledgeWarnings: expectWarnings.length > 0 });
  assert.deepEqual(res.totals, p.totals, `${name}: preview totals = saved totals`);
  w.V[name] = res;
  return res;
}

function entries(w: World, id: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of w.t.db.all<{ name: string; amount: number }>(
    'SELECT l.name, le.amount FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE le.voucher_id = :id ORDER BY le.line_no',
    { id },
  )) {
    out[r.name] = (out[r.name] ?? 0) + r.amount;
  }
  return out;
}

/** Opening balance + book entries up to `asOf` (books filter as of `today`). */
function balance(w: World, ledgerId: number, asOf = MONTH_END, today = w.t.today): number {
  const opening = w.t.db.value<number>('SELECT opening_balance FROM ledgers WHERE id = :id', { id: ledgerId }) ?? 0;
  const moved =
    w.t.db.value<number>(
      `SELECT COALESCE(SUM(le.amount), 0) FROM ledger_entries le WHERE le.ledger_id = :id AND le.date <= :asOf AND ${BOOKS_FILTER('le')}`,
      { id: ledgerId, asOf, today },
    ) ?? 0;
  return opening + moved;
}

function stock(w: World, itemId: number, today = w.t.today): number {
  const opening = w.t.db.value<number>('SELECT COALESCE(SUM(qty), 0) FROM stock_openings WHERE item_id = :id', { id: itemId }) ?? 0;
  const moved =
    w.t.db.value<number>(
      `SELECT COALESCE(SUM(qty), 0) FROM inventory_entries
        WHERE item_id = :id AND affects_stock = 1 AND (is_post_dated = 0 OR date <= :today)`,
      { id: itemId, today },
    ) ?? 0;
  return opening + moved;
}

/** Σ of a gst_lines head over books vouchers, signed by direction (credit/debit notes reduce). */
function gstHead(w: World, head: 'igst' | 'cgst' | 'sgst', where: string): number {
  return (
    w.t.db.value<number>(
      `SELECT COALESCE(SUM(CASE WHEN v.base_type IN ('credit_note', 'debit_note') THEN -g.${head} ELSE g.${head} END), 0)
         FROM gst_lines g JOIN vouchers v ON v.id = g.voucher_id
        WHERE ${BOOKS_FILTER('g')} AND ${where}`,
      { today: w.t.today },
    ) ?? 0
  );
}

/**
 * Invariants that must hold after any sequence of saves, alters, cancels and deletes:
 * Σ = 0 per voucher and in the trial balance; Output/Input/RCM ledgers = gst_lines per head; every
 * party's pending bills = its ledger balance; child rows carry the voucher's date and flags.
 */
function assertInvariants(w: World): void {
  const { t, L } = w;
  assert.deepEqual(t.db.all('SELECT voucher_id FROM ledger_entries GROUP BY voucher_id HAVING SUM(amount) <> 0'), [], 'every voucher Σ = 0');
  const openings = t.db.value<number>('SELECT COALESCE(SUM(opening_balance), 0) FROM ledgers') ?? 0;
  const books = t.db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE ${BOOKS_FILTER()}`, { today: t.today }) ?? 0;
  assert.equal(openings + books, 0, 'trial balance Σ = 0');
  const outward = `v.base_type IN ('sales', 'credit_note') AND g.is_reverse_charge = 0`;
  const inward = `v.base_type IN ('purchase', 'debit_note') AND COALESCE(g.itc_eligibility, '') <> 'ineligible' AND v.gst_nature <> 'import_goods'`;
  for (const [head, out, inp, rcm] of [
    ['cgst', 'OUTPUT_CGST', 'INPUT_CGST', 'RCM_CGST'],
    ['sgst', 'OUTPUT_SGST', 'INPUT_SGST', 'RCM_SGST'],
    ['igst', 'OUTPUT_IGST', 'INPUT_IGST', 'RCM_IGST'],
  ] as const) {
    assert.equal(balance(w, L[out]), 0 - gstHead(w, head, outward), `${out} = −Σ outward ${head}`);
    assert.equal(balance(w, L[inp]), gstHead(w, head, inward), `${inp} = Σ claimable inward ${head}`);
    assert.equal(balance(w, L[rcm]), 0 - gstHead(w, head, `${inward} AND g.is_reverse_charge = 1`), `${rcm} = −Σ RCM ${head}`);
  }
  const parties = t.db.all<{ id: number; name: string }>(
    `SELECT l.id, l.name FROM ledgers l JOIN groups g ON g.id = l.group_id
      WHERE g.reserved_code IN ('SUNDRY_DEBTORS', 'SUNDRY_CREDITORS') AND l.maintain_bill_wise = 1`,
  );
  assert.ok(parties.length >= 9);
  for (const p of parties) {
    const sum = pendingBills(t.db, p.id, MONTH_END, t.today).reduce((a, b) => a + b.amount, 0);
    assert.equal(sum, balance(w, p.id), `${p.name}: Σ pending bills = ledger balance`);
  }
  for (const table of ['ledger_entries', 'gst_lines', 'bill_allocations']) {
    const bad = t.db.all(
      `SELECT c.voucher_id FROM ${table} c JOIN vouchers v ON v.id = c.voucher_id
        WHERE c.date <> v.date OR c.affects_books <> v.affects_books OR c.is_post_dated <> v.is_post_dated`,
    );
    assert.deepEqual(bad, [], `${table} flags follow the voucher`);
  }
}

function buildMonth(): World {
  // Working date: last day of the month (all April vouchers are back-dated for the Owner, who may).
  const t = createTestCompany({ today: MONTH_END, name: 'Shree Ganesh Traders' });
  const w: World = { t, vt: t.ids.voucherTypes, L: {}, I: {}, V: {} };
  const L = w.L;
  L.cash = t.ids.ledgers.CASH;
  L.sales = t.ids.ledgers.SALES;
  L.purchase = t.ids.ledgers.PURCHASE;
  L.roundOff = t.ids.ledgers.ROUND_OFF;

  // ── Opening balances (1-Apr-2026), Σ = 0 ──
  //   Capital Cr 5,00,000 · Furniture Dr 2,10,000 · Bank Dr 3,00,000 · Cash Dr 20,000
  //   Acme Dr 50,000 (bill OB-1) · Supreme Cr 80,000 (bill S-OB)
  //   −50,000,000 + 21,000,000 + 30,000,000 + 2,000,000 + 5,000,000 − 8,000,000 = 0
  t.db.run('UPDATE ledgers SET opening_balance = 2000000 WHERE id = :id', { id: L.cash });
  L.capital = t.addLedger({ name: 'Owner Capital', group: 'CAPITAL_ACCOUNT', openingBalance: -50000000 });
  L.furniture = t.addLedger({ name: 'Furniture & Fixtures', group: 'FIXED_ASSETS', openingBalance: 21000000 });
  L.bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS', openingBalance: 30000000, bank: { accountNo: '50100012345678', ifsc: 'HDFC0000001' } });
  L.acme = t.addLedger({
    name: 'Acme Traders',
    group: 'SUNDRY_DEBTORS',
    gstin: makeGstin('27', testPan(1)),
    creditDays: 30,
    openingBalance: 5000000,
    openingBills: [{ name: 'OB-1', date: '2026-03-20', amount: 5000000 }],
  });
  L.supreme = t.addLedger({
    name: 'Supreme Suppliers',
    group: 'SUNDRY_CREDITORS',
    gstin: makeGstin('27', testPan(4)),
    creditDays: 45,
    openingBalance: -8000000,
    openingBills: [{ name: 'S-OB', date: '2026-03-25', amount: -8000000 }],
  });

  // ── Other parties ──
  L.blr = t.addLedger({ name: 'Bangalore Retail', group: 'SUNDRY_DEBTORS', gstin: makeGstin('29', testPan(2)) });
  L.walkin = t.addLedger({ name: 'Walk-in Customer', group: 'SUNDRY_DEBTORS', stateCode: '27' });
  L.mysore = t.addLedger({ name: 'Mysore Hotel Supplies', group: 'SUNDRY_DEBTORS', stateCode: '29' });
  L.export = t.addLedger({ name: 'Global Imports LLC', group: 'SUNDRY_DEBTORS', registrationType: 'overseas', columns: { country: 'USA', state_code: null } });
  L.delhi = t.addLedger({ name: 'Delhi Appliances', group: 'SUNDRY_CREDITORS', gstin: makeGstin('07', testPan(6)) });
  L.gta = t.addLedger({ name: 'Speedy Roadways (GTA)', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(5)) });
  L.machineVendor = t.addLedger({ name: 'Pune Machine Tools', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(7)) });

  // ── Income / expense / asset ledgers ──
  L.gtaFreight = t.addLedger({ name: 'Freight Inward (GTA)', group: 'DIRECT_EXPENSES', gstRate: 5, hsnSac: '996511', supplyType: 'services' });
  L.machinery = t.addLedger({ name: 'Plant & Machinery', group: 'FIXED_ASSETS', gstRate: 18, hsnSac: '8422', supplyType: 'goods' });
  L.rent = t.addLedger({ name: 'Godown Rent', group: 'INDIRECT_EXPENSES' });
  L.depreciation = t.addLedger({ name: 'Depreciation', group: 'INDIRECT_EXPENSES' });
  for (const code of ['OUTPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST', 'INPUT_IGST', 'INPUT_CGST', 'INPUT_SGST', 'RCM_CGST', 'RCM_SGST', 'RCM_IGST'] as const) {
    L[code] = t.ids.ledgers[code];
  }

  // ── Items (opening stock in Main Location) ──
  w.I.rice = t.addStockItem({ name: 'Basmati Rice 25kg Bag', gstRate: 5, hsnSac: '1006', openingQty: 100, openingRate: 50 });
  w.I.mixer = t.addStockItem({ name: 'Mixer Grinder', gstRate: 18, hsnSac: '8509', openingQty: 50, openingRate: 150 });
  w.I.oven = t.addStockItem({ name: 'Commercial Oven', gstRate: 18, hsnSac: '8419', openingQty: 5, openingRate: 60000 });

  // LUT for exports, valid for FY 2026-27.
  t.db.run(
    `UPDATE settings SET value = json_set(value, '$.gst.lutNumber', 'AD2704260012345', '$.gst.lutValidFrom', '2026-04-01', '$.gst.lutValidTo', '2027-03-31') WHERE key = 'config'`,
  );

  const vt = w.vt;
  const inv = (base: 'sales' | 'purchase' | 'credit_note', date: string, partyLedgerId: number, over: Partial<VoucherInput>): VoucherInput => ({
    voucherTypeId: vt[base],
    date,
    mode: 'item_invoice',
    partyLedgerId,
    ...over,
  });
  const led = (base: 'payment' | 'receipt' | 'contra' | 'journal', date: string, ledgers: VoucherInput['ledgers'], over: Partial<VoucherInput> = {}): VoucherInput => ({
    voucherTypeId: vt[base],
    date,
    mode: 'ledger',
    ledgers,
    ...over,
  });

  // P1 02-Apr intra-state purchase: rice 200 × ₹60 = 12,000.00; CGST 2.5% = 300.00, SGST 300.00 → ₹12,600.00.
  post(w, 'P1', inv('purchase', '2026-04-02', L.supreme, { referenceNo: 'SUP-501', referenceDate: '2026-04-01', items: [{ itemId: w.I.rice, qty: 200, rate: 60 }] }));
  // P2 03-Apr inter-state purchase (Delhi 07): mixer 40 × ₹1,000 = 40,000.00; IGST 18% = 7,200.00 → ₹47,200.00.
  post(w, 'P2', inv('purchase', '2026-04-03', L.delhi, { referenceNo: 'DL-77', items: [{ itemId: w.I.mixer, qty: 40, rate: 1000 }] }));
  // P3 04-Apr GTA freight under RCM: ₹2,000.00 @5% → CGST 50.00 + SGST 50.00 payable by us.
  post(w, 'P3', {
    voucherTypeId: vt.purchase,
    date: '2026-04-04',
    mode: 'accounting_invoice',
    partyLedgerId: L.gta,
    referenceNo: 'GTA-12',
    reverseCharge: true,
    ledgers: [{ ledgerId: L.gtaFreight, amount: 200000 }],
  });
  // P4 05-Apr capital goods: packing machine ₹1,00,000.00 @18% → CGST 9,000 + SGST 9,000 → ₹1,18,000.00.
  post(w, 'P4', {
    voucherTypeId: vt.purchase,
    date: '2026-04-05',
    mode: 'accounting_invoice',
    partyLedgerId: L.machineVendor,
    referenceNo: 'MV-9',
    ledgers: [{ ledgerId: L.machinery, amount: 10000000 }],
  });

  // S1 08-Apr B2B intra-state (sales no. 1): mixer 10 × ₹1,500 = 15,000 (CGST/SGST 9% = 1,350 each);
  //   rice 20 × ₹80 = 1,600 (CGST/SGST 2.5% = 40 each). Taxable 16,600; tax 2 × 1,390 = 2,780 → ₹19,380.00.
  post(w, 'S1', inv('sales', '2026-04-08', L.acme, { items: [{ itemId: w.I.mixer, qty: 10, rate: 1500 }, { itemId: w.I.rice, qty: 20, rate: 80 }] }));
  // S2 09-Apr B2B inter-state (no. 2): mixer 5 × ₹1,600 = 8,000; IGST 18% = 1,440 → ₹9,440.00.
  post(w, 'S2', inv('sales', '2026-04-09', L.blr, { items: [{ itemId: w.I.mixer, qty: 5, rate: 1600 }] }));
  // S3 10-Apr cash sale B2CS (no. 3): rice 10 × ₹75 = 750.00; CGST = SGST = 18.75 → 787.50 → ₹788.00 (round off Cr 0.50).
  post(w, 'S3', inv('sales', '2026-04-10', L.cash, { items: [{ itemId: w.I.rice, qty: 10, rate: 75 }] }));
  // S4 11-Apr B2CL (no. 4): oven 1 × ₹95,000 to an unregistered Karnataka buyer; IGST 17,100 → ₹1,12,100.00 > ₹1,00,000.
  post(w, 'S4', inv('sales', '2026-04-11', L.mysore, { items: [{ itemId: w.I.oven, qty: 1, rate: 95000 }] }));
  // S5 12-Apr export under LUT (no. 5): rice 50 × ₹100 = ₹5,000.00, zero-rated, no tax.
  post(w, 'S5', inv('sales', '2026-04-12', L.export, {
    items: [{ itemId: w.I.rice, qty: 50, rate: 100 }],
    exportDetails: { shippingBillNo: '4455667', shippingBillDate: '2026-04-12', portCode: 'INNSA1' },
  }));
  // CN1 14-Apr sales return against invoice 1: mixer 2 × ₹1,500 = 3,000 + CGST 270 + SGST 270 = ₹3,540.00.
  post(w, 'CN1', inv('credit_note', '2026-04-14', L.acme, {
    originalInvoiceNo: '1',
    originalInvoiceDate: '2026-04-08',
    noteReason: 'Sales return',
    items: [{ itemId: w.I.mixer, qty: 2, rate: 1500 }],
  }));

  // R1 15-Apr receipt from Acme into bank ₹75,840.00: OB-1 50,000 + bill 1 (19,380 − 3,540 = 15,840) + advance 10,000.
  post(w, 'R1', led('receipt', '2026-04-15', [
    { ledgerId: L.bank, amount: 7584000, instrument: { type: 'neft', number: 'UTR-ACME-1' } },
    {
      ledgerId: L.acme,
      amount: -7584000,
      billAllocations: [
        { refType: 'against', billName: 'OB-1', amount: 5000000 },
        { refType: 'against', billName: '1', amount: 1584000 },
        { refType: 'advance', billName: 'ADV-ACME', amount: 1000000 },
      ],
    },
  ]));
  // R2 16-Apr part receipt from Bangalore Retail ₹5,000.00 against bill 2 (9,440 → 4,440 pending).
  post(w, 'R2', led('receipt', '2026-04-16', [
    { ledgerId: L.bank, amount: 500000 },
    { ledgerId: L.blr, amount: -500000, billAllocations: [{ refType: 'against', billName: '2', amount: 500000 }] },
  ]));
  // PY1 18-Apr pay Supreme ₹92,600.00: S-OB 80,000 + SUP-501 12,600.
  post(w, 'PY1', led('payment', '2026-04-18', [
    {
      ledgerId: L.supreme,
      amount: 9260000,
      billAllocations: [
        { refType: 'against', billName: 'S-OB', amount: 8000000 },
        { refType: 'against', billName: 'SUP-501', amount: 1260000 },
      ],
    },
    { ledgerId: L.bank, amount: -9260000, instrument: { type: 'rtgs', number: 'UTR-SUP-1' } },
  ]));
  // PY2 19-Apr pay the transporter ₹2,000.00 against GTA-12 (the RCM tax is paid to the government, not to him).
  post(w, 'PY2', led('payment', '2026-04-19', [
    { ledgerId: L.gta, amount: 200000, billAllocations: [{ refType: 'against', billName: 'GTA-12', amount: 200000 }] },
    { ledgerId: L.bank, amount: -200000 },
  ]));
  // PY3 20-Apr godown rent ₹15,000.00 from bank.
  post(w, 'PY3', led('payment', '2026-04-20', [{ ledgerId: L.rent, amount: 1500000 }, { ledgerId: L.bank, amount: -1500000 }]));
  // C1 21-Apr cash withdrawn ₹10,000.00; C2 22-Apr cash deposited ₹5,000.00.
  post(w, 'C1', led('contra', '2026-04-21', [{ ledgerId: L.cash, amount: 1000000 }, { ledgerId: L.bank, amount: -1000000 }]));
  post(w, 'C2', led('contra', '2026-04-22', [{ ledgerId: L.bank, amount: 500000 }, { ledgerId: L.cash, amount: -500000 }]));

  // DN1 23-Apr delivery note no. 1 to Acme: rice 30 bags leave the godown (no accounting).
  post(w, 'DN1', {
    voucherTypeId: vt.delivery_note,
    date: '2026-04-23',
    mode: 'inventory',
    partyLedgerId: L.acme,
    items: [{ itemId: w.I.rice, qty: 30, rate: 80 }],
  });
  // S6 25-Apr invoice no. 6 billing DN 1: rice 30 × ₹80 = 2,400 + CGST 60 + SGST 60 = ₹2,520.00; no stock movement.
  post(w, 'S6', inv('sales', '2026-04-25', L.acme, { items: [{ itemId: w.I.rice, qty: 30, rate: 80, trackingRef: '1' }] }));

  // OPT 26-Apr optional (memo) quotation-like sale no. 7: mixer 3 × ₹1,500 — must not touch books or stock.
  post(w, 'OPT', inv('sales', '2026-04-26', L.acme, { isOptional: true, items: [{ itemId: w.I.mixer, qty: 3, rate: 1500 }] }));
  // CAN 27-Apr sale no. 8 to a walk-in, then cancelled: number kept, books and stock untouched.
  post(w, 'CAN', inv('sales', '2026-04-27', L.walkin, { items: [{ itemId: w.I.mixer, qty: 1, rate: 1500 }] }));
  cancelVoucher(t.ctx, w.V.CAN.id, 'Customer did not take delivery');

  // DEP 30-Apr depreciation on machinery: ₹1,00,000 × 15% × 1/12 = ₹1,250.00.
  post(w, 'DEP', led('journal', MONTH_END, [{ ledgerId: L.depreciation, amount: 125000 }, { ledgerId: L.machinery, amount: -125000 }]));

  // PDC 05-May post-dated cheque to Delhi Appliances ₹5,000.00 against DL-77: out of the books until 5-May.
  post(w, 'PDC', led('payment', '2026-05-05', [
    { ledgerId: L.delhi, amount: 500000, billAllocations: [{ refType: 'against', billName: 'DL-77', amount: 500000 }] },
    { ledgerId: L.bank, amount: -500000, instrument: { type: 'cheque', number: '000123', date: '2026-05-05' } },
  ], { isPostDated: true }));

  return w;
}

describe('one month of a Maharashtra trader, end to end', () => {
  let w: World;
  before(() => {
    w = buildMonth();
  });
  after(() => w.t.close());

  it('posts each invoice with the hand-computed entries', () => {
    const { V } = w;
    assert.deepEqual(entries(w, V.P1.id), { Purchase: 1200000, 'Input CGST': 30000, 'Input SGST/UTGST': 30000, 'Supreme Suppliers': -1260000 });
    assert.deepEqual(entries(w, V.P2.id), { Purchase: 4000000, 'Input IGST': 720000, 'Delhi Appliances': -4720000 });
    assert.deepEqual(entries(w, V.P3.id), {
      'Speedy Roadways (GTA)': -200000,
      'Freight Inward (GTA)': 200000,
      'Input CGST': 5000,
      'Input SGST/UTGST': 5000,
      'CGST Payable (Reverse Charge)': -5000,
      'SGST Payable (Reverse Charge)': -5000,
    });
    assert.deepEqual(entries(w, V.P4.id), { 'Pune Machine Tools': -11800000, 'Plant & Machinery': 10000000, 'Input CGST': 900000, 'Input SGST/UTGST': 900000 });
    assert.deepEqual(entries(w, V.S1.id), { 'Acme Traders': 1938000, Sales: -1660000, 'Output CGST': -139000, 'Output SGST/UTGST': -139000 });
    assert.deepEqual(entries(w, V.S2.id), { 'Bangalore Retail': 944000, Sales: -800000, 'Output IGST': -144000 });
    assert.deepEqual(entries(w, V.S3.id), { Cash: 78800, Sales: -75000, 'Output CGST': -1875, 'Output SGST/UTGST': -1875, 'Round Off': -50 });
    assert.deepEqual(entries(w, V.S4.id), { 'Mysore Hotel Supplies': 11210000, Sales: -9500000, 'Output IGST': -1710000 });
    assert.deepEqual(entries(w, V.S5.id), { 'Global Imports LLC': 500000, Sales: -500000 });
    assert.deepEqual(entries(w, V.CN1.id), { 'Acme Traders': -354000, Sales: 300000, 'Output CGST': 27000, 'Output SGST/UTGST': 27000 });
    assert.deepEqual(entries(w, V.S6.id), { 'Acme Traders': 252000, Sales: -240000, 'Output CGST': -6000, 'Output SGST/UTGST': -6000 });
    assert.deepEqual(entries(w, V.DN1.id), {}, 'a delivery note has no ledger entries');
    assert.deepEqual(
      [V.S1, V.S2, V.S3, V.S4, V.S5, V.S6, V.OPT, V.CAN].map((r) => r.number),
      ['1', '2', '3', '4', '5', '6', '7', '8'],
      'sales numbers are continuous; optional and cancelled ones keep theirs',
    );
  });

  it('classifies every GST document for the returns', () => {
    const nature = (id: number): unknown => w.t.db.value('SELECT gst_nature FROM vouchers WHERE id = :id', { id });
    const { V } = w;
    assert.deepEqual(
      ['P1', 'P2', 'P3', 'P4', 'S1', 'S2', 'S3', 'S4', 'S5', 'CN1', 'S6'].map((n) => [n, nature(V[n].id)]),
      [
        ['P1', 'inward_b2b'],
        ['P2', 'inward_b2b'],
        ['P3', 'inward_rcm'],
        ['P4', 'inward_b2b'],
        ['S1', 'b2b'],
        ['S2', 'b2b'],
        ['S3', 'b2cs'],
        ['S4', 'b2cl'],
        ['S5', 'export_lut'],
        ['CN1', 'b2b'],
        ['S6', 'b2b'],
      ],
    );
    const itc = w.t.db.all<{ v: number; itc: string; rc: number }>(
      `SELECT voucher_id AS v, itc_eligibility AS itc, is_reverse_charge AS rc FROM gst_lines WHERE voucher_id IN (:a, :b, :c) ORDER BY voucher_id`,
      { a: V.P1.id, b: V.P3.id, c: V.P4.id },
    );
    assert.deepEqual(itc.map((r) => [r.itc, r.rc]), [['inputs', 0], ['input_services', 1], ['capital_goods', 0]]);
    // Export under LUT keeps the 18%/5% rate on the line but no tax.
    const exp = w.t.db.get<{ rate: number; taxable_value: number; igst: number }>('SELECT rate, taxable_value, igst FROM gst_lines WHERE voucher_id = :id', { id: V.S5.id });
    assert.deepEqual(exp, { rate: 5, taxable_value: 500000, igst: 0 });
    assert.equal(w.t.db.value('SELECT place_of_supply FROM vouchers WHERE id = :id', { id: V.S4.id }), '29');
  });

  it('every voucher balances and the trial balance sums to zero', () => {
    const unbalanced = w.t.db.all('SELECT voucher_id, SUM(amount) AS s FROM ledger_entries GROUP BY voucher_id HAVING SUM(amount) <> 0');
    assert.deepEqual(unbalanced, []);
    const openings = w.t.db.value<number>('SELECT SUM(opening_balance) FROM ledgers') ?? 0;
    assert.equal(openings, 0, 'opening balances agree');
    const books = w.t.db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE ${BOOKS_FILTER()}`, { today: w.t.today }) ?? 0;
    assert.equal(openings + books, 0);
    // Trial balance totals: Dr ₹8,18,468.00 = Cr ₹8,18,468.00 (see the closing balance table below).
    const tb = w.t.db.all<{ bal: number }>(
      `SELECT l.opening_balance + COALESCE((SELECT SUM(le.amount) FROM ledger_entries le WHERE le.ledger_id = l.id AND ${BOOKS_FILTER('le')}), 0) AS bal FROM ledgers l`,
      { today: w.t.today },
    );
    const dr = tb.filter((r) => r.bal > 0).reduce((a, r) => a + r.bal, 0);
    const cr = tb.filter((r) => r.bal < 0).reduce((a, r) => a - r.bal, 0);
    assert.deepEqual([dr, cr], [81846800, 81846800]);
  });

  it('closes every ledger at the hand-computed balance', () => {
    const { L } = w;
    const expected: Record<string, number> = {
      capital: -50000000,
      furniture: 21000000,
      // 3,00,000 + 75,840 + 5,000 − 92,600 − 2,000 − 15,000 − 10,000 + 5,000 = ₹2,66,240.00 (PDC not yet).
      bank: 26624000,
      // 20,000 + 788 + 10,000 − 5,000 = ₹25,788.00.
      cash: 2578800,
      // 50,000 + 19,380 − 3,540 − 75,840 + 2,520 = −₹7,480.00 (advance exceeds the new bill).
      acme: -748000,
      blr: 444000,
      mysore: 11210000,
      export: 500000,
      walkin: 0,
      supreme: 0,
      delhi: -4720000,
      gta: 0,
      machineVendor: -11800000,
      purchase: 5200000,
      gtaFreight: 200000,
      // 1,00,000 − 1,250 depreciation.
      machinery: 9875000,
      INPUT_CGST: 935000,
      INPUT_SGST: 935000,
      INPUT_IGST: 720000,
      RCM_CGST: -5000,
      RCM_SGST: -5000,
      RCM_IGST: 0,
      // −(16,600 + 8,000 + 750 + 95,000 + 5,000 + 2,400) + 3,000 return = −₹1,24,750.00.
      sales: -12475000,
      // −(1,390 + 18.75 + 60) + 270 = −₹1,198.75.
      OUTPUT_CGST: -119875,
      OUTPUT_SGST: -119875,
      OUTPUT_IGST: -1854000,
      roundOff: -50,
      rent: 1500000,
      depreciation: 125000,
    };
    const actual: Record<string, number> = {};
    for (const k of Object.keys(expected)) actual[k] = balance(w, L[k]);
    assert.deepEqual(actual, expected);
    assert.equal(Object.values(expected).reduce((a, b) => a + b, 0), 0);
  });

  it('tax ledgers equal the gst_lines totals per head and direction', () => {
    const outward = `v.base_type IN ('sales', 'credit_note') AND g.is_reverse_charge = 0`;
    const inward = `v.base_type IN ('purchase', 'debit_note') AND COALESCE(g.itc_eligibility, '') <> 'ineligible' AND v.gst_nature <> 'import_goods'`;
    const L = w.L;
    for (const [head, out, inp, rcm] of [
      ['cgst', 'OUTPUT_CGST', 'INPUT_CGST', 'RCM_CGST'],
      ['sgst', 'OUTPUT_SGST', 'INPUT_SGST', 'RCM_SGST'],
      ['igst', 'OUTPUT_IGST', 'INPUT_IGST', 'RCM_IGST'],
    ] as const) {
      assert.equal(balance(w, L[out]), 0 - gstHead(w, head, outward), `${out} = −Σ outward ${head}`);
      assert.equal(balance(w, L[inp]), gstHead(w, head, inward), `${inp} = Σ claimable inward ${head}`);
      assert.equal(balance(w, L[rcm]), 0 - gstHead(w, head, `${inward} AND g.is_reverse_charge = 1`), `${rcm} = −Σ RCM ${head}`);
    }
    // Header tax = Σ line tax for every GST document.
    const mismatch = w.t.db.all(
      `SELECT v.id FROM vouchers v JOIN gst_lines g ON g.voucher_id = v.id
        GROUP BY v.id HAVING v.tax_amount <> SUM(g.igst + g.cgst + g.sgst + g.cess) OR v.taxable_amount <> SUM(g.taxable_value)`,
    );
    assert.deepEqual(mismatch, []);
  });

  it("each party's pending bills add up to its ledger balance", () => {
    const { L, t } = w;
    const pend = (id: number): Array<[string, number]> => pendingBills(t.db, id, MONTH_END, t.today).map((b) => [b.billName, b.amount]);
    // Oldest first: the advance of 15-Apr, then invoice 6 of 25-Apr.
    assert.deepEqual(pend(L.acme), [['ADV-ACME', -1000000], ['6', 252000]]);
    assert.deepEqual(pend(L.blr), [['2', 444000]]);
    assert.deepEqual(pend(L.mysore), [['4', 11210000]]);
    assert.deepEqual(pend(L.export), [['5', 500000]]);
    assert.deepEqual(pend(L.supreme), []);
    assert.deepEqual(pend(L.gta), []);
    assert.deepEqual(pend(L.delhi), [['DL-77', -4720000]], 'the post-dated cheque is not yet in the books');
    assert.deepEqual(pend(L.machineVendor), [['MV-9', -11800000]]);
    assert.deepEqual(pend(L.walkin), [], 'cancelled invoice leaves no bill');
    for (const name of ['acme', 'blr', 'mysore', 'export', 'supreme', 'gta', 'delhi', 'machineVendor', 'walkin']) {
      const sum = pendingBills(t.db, L[name], MONTH_END, t.today).reduce((a, b) => a + b.amount, 0);
      assert.equal(sum, balance(w, L[name]), `${name}: Σ pending bills = ledger balance`);
    }
  });

  it('stock per item equals opening ± movements; the billed delivery note moved stock once', () => {
    const { I } = w;
    // Rice: 100 + 200 − 20 − 10 − 50 − 30 (delivery note; invoice 6 moves nothing) = 190.
    assert.equal(stock(w, I.rice), 190);
    // Mixer: 50 + 40 − 10 − 5 + 2 (return) = 77; the optional (3) and cancelled (1) sales move nothing.
    assert.equal(stock(w, I.mixer), 77);
    // Oven: 5 − 1 = 4.
    assert.equal(stock(w, I.oven), 4);
    assert.deepEqual(trackingRefs(w.t.db, w.L.acme, 'delivery'), [], 'delivery note 1 is fully billed');
    const s6 = w.t.db.get<{ affects_stock: number; tracking_ref: string }>('SELECT affects_stock, tracking_ref FROM inventory_entries WHERE voucher_id = :id', { id: w.V.S6.id });
    assert.deepEqual(s6, { affects_stock: 0, tracking_ref: '1' });
  });

  it('optional and cancelled vouchers leave no trace in books, stock or GST', () => {
    const { V, t } = w;
    for (const name of ['OPT', 'CAN']) {
      const id = V[name].id;
      const h = t.db.get<{ affects_books: number; affects_stock: number }>('SELECT affects_books, affects_stock FROM vouchers WHERE id = :id', { id });
      assert.deepEqual(h, { affects_books: 0, affects_stock: 0 }, name);
      for (const table of ['ledger_entries', 'gst_lines', 'bill_allocations']) {
        assert.equal(t.db.value(`SELECT COUNT(*) FROM ${table} WHERE voucher_id = :id AND affects_books = 1`, { id }), 0, `${name}.${table}`);
      }
      assert.equal(t.db.value('SELECT COUNT(*) FROM inventory_entries WHERE voucher_id = :id AND affects_stock = 1', { id }), 0, `${name}.inventory`);
    }
    const can = getVoucher(t.db, V.CAN.id);
    assert.equal(can.number, '8');
    assert.equal(t.db.value('SELECT is_cancelled FROM vouchers WHERE id = :id', { id: V.CAN.id }), 1);
  });

  it('every child row carries its voucher date, books flag and post-dated flag', () => {
    for (const table of ['ledger_entries', 'gst_lines', 'bill_allocations']) {
      const bad = w.t.db.all(
        `SELECT c.voucher_id FROM ${table} c JOIN vouchers v ON v.id = c.voucher_id
          WHERE c.date <> v.date OR c.affects_books <> v.affects_books OR c.is_post_dated <> v.is_post_dated`,
      );
      assert.deepEqual(bad, [], table);
    }
    const bad = w.t.db.all(
      `SELECT c.voucher_id FROM inventory_entries c JOIN vouchers v ON v.id = c.voucher_id
        WHERE c.date <> v.date OR c.is_post_dated <> v.is_post_dated OR (c.affects_stock = 1 AND v.affects_stock = 0)`,
    );
    assert.deepEqual(bad, []);
  });

  it('the post-dated cheque counts from its date', () => {
    const { L, t } = w;
    t.clock.setToday('2026-05-05');
    try {
      // Bank 2,66,240 − 5,000 = ₹2,61,240.00; Delhi −47,200 + 5,000 = −₹42,200.00.
      assert.equal(balance(w, L.bank, '2026-05-05', '2026-05-05'), 26124000);
      assert.equal(balance(w, L.delhi, '2026-05-05', '2026-05-05'), -4220000);
      assert.deepEqual(pendingBills(t.db, L.delhi, '2026-05-05', '2026-05-05').map((b) => [b.billName, b.amount]), [['DL-77', -4220000]]);
      const books = t.db.value<number>(`SELECT COALESCE(SUM(opening_balance), 0) FROM ledgers`) ?? 0;
      const moved = t.db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE ${BOOKS_FILTER()}`, { today: '2026-05-05' }) ?? 0;
      assert.equal(books + moved, 0);
    } finally {
      t.clock.setToday(MONTH_END);
    }
  });

  it('saving each voucher as returned by vouchers.get reproduces its rows exactly', () => {
    const { V, t } = w;
    const snapshot = (id: number): unknown => ({
      le: t.db.all('SELECT ledger_id, amount, role, gst_duty_head, date, affects_books, is_post_dated FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id }),
      inv: t.db.all('SELECT item_id, qty, rate, amount, affects_stock, tracking_ref FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id }),
      gst: t.db.all('SELECT taxable_value, igst, cgst, sgst, itc_eligibility, is_reverse_charge FROM gst_lines WHERE voucher_id = :id ORDER BY line_no', { id }),
      bills: t.db.all('SELECT ref_type, bill_name, amount, due_date FROM bill_allocations WHERE voucher_id = :id ORDER BY id', { id }),
      head: t.db.get('SELECT number, total_amount, taxable_amount, tax_amount, round_off, gst_nature, place_of_supply FROM vouchers WHERE id = :id', { id }),
    });
    for (const name of ['P1', 'P3', 'P4', 'S1', 'S3', 'S4', 'S5', 'CN1', 'R1', 'PY1', 'DN1', 'S6', 'DEP', 'PDC']) {
      const id = V[name].id;
      const before = snapshot(id);
      saveVoucher(t.ctx, { ...getVoucher(t.db, id).input, acknowledgeWarnings: true });
      assert.deepEqual(snapshot(id), before, `${name} re-saved unchanged`);
    }
  });

  it('turning the optional sale regular and back moves the books and then restores them', () => {
    const { V, L, t } = w;
    const acme = balance(w, L.acme);
    const mixer = stock(w, w.I.mixer);
    // Mixer 3 × ₹1,500 = 4,500 + CGST 405 + SGST 405 = ₹5,310.00.
    const regular = setVoucherOptional(t.ctx, V.OPT.id, false, true);
    assert.equal(balance(w, L.acme), acme + 531000);
    assert.equal(stock(w, w.I.mixer), mixer - 3);
    assert.equal(regular.number, '7');
    setVoucherOptional(t.ctx, V.OPT.id, true, true);
    assert.equal(balance(w, L.acme), acme);
    assert.equal(stock(w, w.I.mixer), mixer);
  });
  it('alters, a delete and a cancel later in the month keep every invariant', () => {
    const { V, L, I, t } = w;
    assertInvariants(w);
    // S2 re-priced: mixer 5 × ₹1,700 = 8,500 + IGST 1,530 = ₹10,030.00 (bill 2 keeps its name).
    const s2 = getVoucher(t.db, V.S2.id).input;
    saveVoucher(t.ctx, { ...s2, items: [{ itemId: I.mixer, qty: 5, rate: 1700 }], acknowledgeWarnings: true });
    assert.deepEqual(entries(w, V.S2.id), { 'Bangalore Retail': 1003000, Sales: -850000, 'Output IGST': -153000 });
    // 10,030 − 5,000 received = ₹5,030.00 pending on bill 2.
    assert.deepEqual(pendingBills(t.db, L.blr, MONTH_END, t.today).map((b) => [b.billName, b.amount]), [['2', 503000]]);
    // R2 (₹5,000 from Bangalore Retail) deleted: bill 2 is fully pending again; bank −5,000.
    deleteVoucher(t.ctx, V.R2.id, 'Cheque bounced, entered by mistake');
    assert.deepEqual(pendingBills(t.db, L.blr, MONTH_END, t.today).map((b) => [b.billName, b.amount]), [['2', 1003000]]);
    // PY3 (rent ₹15,000) cancelled: bank +15,000; the number stays.
    cancelVoucher(t.ctx, V.PY3.id, 'Rent paid by the landlord adjustment');
    // Bank 2,66,240 − 5,000 + 15,000 = ₹2,76,240.00.
    assert.equal(balance(w, L.bank), 27624000);
    assert.equal(balance(w, L.rent), 0);
    // P1 moved from 2-Apr to 6-Apr: still before the first rice sale (8-Apr) and the payment (18-Apr).
    const p1 = getVoucher(t.db, V.P1.id).input;
    saveVoucher(t.ctx, { ...p1, date: '2026-04-06' });
    assert.equal(t.db.value('SELECT MIN(date) FROM ledger_entries WHERE voucher_id = :id', { id: V.P1.id }), '2026-04-06');
    // DN1 raised from 30 to 35 bags (30 billed by invoice 6): stock 190 − 5 = 185, 5 bags left to bill.
    const dn = getVoucher(t.db, V.DN1.id).input;
    saveVoucher(t.ctx, { ...dn, items: [{ itemId: I.rice, qty: 35, rate: 80 }] });
    assert.equal(stock(w, I.rice), 185);
    assert.deepEqual(trackingRefs(t.db, L.acme, 'delivery').map((d) => [d.number, d.lines.map((l) => l.pendingQty)]), [['1', [5]]]);
    assertInvariants(w);
  });
});

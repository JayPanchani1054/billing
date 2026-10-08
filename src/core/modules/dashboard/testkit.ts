/**
 * Test books for the dashboard (tests only), posted through the vouchers service.
 *
 * Company: Maharashtra (27), GST regular, inventory integrated, bill-wise on. Books from 1-Apr-2025,
 * working date (clock) **8-Oct-2026**. Masters from vouchers/testkit `setupKit` (acme 30 days, blr
 * (29) no credit days, supplier 45 days, rice 100 @ ₹50, mixer 50 @ ₹150, noRate 10 @ ₹10) plus:
 * metro (27, 10 credit days), quick (supplier, 45 days), tumbler (3 @ ₹80, reorder 10);
 * reorder levels rice 50, mixer 60. Purchase rates equal the opening rates, so average cost never
 * moves (rice ₹50, mixer ₹150) and stock values are qty × rate.
 *
 * Amounts in rupees (tests compare paise = × 100):
 *
 *   FY 2025-26 (last year)
 *   L0  01-Apr-25 Receipt   Bank Dr 50,000 / Owner Capital Cr
 *   L1  03-Oct-25 Purchase  supplier SUP-LY1 rice 50 @ 50 = 2,500 + 5% 125 = 2,625
 *   L2  05-Oct-25 Sales     Cash  mixer 2 @ 200 = 400 + 18% 72 = 472
 *   L3  08-Oct-25 Sales     Cash  rice 10 @ 60 = 600 + 5% 30 = 630
 *   L4  10-Nov-25 Payment   Bank → supplier 2,625 against SUP-LY1
 *   FY 2026-27
 *   C1  02-Apr-26 Contra    Cash Dr 5,000 / Bank Cr
 *   P1  10-Apr-26 Purchase  supplier SUP-101 rice 100 @ 50 = 5,000 + 250 = 5,250 (due 25-May)
 *   S1  20-Apr-26 Sales     acme mixer 5 @ 200 = 1,000 + 180 = 1,180 (due 20-May)
 *   R1  01-Jun-26 Receipt   Bank 500 from acme against S1
 *   PAY 01-Jul-26 Payment   Bank 3,000 → supplier against SUP-101 (2,250 left)
 *   P3  25-Aug-26 Purchase  quick QS-77 mixer 5 @ 150 = 750 + 135 = 885 (due 9-Oct)
 *   S2  15-Sep-26 Sales     blr mixer 10 @ 250 = 2,500 + IGST 450 = 2,950 (due 15-Sep)
 *   X1  20-Sep-26 Sales     metro rice 5 @ 60 — CANCELLED
 *   RNT 30-Sep-26 Payment   Bank 10,000 → Office Rent
 *   S3  01-Oct-26 Sales     metro rice 20 @ 60 = 1,200 + 60 = 1,260 (due 11-Oct)
 *   P2  02-Oct-26 Purchase  supplier SUP-102 mixer 20 @ 150 = 3,000 + 540 = 3,540 (due 16-Nov)
 *   CN  05-Oct-26 Credit Note acme (accounting) Sales 200 @ 18% = 236 against S1 (S1 left 444)
 *   S4  08-Oct-26 Sales     acme mixer 1 @ 300 = 300 + 54 = 354 (due 7-Nov)
 *   OPT 08-Oct-26 Sales     acme mixer 1 @ 1,000 — OPTIONAL
 *   PD1 20-Oct-26 Receipt   post-dated, Bank 444 from acme against S1, cheque 123456
 *   PD2 25-Oct-26 Payment   post-dated, Bank 2,250 → supplier against SUP-101, cheque 654321
 */
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import type { TestCompanyOptions } from '../../testing/fixtures.ts';

export const TODAY = '2026-10-08';
export const BOOKS_FROM = '2025-04-01';
/** Dashboard input used by most tests: the financial year to date. */
export const INPUT = { asOf: TODAY, from: '2026-04-01', to: TODAY } as const;

export interface DashboardBooks extends Kit {
  v: Record<string, { id: number; number: string }>;
}

const rs = (r: number): number => Math.round(r * 100);

export function buildDashboardBooks(opts: TestCompanyOptions = {}): DashboardBooks {
  const k = setupKit({ today: TODAY, booksFrom: BOOKS_FROM, ...opts });
  const { t, vt, L, I } = k;
  L.metro = t.addLedger({ name: 'Metro Mart', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(9)), creditDays: 10 });
  L.quick = t.addLedger({ name: 'Quick Supplies', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(10)), creditDays: 45 });
  I.tumbler = t.addStockItem({ name: 'Steel Tumbler', gstRate: 12, hsnSac: '7323', openingQty: 3, openingRate: 80, reorderLevel: 10 });
  t.db.run('UPDATE stock_items SET reorder_level = 50 WHERE id = :id', { id: I.rice });
  t.db.run('UPDATE stock_items SET reorder_level = 60 WHERE id = :id', { id: I.mixer });

  const v: Record<string, { id: number; number: string }> = {};
  const post = (key: string, input: VoucherInput): void => {
    const r = save(k, input);
    v[key] = { id: r.id, number: r.number ?? '' };
  };
  const sale = (date: string, party: number, itemId: number, qty: number, rate: number, extra: Partial<VoucherInput> = {}): VoucherInput => ({
    voucherTypeId: vt.sales,
    date,
    mode: 'item_invoice',
    partyLedgerId: party,
    items: [{ itemId, qty, rate }],
    ...extra,
  });
  const purchase = (date: string, party: number, ref: string, itemId: number, qty: number, rate: number): VoucherInput => ({
    voucherTypeId: vt.purchase,
    date,
    mode: 'item_invoice',
    partyLedgerId: party,
    referenceNo: ref,
    referenceDate: date,
    items: [{ itemId, qty, rate }],
  });
  const ledger = (baseType: 'receipt' | 'payment' | 'contra', date: string, lines: VoucherInput['ledgers'], extra: Partial<VoucherInput> = {}): VoucherInput => ({
    voucherTypeId: vt[baseType],
    date,
    mode: 'ledger',
    ledgers: lines,
    ...extra,
  });

  // ── Last year ──
  post('L0', ledger('receipt', '2025-04-01', [{ ledgerId: L.bank, amount: rs(50_000) }, { ledgerId: L.capital, amount: -rs(50_000) }]));
  post('L1', purchase('2025-10-03', L.supplier, 'SUP-LY1', I.rice, 50, 50));
  post('L2', sale('2025-10-05', L.cash, I.mixer, 2, 200));
  post('L3', sale('2025-10-08', L.cash, I.rice, 10, 60));
  post(
    'L4',
    ledger('payment', '2025-11-10', [
      { ledgerId: L.supplier, amount: rs(2_625), billAllocations: [{ refType: 'against', billName: 'SUP-LY1', amount: rs(2_625) }] },
      { ledgerId: L.bank, amount: -rs(2_625) },
    ]),
  );

  // ── This year ──
  post('C1', ledger('contra', '2026-04-02', [{ ledgerId: L.cash, amount: rs(5_000) }, { ledgerId: L.bank, amount: -rs(5_000) }]));
  post('P1', purchase('2026-04-10', L.supplier, 'SUP-101', I.rice, 100, 50));
  post('S1', sale('2026-04-20', L.acme, I.mixer, 5, 200));
  post(
    'R1',
    ledger('receipt', '2026-06-01', [
      { ledgerId: L.bank, amount: rs(500) },
      { ledgerId: L.acme, amount: -rs(500), billAllocations: [{ refType: 'against', billName: v.S1.number, amount: rs(500) }] },
    ]),
  );
  post(
    'PAY',
    ledger('payment', '2026-07-01', [
      { ledgerId: L.supplier, amount: rs(3_000), billAllocations: [{ refType: 'against', billName: 'SUP-101', amount: rs(3_000) }] },
      { ledgerId: L.bank, amount: -rs(3_000) },
    ]),
  );
  post('P3', purchase('2026-08-25', L.quick, 'QS-77', I.mixer, 5, 150));
  post('S2', sale('2026-09-15', L.blr, I.mixer, 10, 250));
  post('X1', sale('2026-09-20', L.metro, I.rice, 5, 60));
  cancelVoucher(t.ctx, v.X1.id, 'Entered twice');
  post('RNT', ledger('payment', '2026-09-30', [{ ledgerId: L.rent, amount: rs(10_000) }, { ledgerId: L.bank, amount: -rs(10_000) }]));
  post('S3', sale('2026-10-01', L.metro, I.rice, 20, 60));
  post('P2', purchase('2026-10-02', L.supplier, 'SUP-102', I.mixer, 20, 150));
  post('CN', {
    voucherTypeId: vt.credit_note,
    date: '2026-10-05',
    mode: 'accounting_invoice',
    partyLedgerId: L.acme,
    originalInvoiceNo: v.S1.number,
    originalInvoiceDate: '2026-04-20',
    ledgers: [{ ledgerId: L.sales, amount: rs(200), gst: { rate: 18, hsnSac: '8509', supplyKind: 'goods' } }],
    partyBillAllocations: [{ refType: 'against', billName: v.S1.number, amount: rs(236) }],
  });
  post('S4', sale(TODAY, L.acme, I.mixer, 1, 300));
  post('OPT', sale(TODAY, L.acme, I.mixer, 1, 1_000, { isOptional: true }));
  post(
    'PD1',
    ledger(
      'receipt',
      '2026-10-20',
      [
        { ledgerId: L.bank, amount: rs(444), instrument: { type: 'cheque', number: '123456', date: '2026-10-20' } },
        { ledgerId: L.acme, amount: -rs(444), billAllocations: [{ refType: 'against', billName: v.S1.number, amount: rs(444) }] },
      ],
      { isPostDated: true },
    ),
  );
  post(
    'PD2',
    ledger(
      'payment',
      '2026-10-25',
      [
        { ledgerId: L.supplier, amount: rs(2_250), billAllocations: [{ refType: 'against', billName: 'SUP-101', amount: rs(2_250) }] },
        { ledgerId: L.bank, amount: -rs(2_250), instrument: { type: 'cheque', number: '654321', date: '2026-10-25' } },
      ],
      { isPostDated: true },
    ),
  );
  return { ...k, v };
}

// ───────────────────────────── Bulk data (performance tests) ─────────────────────────────

export interface BulkOptions {
  debtors: number[];
  creditors: number[];
  items: number[];
  bank: number;
  /** First voucher date (default 1-Apr-2025); vouchers are spread over 540 days. */
  from?: string;
  ledgers: { sales: number; purchase: number; outCgst: number; outSgst: number; inCgst: number; inSgst: number };
}

/**
 * Insert `count` vouchers directly, shaped like the posting engine's rows (performance tests only):
 * per 10 vouchers 5 sales (bill-wise 'new' bill, 30 days, 18% intra-state GST, 1 unit out), 2 purchases
 * (45 days, 1 unit in), 2 receipts settling the sale posted 7 vouchers earlier (so 2 of 5 sales are paid), 1 payment settling the
 * purchase 4 vouchers earlier. Every voucher balances.
 */
export function bulkBusiness(t: TestCompany, count: number, o: BulkOptions): void {
  const start = Date.parse(`${o.from ?? '2025-04-01'}T00:00:00Z`);
  const ts = new Date().toISOString();
  const vt = t.ids.voucherTypes;
  const totals = new Map<number, { party: number; total: number; bill: string }>();
  const day = (i: number): string => new Date(start + (i % 540) * 86_400_000).toISOString().slice(0, 10);
  const plus = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  t.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const date = day(i);
      const k = i % 10;
      const base = k < 5 ? 'sales' : k < 7 ? 'purchase' : k < 9 ? 'receipt' : 'payment';
      const taxable = 10_000 + (i % 97) * 100;
      const half = Math.round(taxable * 0.09);
      const total = taxable + 2 * half;
      let party: number;
      let amount = total;
      let settle: { party: number; total: number; bill: string } | undefined;
      if (base === 'sales') party = o.debtors[(i * 7) % o.debtors.length];
      else if (base === 'purchase') party = o.creditors[(i * 3) % o.creditors.length];
      else {
        // Receipts settle the sales 7 vouchers earlier (k 7 → k 0, k 8 → k 1); payments the purchase 4 earlier.
        settle = totals.get(base === 'receipt' ? i - 7 : i - 4);
        if (!settle) continue;
        party = settle.party;
        amount = settle.total;
      }
      const number = String(i + 1);
      const vid = Number(
        t.db.run(
          `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, party_ledger_id, invoice_mode, gst_nature,
                                 total_amount, taxable_amount, tax_amount, affects_stock, created_at, updated_at)
           VALUES (:guid, :vt, :bt, :num, :seq, :date, :party, :mode, :nature, :total, :taxable, :tax, :stock, :ts, :ts)`,
          {
            guid: `dash-${i}`,
            vt: vt[base],
            bt: base,
            num: number,
            seq: i + 1,
            date,
            party,
            mode: base === 'sales' || base === 'purchase' ? 'item' : null,
            nature: base === 'sales' ? 'b2b' : base === 'purchase' ? 'inward_b2b' : null,
            total: amount,
            taxable: base === 'sales' || base === 'purchase' ? taxable : 0,
            tax: base === 'sales' || base === 'purchase' ? 2 * half : 0,
            stock: base === 'sales' || base === 'purchase' ? 1 : 0,
            ts,
          },
        ).lastInsertRowid,
      );
      const entry = (line: number, ledgerId: number, amt: number, role: string): number =>
        Number(
          t.db.run('INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, role, date) VALUES (:v, :n, :l, :a, :r, :d)', { v: vid, n: line, l: ledgerId, a: amt, r: role, d: date })
            .lastInsertRowid,
        );
      const bill = (entryId: number, ledgerId: number, refType: string, name: string, amt: number, due: string | null): void => {
        t.db.run(
          `INSERT INTO bill_allocations (voucher_id, ledger_entry_id, ledger_id, ref_type, bill_name, amount, due_date, date)
           VALUES (:v, :e, :l, :rt, :b, :a, :due, :d)`,
          { v: vid, e: entryId, l: ledgerId, rt: refType, b: name, a: amt, due, d: date },
        );
      };
      if (base === 'sales' || base === 'purchase') {
        const sale = base === 'sales';
        const s = sale ? 1 : -1;
        const pe = entry(1, party, s * total, 'party');
        entry(2, sale ? o.ledgers.sales : o.ledgers.purchase, -s * taxable, sale ? 'sales' : 'purchase');
        entry(3, sale ? o.ledgers.outCgst : o.ledgers.inCgst, -s * half, 'tax');
        entry(4, sale ? o.ledgers.outSgst : o.ledgers.inSgst, -s * half, 'tax');
        const billName = sale ? number : `P-${number}`;
        bill(pe, party, 'new', billName, s * total, plus(date, sale ? 30 : 45));
        totals.set(i, { party, total, bill: billName });
        t.db.run('INSERT INTO inventory_entries (voucher_id, line_no, item_id, qty, rate, amount, date) VALUES (:v, 1, :it, :q, :r, :a, :d)', {
          v: vid,
          it: o.items[i % o.items.length],
          q: sale ? -1 : 1,
          r: taxable / 100,
          a: taxable,
          d: date,
        });
        t.db.run(
          `INSERT INTO gst_lines (voucher_id, line_no, source, item_id, hsn_sac, supply_type, taxability, rate, taxable_value, cgst, sgst, date)
           VALUES (:v, 1, 'item', :it, '8471', 'goods', 'taxable', 18, :tv, :c, :c, :d)`,
          { v: vid, it: o.items[i % o.items.length], tv: taxable, c: half, d: date },
        );
      } else if (settle) {
        const receipt = base === 'receipt';
        entry(1, o.bank, receipt ? amount : -amount, 'cash_bank');
        const pe = entry(2, party, receipt ? -amount : amount, 'party');
        bill(pe, party, 'against', settle.bill, receipt ? -amount : amount, null);
      }
    }
  });
}

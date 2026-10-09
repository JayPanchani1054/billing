/**
 * Test helpers for the reports module (used by *.test.ts only): a realistic month of books posted
 * through the vouchers service, with every figure hand-computed below.
 *
 * Company: GST regular, Maharashtra (27), books from 1-Apr-2026, working date 30-Apr-2026,
 * integrated inventory, item Widget (18%, average cost).
 *
 * Opening balances (paise):            Dr            Cr
 *   Owner Capital (Capital Account)                 3,90,00,000   (₹3,90,000)
 *   Cash                               50,00,000                   (₹50,000)
 *   HDFC Bank                       2,00,00,000                   (₹2,00,000)
 *   Furniture (Fixed Assets)        1,00,00,000                   (₹1,00,000)
 *   Supreme Suppliers (creditor)                      60,00,000   (₹60,000)
 *   Opening stock 100 Widget @ ₹1,000 = 1,00,00,000 (₹1,00,000)
 *   Σ ledgers = −2,10,00,000 + ... → L = −1,00,00,000 ; L + S0 = 0 (balanced openings)
 *
 * April 2026 vouchers:
 *   P1 05-Apr Purchase   Supreme 50 Widget @1,200: Dr Purchase 60,000, Dr Input CGST 5,400, Dr Input SGST 5,400, Cr Supreme 70,800
 *   S1 10-Apr Sales      Acme 80 Widget @1,500:   Dr Acme 1,41,600, Cr Sales 1,20,000, Cr Output CGST 10,800, Cr Output SGST 10,800
 *   R1 15-Apr Receipt    Dr HDFC 1,00,000 / Cr Acme 1,00,000
 *   P2 20-Apr Payment    Dr Office Rent 25,000 / Cr Cash 25,000
 *   P3 25-Apr Payment    Dr Supreme 50,000 / Cr HDFC 50,000
 *   C1 26-Apr Contra     Dr Cash 10,000 / Cr HDFC 10,000
 *   J1 28-Apr Journal    Dr Depreciation 5,000 / Cr Furniture 5,000
 *   R2 29-Apr Receipt    Dr Cash 2,000 / Cr Interest Received 2,000
 *
 * Closing stock (average cost): (1,00,000 + 60,000) / 150 = ₹1,066.6667; sold 80 →
 *   80 × 1,60,00,000 / 150 = 85,33,333.33 → 85,33,333 p; closing 70 Nos = 1,60,00,000 − 85,33,333 = 74,66,667 p.
 * Gross profit = 1,20,00,000 + 74,66,667 − 1,00,00,000 − 60,00,000 = 34,66,667 p
 * Net profit   = 34,66,667 + 2,00,000 − (25,00,000 + 5,00,000) = 6,66,667 p
 */
import type { VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany, type TestCompanyOptions } from '../../testing/fixtures.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { loadReportEnv, type ReportEnv } from './engine.ts';

export interface Books {
  t: TestCompany;
  /** Ledger ids by short name. */
  L: Record<string, number>;
  /** Voucher ids by short name (P1, S1, …). */
  V: Record<string, number>;
  widget: number;
  env: () => ReportEnv;
  post: (input: VoucherInput) => VoucherSaveResult;
}

export const APRIL = { from: '2026-04-01', to: '2026-04-30' } as const;

/** Expected figures of the April books (paise). */
export const EXPECTED = {
  openingStock: 10_000_000,
  closingStock: 7_466_667,
  sales: 12_000_000,
  purchases: 6_000_000,
  grossProfit: 3_466_667,
  indirectExpenses: 3_000_000,
  indirectIncomes: 200_000,
  netProfit: 666_667,
  cash: 3_700_000,
  bank: 24_000_000,
  acme: 4_160_000,
  supreme: -8_080_000,
  furniture: 9_500_000,
  capital: -39_000_000,
  /** Balance Sheet totals (each side). */
  bsTotal: 48_826_667,
} as const;

export function makeBooks(opts: TestCompanyOptions & { capitalOpening?: number; skipVouchers?: boolean } = {}): Books {
  const t = createTestCompany({ today: '2026-04-30', booksFrom: '2026-04-01', ...opts });
  const L: Record<string, number> = {
    cash: t.ids.ledgers.CASH,
    sales: t.ids.ledgers.SALES,
    purchase: t.ids.ledgers.PURCHASE,
    pl: t.ids.ledgers.PROFIT_LOSS,
  };
  const gst = opts.gst !== false;
  if (gst) {
    for (const code of ['OUTPUT_CGST', 'OUTPUT_SGST', 'INPUT_CGST', 'INPUT_SGST'] as const) L[code] = t.ids.ledgers[code];
  }
  t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 5_000_000, id: L.cash });
  L.capital = t.addLedger({ name: 'Owner Capital', group: 'CAPITAL_ACCOUNT', openingBalance: opts.capitalOpening ?? -39_000_000 });
  L.bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS', openingBalance: 20_000_000 });
  L.furniture = t.addLedger({ name: 'Furniture', group: 'FIXED_ASSETS', openingBalance: 10_000_000 });
  L.supreme = t.addLedger({ name: 'Supreme Suppliers', group: 'SUNDRY_CREDITORS', gstin: gst ? makeGstin('27', testPan(4)) : undefined, openingBalance: -6_000_000 });
  L.acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: gst ? makeGstin('27', testPan(1)) : undefined });
  L.rent = t.addLedger({ name: 'Office Rent', group: 'INDIRECT_EXPENSES' });
  L.depreciation = t.addLedger({ name: 'Depreciation', group: 'INDIRECT_EXPENSES' });
  L.interest = t.addLedger({ name: 'Interest Received', group: 'INDIRECT_INCOMES' });
  const widget = t.addStockItem({ name: 'Widget', gstRate: 18, hsnSac: '8471', openingQty: 100, openingRate: 1000 });
  const vt = t.ids.voucherTypes;
  const post = (input: VoucherInput): VoucherSaveResult => saveVoucher(t.ctx, { acknowledgeWarnings: true, ...input });
  const V: Record<string, number> = {};
  if (!opts.skipVouchers) {
    V.P1 = post({ voucherTypeId: vt.purchase, date: '2026-04-05', mode: 'item_invoice', partyLedgerId: L.supreme, referenceNo: 'SUP-1', items: [{ itemId: widget, qty: 50, rate: 1200 }] }).id;
    V.S1 = post({ voucherTypeId: vt.sales, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: L.acme, items: [{ itemId: widget, qty: 80, rate: 1500 }], narration: 'April supply' }).id;
    V.R1 = post({ voucherTypeId: vt.receipt, date: '2026-04-15', mode: 'ledger', ledgers: [{ ledgerId: L.bank, amount: 10_000_000 }, { ledgerId: L.acme, amount: -10_000_000 }], narration: 'Part payment' }).id;
    V.P2 = post({ voucherTypeId: vt.payment, date: '2026-04-20', mode: 'ledger', ledgers: [{ ledgerId: L.rent, amount: 2_500_000 }, { ledgerId: L.cash, amount: -2_500_000 }], narration: 'April rent' }).id;
    V.P3 = post({ voucherTypeId: vt.payment, date: '2026-04-25', mode: 'ledger', ledgers: [{ ledgerId: L.supreme, amount: 5_000_000 }, { ledgerId: L.bank, amount: -5_000_000 }] }).id;
    V.C1 = post({ voucherTypeId: vt.contra, date: '2026-04-26', mode: 'ledger', ledgers: [{ ledgerId: L.cash, amount: 1_000_000 }, { ledgerId: L.bank, amount: -1_000_000 }], narration: 'Cash withdrawn' }).id;
    V.J1 = post({ voucherTypeId: vt.journal, date: '2026-04-28', mode: 'ledger', ledgers: [{ ledgerId: L.depreciation, amount: 500_000 }, { ledgerId: L.furniture, amount: -500_000 }], narration: 'Monthly depreciation' }).id;
    V.R2 = post({ voucherTypeId: vt.receipt, date: '2026-04-29', mode: 'ledger', ledgers: [{ ledgerId: L.cash, amount: 200_000 }, { ledgerId: L.interest, amount: -200_000 }], narration: 'FD interest' }).id;
  }
  return { t, L, V, widget, env: () => loadReportEnv(t.db, t.today), post };
}

/** Insert `count` balanced journal-style vouchers directly (for performance tests): Dr expense / Cr cash. */
export function bulkVouchers(t: TestCompany, count: number, opts: { from?: string; ledgers?: number[] } = {}): void {
  const voucherType = t.ids.voucherTypes.journal;
  const ledgers = opts.ledgers ?? [];
  if (ledgers.length < 2) throw new Error('bulkVouchers: need at least two ledgers');
  const start = Date.parse(`${opts.from ?? '2026-04-01'}T00:00:00Z`);
  const ts = new Date().toISOString();
  t.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const date = new Date(start + (i % 300) * 86_400_000).toISOString().slice(0, 10);
      const amount = 10_000 + (i % 97) * 100;
      const vid = t.db.run(
        `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, total_amount, created_at, updated_at)
         VALUES (:guid, :vt, 'journal', :num, :seq, :date, :amt, :ts, :ts)`,
        { guid: `bulk-${i}`, vt: voucherType, num: String(i + 1), seq: i + 1, date, amt: amount, ts },
      ).lastInsertRowid;
      const dr = ledgers[i % ledgers.length];
      const cr = ledgers[(i + 1) % ledgers.length];
      t.db.run('INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date) VALUES (:v, 1, :l, :a, :d)', { v: vid, l: dr, a: amount, d: date });
      t.db.run('INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date) VALUES (:v, 2, :l, :a, :d)', { v: vid, l: cr, a: -amount, d: date });
    }
  });
}

/**
 * Insert `count` item invoices directly (performance tests): alternately a sale (Dr party / Cr sales
 * ledger, 1 unit out) and a purchase (Dr purchase ledger / Cr party, 1 unit in), spread over 360 days,
 * parties and items taken in turn. Each voucher balances; stock moves through inventory_entries.
 */
export function bulkTrade(
  t: TestCompany,
  count: number,
  opts: { parties: number[]; items: number[]; salesLedger: number; purchaseLedger: number; from?: string; /** guid / number prefix for a second batch */ batch?: string },
): void {
  const { parties, items } = opts;
  if (parties.length === 0 || items.length === 0) throw new Error('bulkTrade: need parties and items');
  const start = Date.parse(`${opts.from ?? '2026-04-01'}T00:00:00Z`);
  const ts = new Date().toISOString();
  t.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const date = new Date(start + (i % 360) * 86_400_000).toISOString().slice(0, 10);
      const amount = 10_000 + (i % 97) * 100;
      const sale = i % 2 === 0;
      const vid = t.db.run(
        `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, total_amount, created_at, updated_at)
         VALUES (:guid, :vt, :bt, :num, :seq, :date, :amt, :ts, :ts)`,
        { guid: `${opts.batch ?? ''}trade-${i}`, vt: sale ? t.ids.voucherTypes.sales : t.ids.voucherTypes.purchase, bt: sale ? 'sales' : 'purchase', num: `${opts.batch ?? ''}${i + 1}`, seq: i + 1, date, amt: amount, ts },
      ).lastInsertRowid;
      const party = parties[(i * 7) % parties.length];
      const ledger = sale ? opts.salesLedger : opts.purchaseLedger;
      t.db.run('INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date) VALUES (:v, 1, :l, :a, :d)', { v: vid, l: party, a: sale ? amount : -amount, d: date });
      t.db.run('INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date) VALUES (:v, 2, :l, :a, :d)', { v: vid, l: ledger, a: sale ? -amount : amount, d: date });
      t.db.run('INSERT INTO inventory_entries (voucher_id, line_no, item_id, qty, rate, amount, date) VALUES (:v, 1, :it, :q, :r, :a, :d)', {
        v: vid,
        it: items[i % items.length],
        q: sale ? -1 : 1,
        r: amount / 100,
        a: amount,
        d: date,
      });
    }
  });
}

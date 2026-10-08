/**
 * Test scenario for the stock reports (used by *.test.ts only). Every voucher is posted through the
 * real vouchers service, so the reports read exactly what the posting engine writes.
 *
 * Company: GST, Maharashtra, books from 01-Apr-2026, working date 30-Jun-2026, with batches, expiry,
 * order processing, tracking numbers and multiple godowns on.
 *
 * Masters
 *   groups      Household › Kitchenware ; Grains
 *   category    Brand X (A, F)
 *   godowns     Main Location ; Shop
 *   items       A Steel Tumbler  Nos  avg cost  Kitchenware  opening 10 @ ₹100  reorder level 50, min order 25
 *               F Copper Bottle  Nos  FIFO      Kitchenware  opening 10 @ ₹100
 *               G Gift Hamper    Nos  avg cost  Kitchenware  (made by a stock journal)
 *               R Basmati Rice   Kg   avg cost  Grains       batches with expiry
 *               N Cable Roll     Nos  avg cost  (no group)   purchase price ₹90 (sold before any purchase)
 *               S Spare Part     Nos  (no group, never moves)
 *   parties     Acme Traders, Metro Retail (customers) · Supreme Suppliers, Bharat Wholesale (suppliers)
 *
 * Vouchers (all regular unless noted) — April is the inventory README's worked example for A (Average
 * Cost) and runs F (FIFO) through the same trades:
 *   05-Apr  Purchase  Supreme   A 20 @ 115 · F 20 @ 115
 *   10-Apr  Sales     Acme      A 15 @ 150 · F 15 @ 150
 *   15-Apr  Purchase  Bharat    A 10 @ 133.33 · F 10 @ 133.33
 *   20-Apr  Credit Note Acme    A 3 @ 150 · F 3 @ 150                (sales return)
 *   25-Apr  Stock Journal       A 8 consumed → G 4 produced
 *   28-Apr  Sales     Metro     A 12 @ 160 · F 12 @ 160
 *   05-May  Delivery Note Acme  A 5 @ 160            (no. 1)
 *   10-May  Sales     Acme      A 5 @ 160, billing delivery note 1 (moves no stock)
 *   12-May  Physical Stock      A counted 2 (book 3) → −1
 *   15-May  Purchase Order Supreme  A 50 @ 120, due 25-May  (no. 1)
 *   18-May  Sales Order Metro   A 10 @ 170                (no. 1)
 *   20-May  Receipt Note Supreme A 20 @ 120 against purchase order 1
 *   22-May  Delivery Note Metro A 4 @ 170 against sales order 1   (no. 2)
 *   01-Jun  Purchase  Bharat    R batch B1 100 Kg @ 60 (mfg 15-Jan, exp 15-Jul-2026) · B2 50 Kg @ 62 (exp 31-Dec-2026)
 *   05-Jun  Sales     Metro     N 5 @ 200            (negative stock)
 *   10-Jun  Sales     Metro     R batch B1 30 Kg @ 80
 *   15-Jun  Stock Journal       A 6 Main Location → Shop (transfer)
 *   20-Jun  Sales (optional)    Acme A 1 @ 999       (must never count)
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { saveGodown, saveStockCategory, saveStockGroup } from '../inventory/masters.ts';
import { saveVoucher } from '../vouchers/service.ts';

export interface StockKit {
  t: TestCompany;
  vt: Record<VoucherBaseType, number>;
  L: { acme: number; metro: number; supreme: number; bharat: number };
  I: { A: number; F: number; G: number; R: number; N: number; S: number };
  groups: { household: number; kitchen: number; grains: number };
  categoryId: number;
  godowns: { main: number; shop: number };
  /** Voucher ids by short name. */
  V: Record<string, number>;
}

export function post(k: Pick<StockKit, 't'>, input: VoucherInput): VoucherSaveResult {
  return saveVoucher(k.t.ctx, { acknowledgeWarnings: true, ...input });
}

/** Masters only (no vouchers). */
export function stockMasters(): Omit<StockKit, 'V'> {
  const t = createTestCompany({
    today: '2026-06-30',
    booksFrom: '2026-04-01',
    features: { batches: true, expiryDates: true, orderProcessing: true, trackingNumbers: true, multipleGodowns: true, rejectionNotes: true },
  });
  const ctx = t.ctx;
  const household = saveStockGroup(ctx, { name: 'Household' }).id;
  const kitchen = saveStockGroup(ctx, { name: 'Kitchenware', parentId: household }).id;
  const grains = saveStockGroup(ctx, { name: 'Grains' }).id;
  const categoryId = saveStockCategory(ctx, { name: 'Brand X' }).id;
  const shop = saveGodown(ctx, { name: 'Shop' }).id;
  const L = {
    acme: t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(1)) }),
    metro: t.addLedger({ name: 'Metro Retail', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(2)) }),
    supreme: t.addLedger({ name: 'Supreme Suppliers', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(3)) }),
    bharat: t.addLedger({ name: 'Bharat Wholesale', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(4)) }),
  };
  const I = {
    A: t.addStockItem({
      name: 'Steel Tumbler',
      gstRate: 18,
      hsnSac: '7323',
      groupId: kitchen,
      categoryId,
      openingQty: 10,
      openingRate: 100,
      reorderLevel: 50,
      columns: { min_order_qty: 25 },
    }),
    F: t.addStockItem({ name: 'Copper Bottle', gstRate: 18, hsnSac: '7418', groupId: kitchen, categoryId, openingQty: 10, openingRate: 100, costingMethod: 'fifo' }),
    G: t.addStockItem({ name: 'Gift Hamper', gstRate: 18, hsnSac: '7323', groupId: kitchen }),
    R: t.addStockItem({ name: 'Basmati Rice', unit: 'Kg', gstRate: 5, hsnSac: '1006', groupId: grains, maintainBatches: true, columns: { use_expiry: 1, track_mfg_date: 1 } }),
    N: t.addStockItem({ name: 'Cable Roll', gstRate: 18, hsnSac: '8544', purchasePrice: 9000 }),
    S: t.addStockItem({ name: 'Spare Part', gstRate: 18, hsnSac: '8487' }),
  };
  return {
    t,
    vt: t.ids.voucherTypes,
    L,
    I,
    groups: { household, kitchen, grains },
    categoryId,
    godowns: { main: t.ids.mainGodownId, shop },
  };
}

type Line = NonNullable<VoucherInput['items']>[number];

export function invoice(k: Omit<StockKit, 'V'>, base: 'sales' | 'purchase' | 'credit_note', date: string, party: number, items: Line[], over: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: k.vt[base],
    date,
    mode: 'item_invoice',
    partyLedgerId: party,
    referenceNo: base === 'purchase' ? `INV-${date}` : undefined,
    items,
    ...over,
  };
}

export function inventoryVoucher(k: Omit<StockKit, 'V'>, base: VoucherBaseType, date: string, items: Line[], over: Partial<VoucherInput> = {}): VoucherInput {
  return { voucherTypeId: k.vt[base], date, mode: 'inventory', items, ...over };
}

/** The full scenario described at the top of this file. */
export function stockScenario(): StockKit {
  const m = stockMasters();
  const { L, I } = m;
  const k = { ...m, V: {} as Record<string, number> };
  const V = k.V;
  const p = (name: string, input: VoucherInput): void => {
    V[name] = post(k, input).id;
  };
  p('pur1', invoice(m, 'purchase', '2026-04-05', L.supreme, [{ itemId: I.A, qty: 20, rate: 115 }, { itemId: I.F, qty: 20, rate: 115 }]));
  p('sal1', invoice(m, 'sales', '2026-04-10', L.acme, [{ itemId: I.A, qty: 15, rate: 150 }, { itemId: I.F, qty: 15, rate: 150 }]));
  p('pur2', invoice(m, 'purchase', '2026-04-15', L.bharat, [{ itemId: I.A, qty: 10, rate: 133.33 }, { itemId: I.F, qty: 10, rate: 133.33 }]));
  p('cn1', invoice(m, 'credit_note', '2026-04-20', L.acme, [{ itemId: I.A, qty: 3, rate: 150 }, { itemId: I.F, qty: 3, rate: 150 }]));
  p('sj1', inventoryVoucher(m, 'stock_journal', '2026-04-25', [{ itemId: I.A, qty: 8, rate: 0, isConsumption: true }, { itemId: I.G, qty: 4, rate: 0 }]));
  p('sal2', invoice(m, 'sales', '2026-04-28', L.metro, [{ itemId: I.A, qty: 12, rate: 160 }, { itemId: I.F, qty: 12, rate: 160 }]));
  p('dn1', inventoryVoucher(m, 'delivery_note', '2026-05-05', [{ itemId: I.A, qty: 5, rate: 160 }], { partyLedgerId: L.acme }));
  p('sal3', invoice(m, 'sales', '2026-05-10', L.acme, [{ itemId: I.A, qty: 5, rate: 160, trackingRef: '1' }]));
  p('phy1', inventoryVoucher(m, 'physical_stock', '2026-05-12', [{ itemId: I.A, qty: 2, rate: 0 }]));
  p('po1', inventoryVoucher(m, 'purchase_order', '2026-05-15', [{ itemId: I.A, qty: 50, rate: 120 }], { partyLedgerId: L.supreme, effectiveDate: '2026-05-25' }));
  p('so1', inventoryVoucher(m, 'sales_order', '2026-05-18', [{ itemId: I.A, qty: 10, rate: 170 }], { partyLedgerId: L.metro }));
  p('rn1', inventoryVoucher(m, 'receipt_note', '2026-05-20', [{ itemId: I.A, qty: 20, rate: 120, orderRef: '1' }], { partyLedgerId: L.supreme }));
  p('dn2', inventoryVoucher(m, 'delivery_note', '2026-05-22', [{ itemId: I.A, qty: 4, rate: 170, orderRef: '1' }], { partyLedgerId: L.metro }));
  p(
    'pur3',
    invoice(m, 'purchase', '2026-06-01', L.bharat, [
      { itemId: I.R, qty: 100, rate: 60, batchName: 'B1', mfgDate: '2026-01-15', expiryDate: '2026-07-15' },
      { itemId: I.R, qty: 50, rate: 62, batchName: 'B2', expiryDate: '2026-12-31' },
    ]),
  );
  p('sal4', invoice(m, 'sales', '2026-06-05', L.metro, [{ itemId: I.N, qty: 5, rate: 200 }]));
  p('sal5', invoice(m, 'sales', '2026-06-10', L.metro, [{ itemId: I.R, qty: 30, rate: 80, batchName: 'B1' }]));
  p(
    'sj2',
    inventoryVoucher(m, 'stock_journal', '2026-06-15', [
      { itemId: I.A, qty: 6, rate: 0, isConsumption: true, godownId: m.godowns.main },
      { itemId: I.A, qty: 6, rate: 0, godownId: m.godowns.shop },
    ]),
  );
  p('opt1', invoice(m, 'sales', '2026-06-20', L.acme, [{ itemId: I.A, qty: 1, rate: 999 }], { isOptional: true }));
  return k;
}

export const APRIL = { from: '2026-04-01', to: '2026-04-30' } as const;

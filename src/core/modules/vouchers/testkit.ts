/**
 * Test helpers for the vouchers module (used by *.test.ts only). A GST company in Maharashtra (27)
 * dated 15-Apr-2026 with a few parties, items and charge ledgers.
 */
import assert from 'node:assert/strict';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { VoucherInput, VoucherRuleErrorDetails, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany, type TestCompanyOptions } from '../../testing/fixtures.ts';
import { saveVoucher } from './service.ts';

export interface Kit {
  t: TestCompany;
  vt: Record<VoucherBaseType, number>;
  /** Ledger ids by short name. */
  L: Record<string, number>;
  /** Item ids by short name. */
  I: Record<string, number>;
}

/**
 * Masters:
 *  customers: acme (27, regular, 30 days), blr (29, regular), walkin (27, unregistered), export (overseas), sez (27, sez)
 *  suppliers: supplier (27, regular, 45 days), gta (27, regular transporter)
 *  ledgers: freight (income, apportioned by value), discount (expense, non-GST), consult (income, SAC 998311 @18% services),
 *           gtaFreight (direct expense, SAC 996511 @5%, services), bank, cash, sales, purchase, roundOff
 *  items: rice (5%, HSN 1006, 100 Nos @ ₹50), mixer (18%, HSN 8509, 50 Nos @ ₹150), noRate (no GST rate)
 */
export function setupKit(opts: TestCompanyOptions = {}): Kit {
  const t = createTestCompany({ today: '2026-04-15', ...opts });
  const gst = opts.gst !== false;
  const L: Record<string, number> = {
    cash: t.ids.ledgers.CASH,
    sales: t.ids.ledgers.SALES,
    purchase: t.ids.ledgers.PURCHASE,
    roundOff: t.ids.ledgers.ROUND_OFF,
  };
  const home = opts.stateCode ?? '27';
  L.acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: gst ? makeGstin(home, testPan(1)) : undefined, creditDays: 30 });
  L.blr = t.addLedger({ name: 'Bangalore Retail', group: 'SUNDRY_DEBTORS', gstin: makeGstin('29', testPan(2)) });
  L.walkin = t.addLedger({ name: 'Walk-in Customer', group: 'SUNDRY_DEBTORS', stateCode: home });
  L.export = t.addLedger({ name: 'Global Imports LLC', group: 'SUNDRY_DEBTORS', registrationType: 'overseas', columns: { country: 'USA', state_code: null } });
  L.sez = t.addLedger({ name: 'SEZ Unit One', group: 'SUNDRY_DEBTORS', gstin: makeGstin(home, testPan(3)), registrationType: 'sez' });
  L.supplier = t.addLedger({ name: 'Supreme Suppliers', group: 'SUNDRY_CREDITORS', gstin: makeGstin(home, testPan(4)), creditDays: 45 });
  L.gta = t.addLedger({ name: 'Speedy Transport', group: 'SUNDRY_CREDITORS', gstin: makeGstin(home, testPan(5)) });
  L.freight = t.addLedger({ name: 'Freight Outward', group: 'INDIRECT_INCOMES', includeInAssessable: 'goods', columns: { appropriate_by: 'value' } });
  L.discount = t.addLedger({ name: 'Discount Allowed', group: 'INDIRECT_EXPENSES' });
  L.bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS', bank: { accountNo: '50100012345678', ifsc: 'HDFC0000001' } });
  L.rent = t.addLedger({ name: 'Office Rent', group: 'INDIRECT_EXPENSES' });
  L.capital = t.addLedger({ name: 'Owner Capital', group: 'CAPITAL_ACCOUNT' });
  if (gst) {
    L.consult = t.addLedger({ name: 'Consultancy Income', group: 'DIRECT_INCOMES', gstRate: 18, hsnSac: '998311', supplyType: 'services' });
    L.gtaFreight = t.addLedger({ name: 'Freight Inward (GTA)', group: 'DIRECT_EXPENSES', gstRate: 5, hsnSac: '996511', supplyType: 'services' });
    for (const code of ['OUTPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_CESS', 'INPUT_IGST', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_CESS', 'RCM_IGST', 'RCM_CGST', 'RCM_SGST'] as const) {
      L[code] = t.ids.ledgers[code];
    }
  }
  const I: Record<string, number> = {
    rice: t.addStockItem({ name: 'Rice Bag', gstRate: 5, hsnSac: '1006', openingQty: 100, openingRate: 50 }),
    mixer: t.addStockItem({ name: 'Mixer Grinder', gstRate: 18, hsnSac: '8509', openingQty: 50, openingRate: 150 }),
    noRate: t.addStockItem({ name: 'Unclassified Item', openingQty: 10, openingRate: 10 }),
  };
  return { t, vt: t.ids.voucherTypes, L, I };
}

/** Save with warnings acknowledged (most tests are about postings, not confirmations). */
export function save(k: Kit, input: VoucherInput): VoucherSaveResult {
  return saveVoucher(k.t.ctx, { acknowledgeWarnings: true, ...input });
}

/** Ledger entries of a voucher: ledger name → summed signed amount. */
export function entryMap(k: Kit, voucherId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of k.t.db.all<{ name: string; amount: number }>(
    'SELECT l.name, le.amount FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE le.voucher_id = :id ORDER BY le.line_no',
    { id: voucherId },
  )) {
    out[r.name] = (out[r.name] ?? 0) + r.amount;
  }
  return out;
}

export function entrySum(k: Kit, voucherId: number): number {
  return k.t.db.value<number>('SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE voucher_id = :id', { id: voucherId }) ?? 0;
}

export interface GstLineRow {
  item_id: number | null;
  ledger_id: number | null;
  hsn_sac: string | null;
  uqc: string | null;
  qty: number | null;
  supply_type: string;
  taxability: string;
  rate: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  is_reverse_charge: number;
  itc_eligibility: string | null;
  affects_books: number;
}

export function gstLines(k: Kit, voucherId: number): GstLineRow[] {
  return k.t.db.all<GstLineRow>('SELECT * FROM gst_lines WHERE voucher_id = :id ORDER BY line_no', { id: voucherId });
}

export function header(k: Kit, voucherId: number): Record<string, unknown> {
  return k.t.db.get('SELECT * FROM vouchers WHERE id = :id', { id: voucherId }) ?? {};
}

export function stockOf(k: Kit, itemId: number): number {
  const opening = k.t.db.value<number>('SELECT COALESCE(SUM(qty), 0) FROM stock_openings WHERE item_id = :id', { id: itemId }) ?? 0;
  const moved = k.t.db.value<number>('SELECT COALESCE(SUM(qty), 0) FROM inventory_entries WHERE item_id = :id AND affects_stock = 1', { id: itemId }) ?? 0;
  return opening + moved;
}

export function bills(k: Kit, voucherId: number): Array<{ ref_type: string; bill_name: string | null; amount: number; due_date: string | null; ledger_id: number }> {
  return k.t.db.all('SELECT ref_type, bill_name, amount, due_date, ledger_id FROM bill_allocations WHERE voucher_id = :id ORDER BY id', { id: voucherId });
}

/** Assert fn throws an AppError with this code (and message pattern); returns the error. */
export function throwsApp(fn: () => unknown, code: string, re?: RegExp): AppError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AppError, `expected AppError ${code}, got ${String(caught)}`);
  const err = caught as AppError;
  assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
  if (re) assert.match(err.message, re);
  return err;
}

export function ruleDetails(err: AppError): VoucherRuleErrorDetails {
  return err.details as VoucherRuleErrorDetails;
}

/** Sales invoice input helper. */
export function salesInput(k: Kit, over: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: k.vt.sales,
    date: k.t.today,
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }],
    ...over,
  };
}

export function purchaseInput(k: Kit, over: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: k.vt.purchase,
    date: k.t.today,
    mode: 'item_invoice',
    partyLedgerId: k.L.supplier,
    referenceNo: 'SUP-101',
    items: [{ itemId: k.I.rice, qty: 20, rate: 80 }],
    ...over,
  };
}

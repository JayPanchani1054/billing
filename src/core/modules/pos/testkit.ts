/**
 * Test helpers for the pos module (used by *.test.ts only). A GST company in Maharashtra (27) dated
 * 15-Apr-2026 with POS invoicing on (the seed creates POS Sales, POS Return, the Cash tender and the
 * exchange-credit mode), a bank ledger with UPI and card tenders, a customer and three items:
 *   soap   18 %, MRP ₹59 (5,900 paise), selling price ₹42.37 ex-GST, barcode 8901234567890, part no. SP-01
 *   rice   5 %, ₹50 per Kg (unit Kg, 3 decimals), alias 'chawal'
 *   pen    18 %, ₹10, no MRP
 */
import assert from 'node:assert/strict';
import type { PosTenderInput, VoucherPosInput } from '../../../shared/types/pos.ts';
import type { ItemLineInput, VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { createTestCompany, type TestCompany, type TestCompanyOptions } from '../../testing/fixtures.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { saveTenderMode } from './store.ts';

export interface PosKit {
  t: TestCompany;
  /** POS Sales / POS Return voucher type ids. */
  saleType: number;
  returnType: number;
  /** Tender mode ids. */
  M: { cash: number; upi: number; card: number; exchange: number };
  L: { cash: number; bank: number; cardClearing: number; customer: number; sales: number; exchange: number };
  I: { soap: number; rice: number; pen: number };
}

export function posKit(opts: TestCompanyOptions = {}): PosKit {
  const t = createTestCompany({ today: '2026-04-15', ...opts, features: { pos: true, ...(opts.features ?? {}) } });
  const db = t.db;
  const typeId = (name: string): number => {
    const id = db.value<number>('SELECT id FROM voucher_types WHERE name = :name', { name });
    assert.ok(id, `voucher type ${name}`);
    return id;
  };
  const saleType = typeId('POS Sales');
  const returnType = typeId('POS Return');
  const bank = t.addLedger({ name: 'HDFC Current A/c', group: 'BANK_ACCOUNTS', bank: { accountNo: '50100012345678', ifsc: 'HDFC0000001' } });
  const cardClearing = t.addLedger({ name: 'Card Settlements Receivable', group: 'CURRENT_ASSETS' });
  const customer = t.addLedger({ name: 'Ramesh Kumar', group: 'SUNDRY_DEBTORS', stateCode: '27', registrationType: 'consumer', mobile: '98765 43210' });
  const mode = (kind: string): number => {
    const id = db.value<number>('SELECT id FROM pos_tender_modes WHERE kind = :kind ORDER BY id LIMIT 1', { kind });
    assert.ok(id, `tender mode ${kind}`);
    return id;
  };
  const upi = saveTenderMode(t.ctx, { name: 'UPI', kind: 'upi', ledgerId: bank }).id;
  const card = saveTenderMode(t.ctx, { name: 'Card', kind: 'card', ledgerId: cardClearing }).id;
  const I = {
    soap: t.addStockItem({ name: 'Bath Soap 100g', gstRate: 18, hsnSac: '3401', openingQty: 100, openingRate: 30, mrp: 5900, sellingPrice: 4237, barcode: '8901234567890', partNo: 'SP-01' }),
    rice: t.addStockItem({ name: 'Sona Masoori Rice', unit: 'Kg', gstRate: 5, hsnSac: '1006', openingQty: 200, openingRate: 40, sellingPrice: 5000, alias: 'chawal' }),
    pen: t.addStockItem({ name: 'Ball Pen', gstRate: 18, hsnSac: '9608', openingQty: 500, openingRate: 5, sellingPrice: 1000 }),
  };
  return {
    t,
    saleType,
    returnType,
    M: { cash: mode('cash'), upi, card, exchange: mode('exchange') },
    L: {
      cash: t.ids.ledgers.CASH,
      bank,
      cardClearing,
      customer,
      sales: t.ids.ledgers.SALES,
      exchange: db.value<number>(`SELECT id FROM ledgers WHERE reserved_code = 'POS_EXCHANGE'`) ?? 0,
    },
    I,
  };
}

export function line(itemId: number, qty: number, rate: number, extra: Partial<ItemLineInput> = {}): ItemLineInput {
  return { itemId, qty, rate, ...extra };
}

/** A POS bill input (walk-in Cash party unless `partyLedgerId` is given). */
export function bill(k: PosKit, items: ItemLineInput[], posBill: VoucherPosInput, extra: Partial<VoucherInput> = {}): VoucherInput {
  return { voucherTypeId: k.saleType, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.cash, items, posBill, ...extra };
}

export function tender(modeId: number, amount: number, extra: Partial<PosTenderInput> = {}): PosTenderInput {
  return { modeId, amount, ...extra };
}

export function saveBill(k: PosKit, input: VoucherInput): VoucherSaveResult {
  return saveVoucher(k.t.ctx, { acknowledgeWarnings: true, ...input });
}

/** Ledger name → summed signed amount of a voucher. */
export function entries(k: PosKit, voucherId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of k.t.db.all<{ name: string; amount: number }>(
    'SELECT l.name, le.amount FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE le.voucher_id = :id ORDER BY le.line_no',
    { id: voucherId },
  )) {
    out[r.name] = (out[r.name] ?? 0) + r.amount;
  }
  return out;
}

export function entrySum(k: PosKit, voucherId: number): number {
  return k.t.db.value<number>('SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE voucher_id = :id', { id: voucherId }) ?? 0;
}

/** Trial balance Σ (books) must be 0. */
export function trialSum(k: PosKit): number {
  return k.t.db.value<number>('SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE affects_books = 1') ?? 0;
}

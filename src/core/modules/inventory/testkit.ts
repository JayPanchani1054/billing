/**
 * Test helpers for the inventory module: write vouchers + inventory_entries rows directly with SQL
 * (the posting engine is built separately), and small shortcuts for common masters.
 * Not a test file itself (no `.test.ts`), imported by the module's tests only.
 */
import { randomUUID } from 'node:crypto';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { lineAmount } from '../../../shared/money.ts';
import type { TestCompany } from '../../testing/fixtures.ts';

export interface StockLine {
  itemId: number;
  /** Signed base-unit quantity: inward +, outward −. */
  qty: number;
  /** Rupees per unit. */
  rate?: number;
  /** Paise (default |qty| × rate). */
  amount?: number;
  godownId?: number | null;
  batchName?: string;
  mfgDate?: string;
  expiryDate?: string;
  isConsumption?: boolean;
  affectsStock?: boolean;
}

export interface StockVoucherSpec {
  baseType: VoucherBaseType;
  date: string;
  lines: StockLine[];
  optional?: boolean;
  cancelled?: boolean;
  postDated?: boolean;
  priceLevelId?: number;
}

/** Insert a voucher with inventory lines; returns the voucher id. Godown defaults to Main Location. */
export function postStock(t: TestCompany, spec: StockVoucherSpec): number {
  const ts = t.clock.now().toISOString();
  return t.db.transaction(() => {
    const voucherId = t.db.run(
      `INSERT INTO vouchers (guid, voucher_type_id, base_type, date, is_optional, is_post_dated, is_cancelled, affects_books,
                             affects_stock, price_level_id, created_at, updated_at)
       VALUES (:guid, :vt, :base, :date, :opt, :pd, :cancel, :books, 1, :pl, :ts, :ts)`,
      {
        guid: randomUUID(),
        vt: t.ids.voucherTypes[spec.baseType],
        base: spec.baseType,
        date: spec.date,
        opt: spec.optional ?? false,
        pd: spec.postDated ?? false,
        cancel: spec.cancelled ?? false,
        books: !(spec.optional || spec.cancelled),
        pl: spec.priceLevelId,
        ts,
      },
    ).lastInsertRowid;
    spec.lines.forEach((l, i) => {
      const rate = l.rate ?? 0;
      t.db.run(
        `INSERT INTO inventory_entries (voucher_id, line_no, item_id, godown_id, batch_name, mfg_date, expiry_date, qty, billed_qty,
                                        rate, amount, is_consumption, date, affects_stock)
         VALUES (:v, :line, :item, :godown, :batch, :mfg, :exp, :qty, :billed, :rate, :amount, :cons, :date, :affects)`,
        {
          v: voucherId,
          line: i + 1,
          item: l.itemId,
          godown: l.godownId === undefined ? t.ids.mainGodownId : l.godownId,
          batch: l.batchName,
          mfg: l.mfgDate,
          exp: l.expiryDate,
          qty: l.qty,
          billed: Math.abs(l.qty),
          rate,
          amount: l.amount ?? lineAmount(Math.abs(l.qty), rate),
          cons: l.isConsumption ?? (spec.baseType === 'stock_journal' && l.qty < 0),
          date: spec.date,
          affects: l.affectsStock ?? true,
        },
      );
    });
    return voucherId;
  });
}

type Extra = Omit<StockLine, 'itemId' | 'qty' | 'rate'> & Partial<Pick<StockVoucherSpec, 'optional' | 'cancelled' | 'postDated'>>;

const one = (t: TestCompany, baseType: VoucherBaseType, date: string, itemId: number, qty: number, rate: number, extra: Extra = {}): number => {
  const { optional, cancelled, postDated, ...line } = extra;
  return postStock(t, { baseType, date, optional, cancelled, postDated, lines: [{ itemId, qty, rate, ...line }] });
};

export const purchase = (t: TestCompany, date: string, itemId: number, qty: number, rate: number, extra?: Extra): number =>
  one(t, 'purchase', date, itemId, Math.abs(qty), rate, extra);
export const sale = (t: TestCompany, date: string, itemId: number, qty: number, rate: number, extra?: Extra): number =>
  one(t, 'sales', date, itemId, -Math.abs(qty), rate, extra);
export const salesReturn = (t: TestCompany, date: string, itemId: number, qty: number, rate: number, extra?: Extra): number =>
  one(t, 'credit_note', date, itemId, Math.abs(qty), rate, extra);

/** Stock journal: consume `from` lines (qty given positive), produce `to` lines. */
export function stockJournal(
  t: TestCompany,
  date: string,
  from: Array<{ itemId: number; qty: number; godownId?: number }>,
  to: Array<{ itemId: number; qty: number; amount?: number; godownId?: number }>,
): number {
  return postStock(t, {
    baseType: 'stock_journal',
    date,
    lines: [
      ...from.map((f) => ({ itemId: f.itemId, qty: -Math.abs(f.qty), amount: 0, godownId: f.godownId, isConsumption: true })),
      ...to.map((p) => ({ itemId: p.itemId, qty: Math.abs(p.qty), amount: p.amount ?? 0, godownId: p.godownId })),
    ],
  });
}

/** Add a godown directly (multipleGodowns tests). */
export function addGodown(t: TestCompany, name: string, parentId: number | null = null): number {
  const ts = t.clock.now().toISOString();
  return t.db.run(
    `INSERT INTO godowns (guid, name, parent_id, created_at, updated_at) VALUES (:g, :name, :parent, :ts, :ts)`,
    { g: randomUUID(), name, parent: parentId, ts },
  ).lastInsertRowid;
}

/** Audit rows for an entity type, oldest first. */
export function auditRows(t: TestCompany, entityType: string): Array<{
  action: string;
  entity_id: number;
  entity_label: string;
  before_json: string | null;
  after_json: string | null;
  username: string;
}> {
  return t.db.all('SELECT action, entity_id, entity_label, before_json, after_json, username FROM audit_log WHERE entity_type = :t ORDER BY id', {
    t: entityType,
  });
}

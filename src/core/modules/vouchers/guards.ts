/**
 * Business guards (F12 › guards: allow | warn | block) evaluated on a posting plan:
 *  - negative stock: per item + godown (+ batch when the line has one), closing quantity as of the
 *    voucher date
 *  - negative cash: Cash-in-Hand ledgers, closing balance as of the voucher date
 *  - credit limit: party balance after the voucher vs ledgers.credit_limit
 *  - duplicate supplier invoice: purchase with the same party + reference no. in the same FY
 * 'warn' → level 'confirm' (save asks for confirmation); 'block' → level 'block' (cannot be saved).
 * The voucher being altered is always excluded from the existing balances.
 */
import { financialYear, formatDate } from '../../../shared/dates.ts';
import { formatMoney, formatQty } from '../../../shared/format.ts';
import type { GuardPolicy } from '../../../shared/settings.ts';
import type { VoucherWarning } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';
import type { Masters } from './masters.ts';

export interface GuardEntry {
  ledgerId: number;
  amount: number;
}

export interface GuardStockLine {
  /** 1-based input line number (for the warning path items[lineNo − 1]). */
  lineNo?: number;
  itemId: number;
  godownId: number;
  batchName?: string | null;
  qty: number;
  affectsStock: boolean;
}

export interface GuardInput {
  db: Db;
  masters: Masters;
  policies: { negativeStock: GuardPolicy; negativeCash: GuardPolicy; creditLimit: GuardPolicy; duplicateSupplierInvoice: GuardPolicy };
  date: string;
  today: string;
  fyStartMonth: number;
  baseType: string;
  excludeVoucherId: number | null;
  partyLedgerId: number | null;
  referenceNo: string | null;
  entries: readonly GuardEntry[];
  stock: readonly GuardStockLine[];
  inventoryOn: boolean;
}

const money = (p: number): string => formatMoney(p, { symbol: true });

/** Closing quantity of an item in a godown as of `date` (books filter), excluding one voucher. */
export function stockQtyAsOf(
  db: Db,
  q: { itemId: number; godownId: number; batchName?: string | null; date: string; today: string; excludeVoucherId: number | null; byBatch?: boolean },
): number {
  const byBatch = q.byBatch === true;
  const opening =
    db.value<number>(
      `SELECT COALESCE(SUM(qty), 0) FROM stock_openings
        WHERE item_id = :item AND godown_id = :godown AND (:byBatch = 0 OR batch_name IS :batch)`,
      { item: q.itemId, godown: q.godownId, byBatch: byBatch ? 1 : 0, batch: q.batchName ?? null },
    ) ?? 0;
  const moved =
    db.value<number>(
      `SELECT COALESCE(SUM(qty), 0) FROM inventory_entries
        WHERE item_id = :item AND godown_id = :godown AND affects_stock = 1
          AND (is_post_dated = 0 OR date <= :today) AND date <= :date AND voucher_id <> :ex
          AND (:byBatch = 0 OR batch_name IS :batch)`,
      { item: q.itemId, godown: q.godownId, today: q.today, date: q.date, ex: q.excludeVoucherId ?? 0, byBatch: byBatch ? 1 : 0, batch: q.batchName ?? null },
    ) ?? 0;
  return Math.round((Number(opening) + Number(moved)) * 1e6) / 1e6;
}

/** Ledger closing balance as of `date` (books filter), excluding one voucher. Signed Dr +. */
export function ledgerBalanceAsOf(db: Db, ledgerId: number, date: string, today: string, excludeVoucherId: number | null): number {
  const opening = db.value<number>('SELECT opening_balance FROM ledgers WHERE id = :id', { id: ledgerId }) ?? 0;
  const moved =
    db.value<number>(
      `SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
        WHERE ledger_id = :id AND affects_books = 1 AND (is_post_dated = 0 OR date <= :today) AND date <= :date AND voucher_id <> :ex`,
      { id: ledgerId, today, date, ex: excludeVoucherId ?? 0 },
    ) ?? 0;
  return Number(opening) + Number(moved);
}

export function runGuards(g: GuardInput): VoucherWarning[] {
  const out: VoucherWarning[] = [];
  const add = (policy: GuardPolicy, w: Omit<VoucherWarning, 'blocking' | 'level'>): void => {
    if (policy === 'allow') return;
    const block = policy === 'block';
    out.push({ ...w, blocking: block, level: block ? 'block' : 'confirm' });
  };

  // ── Negative stock (per item + godown, and per batch for batch lines) ──
  if (g.policies.negativeStock !== 'allow' && g.inventoryOn) {
    const net = new Map<string, { itemId: number; godownId: number; batchName: string | null; qty: number; lineNo: number | undefined }>();
    for (const l of g.stock) {
      if (!l.affectsStock) continue;
      const batchName = l.batchName ?? null;
      const key = `${l.itemId}|${l.godownId}|${batchName ?? ''}`;
      const cur = net.get(key) ?? { itemId: l.itemId, godownId: l.godownId, batchName, qty: 0, lineNo: l.lineNo };
      cur.qty += l.qty;
      net.set(key, cur);
    }
    for (const n of net.values()) {
      if (n.qty >= 0) continue;
      const available = stockQtyAsOf(g.db, {
        itemId: n.itemId,
        godownId: n.godownId,
        batchName: n.batchName,
        byBatch: n.batchName !== null,
        date: g.date,
        today: g.today,
        excludeVoucherId: g.excludeVoucherId,
      });
      const closing = Math.round((available + n.qty) * 1e6) / 1e6;
      if (closing < 0) {
        const item = g.masters.item(n.itemId);
        const godown = g.masters.godown(n.godownId);
        const dp = Math.max(0, Math.min(6, item.unit_decimals));
        const where = n.batchName !== null ? `${item.name} (batch ${n.batchName}) in ${godown.name}` : `${item.name} in ${godown.name}`;
        const w: Omit<VoucherWarning, 'blocking' | 'level'> = {
          code: 'negative_stock',
          message: `Stock of ${where} will go negative: ${formatQty(available, dp, item.unit_symbol)} available, ${formatQty(-n.qty, dp, item.unit_symbol)} required.`,
        };
        if (n.lineNo !== undefined) w.path = `items[${n.lineNo - 1}]`;
        add(g.policies.negativeStock, w);
      }
    }
  }

  // ── Net effect of this voucher per ledger ──
  const perLedger = new Map<number, number>();
  for (const e of g.entries) perLedger.set(e.ledgerId, (perLedger.get(e.ledgerId) ?? 0) + e.amount);

  // ── Negative cash ──
  if (g.policies.negativeCash !== 'allow') {
    for (const [ledgerId, amount] of perLedger) {
      if (amount >= 0) continue;
      const L = g.masters.ledger(ledgerId);
      if (!L.isCash) continue;
      const before = ledgerBalanceAsOf(g.db, ledgerId, g.date, g.today, g.excludeVoucherId);
      const after = before + amount;
      if (after < 0) {
        add(g.policies.negativeCash, {
          code: 'negative_cash',
          message: `${L.name} will go negative: balance ${money(before)} before this voucher, ${money(after)} after it.`,
        });
      }
    }
  }

  // ── Credit limit ──
  if (g.policies.creditLimit !== 'allow' && g.partyLedgerId !== null) {
    const amount = perLedger.get(g.partyLedgerId) ?? 0;
    const L = g.masters.ledger(g.partyLedgerId);
    const limit = L.row.credit_limit;
    if (amount > 0 && limit !== null && limit > 0) {
      const after = ledgerBalanceAsOf(g.db, L.id, g.date, g.today, g.excludeVoucherId) + amount;
      if (after > limit) {
        add(g.policies.creditLimit, {
          code: 'credit_limit',
          message: `Credit limit of ${money(limit)} for ${L.name} will be exceeded: balance after this voucher is ${money(after)} Dr.`,
          path: 'partyLedgerId',
        });
      }
    }
  }

  // ── Duplicate supplier invoice number ──
  if (g.policies.duplicateSupplierInvoice !== 'allow' && g.baseType === 'purchase' && g.partyLedgerId !== null && g.referenceNo) {
    const fy = financialYear(g.date, g.fyStartMonth);
    const dup = g.db.get<{ number: string | null; date: string }>(
      `SELECT number, date FROM vouchers
        WHERE party_ledger_id = :party AND base_type = 'purchase' AND is_cancelled = 0 AND id <> :ex
          AND lower(trim(reference_no)) = lower(trim(:ref)) AND date BETWEEN :from AND :to
        ORDER BY date LIMIT 1`,
      { party: g.partyLedgerId, ex: g.excludeVoucherId ?? 0, ref: g.referenceNo, from: fy.start, to: fy.end },
    );
    if (dup) {
      const L = g.masters.ledger(g.partyLedgerId);
      add(g.policies.duplicateSupplierInvoice, {
        code: 'duplicate_reference',
        message: `Supplier invoice ${g.referenceNo} of ${L.name} is already entered in this financial year (Purchase ${dup.number ?? '(no number)'} dated ${formatDate(dup.date)}).`,
        path: 'referenceNo',
      });
    }
  }
  return out;
}

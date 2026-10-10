/**
 * Voucher registers, Exception reports and Statistics (README §10–§12).
 */
import { PREDEFINED_VOUCHER_TYPES, type VoucherBaseType } from '../../../shared/constants.ts';
import type {
  ExceptionVoucher,
  ExceptionsInput,
  ExceptionsResult,
  NegativeLedgerRow,
  RegisterInput,
  RegisterMonth,
  RegisterResult,
  RegisterVoucher,
  StatisticsResult,
  VoucherStatRow,
} from '../../../shared/types/reports.ts';
import { validation } from '../../lib/errors.ts';
import { assertPeriod, buildSnapshot, monthSlices, type ReportEnv } from './engine.ts';

const DEFAULT_LIMIT = 20_000;

/** A voucher that counts: not optional, not cancelled, post-dated only once its date has come. */
const COUNTED = `v.is_optional = 0 AND v.is_cancelled = 0 AND (v.is_post_dated = 0 OR v.date <= :today)`;

function typeIdsFor(env: ReportEnv, input: RegisterInput): { ids: number[]; title: string; baseType: VoucherBaseType | null } {
  if (input.voucherTypeId !== undefined) {
    const t = env.db.get<{ name: string; base_type: VoucherBaseType }>('SELECT name, base_type FROM voucher_types WHERE id = :id', { id: input.voucherTypeId });
    if (!t) throw validation([{ path: 'voucherTypeId', message: 'This voucher type does not exist. Pick another voucher type.' }]);
    const ids = env.db
      .all<{ id: number }>(
        `WITH RECURSIVE sub(id) AS (SELECT id FROM voucher_types WHERE id = :id
           UNION SELECT vt.id FROM voucher_types vt JOIN sub s ON vt.parent_id = s.id)
         SELECT id FROM sub`,
        { id: input.voucherTypeId },
      )
      .map((r) => r.id);
    return { ids, title: `${t.name} Register`, baseType: t.base_type };
  }
  if (input.baseType !== undefined) {
    const ids = env.db.all<{ id: number }>('SELECT id FROM voucher_types WHERE base_type = :b ORDER BY id', { b: input.baseType }).map((r) => r.id);
    const name = PREDEFINED_VOUCHER_TYPES.find((p) => p.baseType === input.baseType)?.name ?? input.baseType;
    return { ids, title: `${name} Register`, baseType: input.baseType };
  }
  throw validation([{ path: 'baseType', message: 'Choose a voucher type for the register.' }]);
}

/** Month-wise register of a voucher type (or base type), with the vouchers on request. */
export function register(env: ReportEnv, input: RegisterInput): RegisterResult {
  assertPeriod(input.from, input.to);
  const { ids, title, baseType } = typeIdsFor(env, input);
  const params = { ids: JSON.stringify(ids), from: input.from, to: input.to, today: env.today };
  const byMonth = new Map<string, Omit<RegisterMonth, 'month' | 'from' | 'to'>>();
  for (const r of env.db.all<{ m: string; n: number; c: number; amt: number | null; tx: number | null; tax: number | null }>(
    `SELECT substr(v.date, 1, 7) AS m,
            SUM(CASE WHEN ${COUNTED} THEN 1 ELSE 0 END) AS n,
            SUM(CASE WHEN v.is_cancelled = 1 THEN 1 ELSE 0 END) AS c,
            SUM(CASE WHEN ${COUNTED} THEN v.total_amount ELSE 0 END) AS amt,
            SUM(CASE WHEN ${COUNTED} THEN v.taxable_amount ELSE 0 END) AS tx,
            SUM(CASE WHEN ${COUNTED} THEN v.tax_amount ELSE 0 END) AS tax
       FROM vouchers v
      WHERE v.voucher_type_id IN (SELECT value FROM json_each(:ids)) AND v.date >= :from AND v.date <= :to
      GROUP BY m`,
    params,
  )) {
    byMonth.set(r.m, { count: r.n, cancelled: r.c, amount: r.amt ?? 0, taxable: r.tx ?? 0, tax: r.tax ?? 0 });
  }
  const totals = { count: 0, cancelled: 0, amount: 0, taxable: 0, tax: 0 };
  const months: RegisterMonth[] = monthSlices(input.from, input.to).map((s) => {
    const m = byMonth.get(s.month) ?? { count: 0, cancelled: 0, amount: 0, taxable: 0, tax: 0 };
    totals.count += m.count;
    totals.cancelled += m.cancelled;
    totals.amount += m.amount;
    totals.taxable += m.taxable;
    totals.tax += m.tax;
    return { month: s.month, from: s.from, to: s.to, ...m };
  });
  let vouchers: RegisterVoucher[] | null = null;
  let truncated = false;
  if (input.includeVouchers) {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = env.db.all<VoucherDbRow>(
      `${VOUCHER_SELECT}
        WHERE v.voucher_type_id IN (SELECT value FROM json_each(:ids)) AND v.date >= :from AND v.date <= :to AND v.is_optional = 0
        ORDER BY v.date, COALESCE(v.number_seq, 0), v.id
        LIMIT :lim`,
      { ids: params.ids, from: input.from, to: input.to, lim: limit + 1 },
    );
    truncated = rows.length > limit;
    vouchers = rows.slice(0, limit).map((r) => ({
      id: r.id,
      date: r.date,
      voucherType: r.type_name,
      baseType: r.base_type,
      number: r.number,
      partyName: r.party_name,
      referenceNo: r.reference_no,
      narration: r.narration,
      amount: r.total_amount,
      taxable: r.taxable_amount,
      tax: r.tax_amount,
      isCancelled: r.is_cancelled === 1,
      isPostDated: r.is_post_dated === 1,
    }));
  }
  return { from: input.from, to: input.to, title, baseType, voucherTypeIds: ids, months, totals, vouchers, truncated };
}

interface VoucherDbRow {
  id: number;
  date: string;
  type_name: string;
  base_type: VoucherBaseType;
  number: string | null;
  party_name: string | null;
  reference_no: string | null;
  narration: string | null;
  total_amount: number;
  taxable_amount: number;
  tax_amount: number;
  is_cancelled: number;
  is_post_dated: number;
}

const VOUCHER_SELECT = `SELECT v.id, v.date, vt.name AS type_name, v.base_type, v.number, v.party_name, v.reference_no, v.narration,
            v.total_amount, v.taxable_amount, v.tax_amount, v.is_cancelled, v.is_post_dated
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id`;

const toException = (r: VoucherDbRow): ExceptionVoucher => ({
  id: r.id,
  date: r.date,
  voucherType: r.type_name,
  baseType: r.base_type,
  number: r.number,
  partyName: r.party_name,
  narration: r.narration,
  amount: r.total_amount,
});

/** Why a closing balance is unusual for its ledger, or null when it is normal. */
export function negativeReason(cls: {
  isCash: boolean;
  isBank: boolean;
  isBankOd: boolean;
  isDebtor: boolean;
  isCreditor: boolean;
  isDutyTax: boolean;
  nature: string;
}, closing: number): string | null {
  if (closing === 0 || cls.isDutyTax) return null;
  if (closing < 0) {
    if (cls.isCash) return 'Cash in hand is negative (credit balance). A payment may have been entered before the receipt that funded it.';
    if (cls.isBank && !cls.isBankOd) return 'Bank account shows a credit (overdrawn) balance. If this is an overdraft account, move it under Bank OD A/c.';
    if (cls.isDebtor) return 'Customer has a credit balance (an advance received or an excess payment).';
    if (cls.nature === 'assets') return 'Asset ledger has a credit balance.';
    if (cls.nature === 'expenses') return 'Expense ledger has a credit balance for the year to date (more returned or reversed than spent).';
    return null;
  }
  if (cls.isBankOd) return 'Overdraft account has a debit balance (money in the account).';
  if (cls.isCreditor) return 'Supplier has a debit balance (an advance paid or an excess payment).';
  if (cls.nature === 'liabilities') return 'Liability ledger has a debit balance.';
  if (cls.nature === 'income') return 'Income ledger has a debit balance for the year to date (more returned or reversed than earned).';
  return null;
}

/** Exception reports: unusual balances, optional / post-dated / cancelled / memorandum vouchers, missing narration. */
export function exceptions(env: ReportEnv, input: ExceptionsInput): ExceptionsResult {
  assertPeriod(input.from, input.to);
  const snap = buildSnapshot(env, { from: input.from, to: input.to });
  const negativeLedgers: NegativeLedgerRow[] = [];
  for (const l of env.ledgers) {
    if (l.id === env.plLedgerId || l.reservedCode === 'ROUND_OFF') continue;
    const g = env.tree.byId.get(l.groupId);
    const closing = snap.ledgers.get(l.id)?.closing ?? 0;
    if (!g) continue;
    const reason = negativeReason(g.cls, closing);
    if (reason) negativeLedgers.push({ ledgerId: l.id, ledgerName: l.name, groupName: g.name, closing, reason });
  }
  const limit = input.limit ?? 5_000;
  let truncated = false;
  const list = (where: string): ExceptionVoucher[] => {
    const rows = env.db.all<VoucherDbRow>(
      `${VOUCHER_SELECT} WHERE v.date >= :from AND v.date <= :to AND (${where}) ORDER BY v.date, COALESCE(v.number_seq, 0), v.id LIMIT :lim`,
      { from: input.from, to: input.to, lim: limit + 1 },
    );
    if (rows.length > limit) truncated = true;
    return rows.slice(0, limit).map(toException);
  };
  const accounting = `'sales','purchase','payment','receipt','contra','journal','credit_note','debit_note'`;
  return {
    from: input.from,
    to: input.to,
    negativeLedgers,
    optional: list('v.is_optional = 1'),
    postDated: list('v.is_post_dated = 1 AND v.is_cancelled = 0'),
    cancelled: list('v.is_cancelled = 1'),
    memorandum: list(`v.base_type IN ('memorandum', 'reversing_journal') AND v.is_cancelled = 0`),
    noNarration: input.includeNoNarration
      ? list(`v.base_type IN (${accounting}) AND v.is_cancelled = 0 AND v.is_optional = 0 AND (v.narration IS NULL OR trim(v.narration) = '')`)
      : null,
    truncated,
  };
}

const MASTER_COUNTS: ReadonlyArray<{ key: string; label: string; table: string }> = [
  { key: 'groups', label: 'Groups', table: 'groups' },
  { key: 'ledgers', label: 'Ledgers', table: 'ledgers' },
  { key: 'voucherTypes', label: 'Voucher Types', table: 'voucher_types' },
  { key: 'costCategories', label: 'Cost Categories', table: 'cost_categories' },
  { key: 'costCentres', label: 'Cost Centres', table: 'cost_centres' },
  { key: 'currencies', label: 'Currencies', table: 'currencies' },
  { key: 'stockGroups', label: 'Stock Groups', table: 'stock_groups' },
  { key: 'stockCategories', label: 'Stock Categories', table: 'stock_categories' },
  { key: 'stockItems', label: 'Stock Items', table: 'stock_items' },
  { key: 'units', label: 'Units', table: 'units' },
  { key: 'godowns', label: 'Godowns', table: 'godowns' },
  { key: 'priceLevels', label: 'Price Levels', table: 'price_levels' },
];

/** Voucher counts per type for the period and master counts ("Statistics"). */
export function statistics(env: ReportEnv, input: { from: string; to: string }): StatisticsResult {
  assertPeriod(input.from, input.to);
  const vouchers: VoucherStatRow[] = env.db
    .all<{ id: number; name: string; base_type: VoucherBaseType; is_active: number; reg: number | null; opt: number | null; can: number | null; pdc: number | null; tot: number | null }>(
      `SELECT vt.id, vt.name, vt.base_type, vt.is_active,
              SUM(CASE WHEN v.id IS NOT NULL AND v.is_optional = 0 AND v.is_cancelled = 0 AND v.is_post_dated = 0 THEN 1 ELSE 0 END) AS reg,
              SUM(CASE WHEN v.is_optional = 1 THEN 1 ELSE 0 END) AS opt,
              SUM(CASE WHEN v.is_cancelled = 1 THEN 1 ELSE 0 END) AS can,
              SUM(CASE WHEN v.is_post_dated = 1 AND v.is_cancelled = 0 AND v.is_optional = 0 THEN 1 ELSE 0 END) AS pdc,
              COUNT(v.id) AS tot
         FROM voucher_types vt
         LEFT JOIN vouchers v ON v.voucher_type_id = vt.id AND v.date >= :from AND v.date <= :to
        GROUP BY vt.id
        ORDER BY vt.id`,
      { from: input.from, to: input.to },
    )
    .filter((r) => r.is_active === 1 || (r.tot ?? 0) > 0)
    .map((r) => ({
      voucherTypeId: r.id,
      name: r.name,
      baseType: r.base_type,
      regular: r.reg ?? 0,
      optional: r.opt ?? 0,
      cancelled: r.can ?? 0,
      postDated: r.pdc ?? 0,
      total: r.tot ?? 0,
    }));
  const voucherTotals = { regular: 0, optional: 0, cancelled: 0, postDated: 0, total: 0 };
  for (const v of vouchers) {
    voucherTotals.regular += v.regular;
    voucherTotals.optional += v.optional;
    voucherTotals.cancelled += v.cancelled;
    voucherTotals.postDated += v.postDated;
    voucherTotals.total += v.total;
  }
  // Table names come from the fixed list above (never from input).
  const masters = MASTER_COUNTS.map((m) => ({ key: m.key, label: m.label, count: env.db.value<number>(`SELECT COUNT(*) FROM ${m.table}`) ?? 0 }));
  return { from: input.from, to: input.to, vouchers, voucherTotals, masters };
}

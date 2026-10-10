/**
 * Ledger Vouchers, Group Vouchers and Monthly Summary (README §7–§9). Opening balances follow the
 * Trial Balance (same snapshot), so a drill-down always agrees with the report it came from.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  GroupVoucherRow,
  GroupVouchersInput,
  GroupVouchersResult,
  LedgerReportDetail,
  LedgerReportInput,
  LedgerReportResult,
  LedgerReportRow,
  MonthlySummaryInput,
  MonthlySummaryResult,
} from '../../../shared/types/reports.ts';
import { validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { assertPeriod, buildSnapshot, groupNode, ledgerMeta, ledgersUnder, monthSlices, type ReportEnv } from './engine.ts';

const DEFAULT_LIMIT = 20_000;
export const AS_PER_DETAILS = '(as per details)';

interface VoucherHead {
  voucher_id: number;
  date: string;
  type_name: string;
  base_type: VoucherBaseType;
  number: string | null;
  reference_no: string | null;
  narration: string | null;
  is_post_dated: number;
  dr: number;
  cr: number;
}

/** Ledger ids of a group and all its sub-groups (never the reserved Profit & Loss A/c, a line of its own). */
export function ledgerIdsUnder(env: ReportEnv, groupId: number): number[] {
  return ledgersUnder(env, [groupId]);
}

/** Per-voucher Dr/Cr sums of the given ledgers in [from, to] (books filter), in date order. */
function voucherSums(env: ReportEnv, ledgerIds: readonly number[], from: string, to: string): VoucherHead[] {
  if (ledgerIds.length === 0) return [];
  return env.db.all<VoucherHead>(
    `SELECT le.voucher_id, v.date, vt.name AS type_name, v.base_type, v.number, v.reference_no, v.narration, v.is_post_dated,
            SUM(CASE WHEN le.amount > 0 THEN le.amount ELSE 0 END) AS dr,
            SUM(CASE WHEN le.amount < 0 THEN -le.amount ELSE 0 END) AS cr
       FROM ledger_entries le
       JOIN vouchers v ON v.id = le.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE le.ledger_id IN (SELECT value FROM json_each(:ids))
        AND le.date >= :from AND le.date <= :to AND ${BOOKS_FILTER('le')}
      GROUP BY le.voucher_id
      ORDER BY v.date, COALESCE(v.number_seq, 0), le.voucher_id`,
    { ids: JSON.stringify(ledgerIds), from, to, today: env.today },
  );
}

/** "Ledger Vouchers": opening, one row per voucher with particulars and running balance, closing. */
export function ledgerReport(env: ReportEnv, input: LedgerReportInput): LedgerReportResult {
  assertPeriod(input.from, input.to);
  const l = ledgerMeta(env, input.ledgerId);
  // This ledger only (its range of the covering index), never the whole company.
  const snap = buildSnapshot(env, { from: input.from, to: input.to, ledgerIds: [l.id] });
  const bal = snap.ledgers.get(l.id) ?? { opening: 0, debit: 0, credit: 0, closing: 0 };
  const heads = voucherSums(env, [l.id], snap.from, snap.to);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const shown = heads.slice(0, limit);

  // Other ledgers of the shown vouchers (one query).
  const others = new Map<number, Array<LedgerReportDetail & { role: string }>>();
  if (shown.length > 0) {
    for (const r of env.db.all<{ voucher_id: number; ledger_id: number; name: string; amount: number; role: string }>(
      `SELECT le.voucher_id, le.ledger_id, l.name, SUM(le.amount) AS amount, MIN(le.role) AS role
         FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
        WHERE le.voucher_id IN (SELECT value FROM json_each(:vids)) AND le.ledger_id <> :id
        GROUP BY le.voucher_id, le.ledger_id
        ORDER BY le.voucher_id, MIN(le.line_no)`,
      { vids: JSON.stringify(shown.map((h) => h.voucher_id)), id: l.id },
    )) {
      const list = others.get(r.voucher_id);
      const d = { ledgerId: r.ledger_id, ledgerName: r.name, amount: r.amount, role: r.role };
      if (list) list.push(d);
      else others.set(r.voucher_id, [d]);
    }
  }

  let running = bal.opening;
  const rows: LedgerReportRow[] = shown.map((h) => {
    running += h.dr - h.cr;
    const det = (others.get(h.voucher_id) ?? []).filter((d) => d.amount !== 0);
    return {
      voucherId: h.voucher_id,
      date: h.date,
      voucherType: h.type_name,
      baseType: h.base_type,
      number: h.number,
      referenceNo: h.reference_no,
      particulars: particularsFor(h.dr - h.cr, det),
      details: det.map(({ ledgerId, ledgerName, amount }) => ({ ledgerId, ledgerName, amount })),
      narration: h.narration,
      debit: h.dr,
      credit: h.cr,
      balance: running,
      isPostDated: h.is_post_dated === 1,
    };
  });
  const g = env.tree.byId.get(l.groupId);
  return {
    from: snap.from,
    to: snap.to,
    ledger: { id: l.id, name: l.name, alias: l.alias, groupId: l.groupId, groupName: g?.name ?? '', isNominal: l.isNominal, isActive: l.isActive },
    opening: bal.opening,
    rows,
    totals: { debit: bal.debit, credit: bal.credit },
    closing: bal.closing,
    count: heads.length,
    truncated: heads.length > shown.length,
  };
}

/**
 * Particulars of a ledger line: the single ledger on the opposite side; on an invoice (several
 * ledgers opposite, one of them a sales/purchase ledger) the largest sales/purchase ledger, as conventional software
 * shows "Sales" against the customer; otherwise '(as per details)'.
 */
export function particularsFor(net: Paise, others: ReadonlyArray<{ ledgerName: string; amount: Paise; role?: string }>): string {
  if (others.length === 0) return AS_PER_DETAILS;
  const opposite = net === 0 ? [...others] : others.filter((o) => (net > 0 ? o.amount < 0 : o.amount > 0));
  if (opposite.length === 1) return opposite[0].ledgerName;
  if (opposite.length === 0) return others.length === 1 ? others[0].ledgerName : AS_PER_DETAILS;
  const trading = opposite.filter((o) => o.role === 'sales' || o.role === 'purchase');
  if (trading.length > 0) {
    let best = trading[0];
    for (const t of trading) if (Math.abs(t.amount) > Math.abs(best.amount)) best = t;
    return best.ledgerName;
  }
  return AS_PER_DETAILS;
}

/** "Group Vouchers": every voucher touching a ledger of the group, net per voucher, running balance. */
export function groupVouchers(env: ReportEnv, input: GroupVouchersInput): GroupVouchersResult {
  assertPeriod(input.from, input.to);
  const g = groupNode(env, input.groupId);
  const ids = ledgerIdsUnder(env, g.id);
  const snap = buildSnapshot(env, { from: input.from, to: input.to, ledgerIds: ids });
  const gb = snap.groups.get(g.id) ?? { opening: 0, debit: 0, credit: 0, closing: 0 };
  const heads = voucherSums(env, ids, snap.from, snap.to);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const shown = heads.slice(0, limit);
  const names = new Map<number, string[]>();
  if (shown.length > 0) {
    for (const r of env.db.all<{ voucher_id: number; name: string }>(
      `SELECT le.voucher_id, l.name
         FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
        WHERE le.voucher_id IN (SELECT value FROM json_each(:vids)) AND le.ledger_id IN (SELECT value FROM json_each(:ids))
        GROUP BY le.voucher_id, le.ledger_id
        ORDER BY le.voucher_id, MIN(le.line_no)`,
      { vids: JSON.stringify(shown.map((h) => h.voucher_id)), ids: JSON.stringify(ids) },
    )) {
      const list = names.get(r.voucher_id);
      if (list) list.push(r.name);
      else names.set(r.voucher_id, [r.name]);
    }
  }
  let running = gb.opening;
  const rows: GroupVoucherRow[] = shown.map((h) => {
    running += h.dr - h.cr;
    const n = names.get(h.voucher_id) ?? [];
    return {
      voucherId: h.voucher_id,
      date: h.date,
      voucherType: h.type_name,
      baseType: h.base_type,
      number: h.number,
      particulars: n.length > 3 ? AS_PER_DETAILS : n.join(', '),
      narration: h.narration,
      debit: h.dr,
      credit: h.cr,
      balance: running,
    };
  });
  return {
    from: snap.from,
    to: snap.to,
    group: { id: g.id, name: g.name },
    opening: gb.opening,
    rows,
    totals: { debit: gb.debit, credit: gb.credit },
    closing: gb.closing,
    count: heads.length,
    truncated: heads.length > shown.length,
  };
}

/** Month-wise Dr / Cr / closing of a ledger or group ("Monthly Summary"). */
export function monthlySummary(env: ReportEnv, input: MonthlySummaryInput): MonthlySummaryResult {
  assertPeriod(input.from, input.to);
  if ((input.ledgerId === undefined) === (input.groupId === undefined)) {
    throw validation([{ path: 'ledgerId', message: 'Choose either a ledger or a group for the monthly summary.' }]);
  }
  let subject: MonthlySummaryResult['subject'];
  let ids: number[];
  let opening: Paise;
  let snap: ReturnType<typeof buildSnapshot>;
  if (input.ledgerId !== undefined) {
    const l = ledgerMeta(env, input.ledgerId);
    subject = { kind: 'ledger', id: l.id, name: l.name, isNominal: l.isNominal };
    ids = [l.id];
    snap = buildSnapshot(env, { from: input.from, to: input.to, ledgerIds: ids });
    opening = snap.ledgers.get(l.id)?.opening ?? 0;
  } else {
    const g = groupNode(env, input.groupId as number);
    subject = { kind: 'group', id: g.id, name: g.name, isNominal: g.cls.isIncome || g.cls.isExpense };
    ids = ledgerIdsUnder(env, g.id);
    snap = buildSnapshot(env, { from: input.from, to: input.to, ledgerIds: ids });
    opening = snap.groups.get(g.id)?.opening ?? 0;
  }
  const byMonth = new Map<string, { dr: number; cr: number; n: number }>();
  if (ids.length > 0) {
    for (const r of env.db.all<{ m: string; dr: number; cr: number; n: number }>(
      `SELECT substr(date, 1, 7) AS m,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS dr,
              SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS cr,
              COUNT(DISTINCT voucher_id) AS n
         FROM ledger_entries
        WHERE ledger_id IN (SELECT value FROM json_each(:ids)) AND date >= :from AND date <= :to AND ${BOOKS_FILTER()}
        GROUP BY m`,
      { ids: JSON.stringify(ids), from: snap.from, to: snap.to, today: env.today },
    )) {
      byMonth.set(r.m, { dr: r.dr, cr: r.cr, n: r.n });
    }
  }
  let running = opening;
  let td = 0;
  let tc = 0;
  const rows = monthSlices(snap.from, snap.to).map((s) => {
    const m = byMonth.get(s.month) ?? { dr: 0, cr: 0, n: 0 };
    running += m.dr - m.cr;
    td += m.dr;
    tc += m.cr;
    return { month: s.month, from: s.from, to: s.to, debit: m.dr, credit: m.cr, closing: running, count: m.n };
  });
  return { from: snap.from, to: snap.to, subject, opening, rows, totals: { debit: td, credit: tc }, closing: running };
}

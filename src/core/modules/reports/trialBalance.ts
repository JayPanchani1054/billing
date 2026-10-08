/**
 * Trial Balance, Group Summary and Cash/Bank books (all Trial-Balance style: opening, Dr, Cr, closing).
 * See README §2–§4.
 */
import type { Paise } from '../../../shared/money.ts';
import type {
  CashBankResult,
  GroupSummaryInput,
  GroupSummaryResult,
  TbRow,
  TrialBalanceInput,
  TrialBalanceMode,
  TrialBalanceResult,
} from '../../../shared/types/reports.ts';
import { buildSnapshot, groupNode, ledgersByGroup, stockAt, stockAtEnd, type Balance, type ReportEnv, type Snapshot } from './engine.ts';

const isZero = (b: Balance): boolean => b.opening === 0 && b.debit === 0 && b.credit === 0 && b.closing === 0;

interface TreeOpts {
  withLedgers: boolean;
  showZero: boolean;
  /** Ledger ids to leave out (e.g. none). */
  skipLedger?: (ledgerId: number) => boolean;
  /** Extra rows to append inside a group (after its sub-groups and ledgers), e.g. closing stock. */
  extraRows?: (groupId: number, level: number, parentKey: string) => TbRow[];
}

/**
 * Rows for the sub-tree of each root group (pre-order: group, its sub-groups, then its ledgers).
 * Rows of groups whose own figures are all zero are kept only when a child is shown.
 */
export function tbTree(env: ReportEnv, snap: Snapshot, rootIds: readonly number[], level0: number, parentKey: string | null, opts: TreeOpts): TbRow[] {
  const byGroup = ledgersByGroup(env);
  const out: TbRow[] = [];
  const emit = (groupId: number, level: number, parent: string | null): void => {
    const g = env.tree.byId.get(groupId);
    if (!g) return;
    const bal = snap.groups.get(groupId) ?? { opening: 0, debit: 0, credit: 0, closing: 0 };
    const key = `g:${groupId}`;
    const row: TbRow = { key, kind: 'group', id: groupId, name: g.name, level, parentKey: parent, hasChildren: false, ...pick(bal) };
    const at = out.length;
    out.push(row);
    for (const c of g.childIds) emit(c, level + 1, key);
    if (opts.withLedgers) {
      for (const l of byGroup.get(groupId) ?? []) {
        if (opts.skipLedger?.(l.id)) continue;
        const b = snap.ledgers.get(l.id) as Balance;
        if (!opts.showZero && isZero(b)) continue;
        out.push({ key: `l:${l.id}`, kind: 'ledger', id: l.id, name: l.name, level: level + 1, parentKey: key, hasChildren: false, ...pick(b) });
      }
    }
    if (opts.extraRows) out.push(...opts.extraRows(groupId, level + 1, key));
    const hasChildren = out.length > at + 1;
    row.hasChildren = hasChildren;
    if (!opts.showZero && !hasChildren && isZero(row)) out.length = at;
  };
  for (const id of rootIds) emit(id, level0, parentKey);
  return out;
}

const pick = (b: Balance): Balance => ({ opening: b.opening, debit: b.debit, credit: b.credit, closing: b.closing });

function splitTotals(rows: readonly TbRow[]): TrialBalanceResult['totals'] {
  const t = { opening: { debit: 0, credit: 0 }, transactions: { debit: 0, credit: 0 }, closing: { debit: 0, credit: 0 } };
  for (const r of rows) {
    if (r.level !== 0) continue;
    if (r.opening > 0) t.opening.debit += r.opening;
    else t.opening.credit -= r.opening;
    t.transactions.debit += r.debit;
    t.transactions.credit += r.credit;
    if (r.closing > 0) t.closing.debit += r.closing;
    else t.closing.credit -= r.closing;
  }
  return t;
}

/** Trial Balance for [from, to]. */
export function trialBalance(env: ReportEnv, input: TrialBalanceInput): TrialBalanceResult {
  const mode: TrialBalanceMode = input.mode ?? 'groups';
  const showZero = input.showZero ?? false;
  const snap = buildSnapshot(env, { from: input.from, to: input.to });
  let rows: TbRow[];
  if (mode === 'ledgers') {
    rows = [];
    const byGroup = ledgersByGroup(env);
    for (const gid of env.tree.order) {
      for (const l of byGroup.get(gid) ?? []) {
        const b = snap.ledgers.get(l.id) as Balance;
        if (!showZero && isZero(b)) continue;
        rows.push({ key: `l:${l.id}`, kind: 'ledger', id: l.id, name: l.name, level: 0, parentKey: null, hasChildren: false, ...pick(b) });
      }
    }
  } else {
    rows = tbTree(env, snap, env.tree.rootIds, 0, null, { withLedgers: mode === 'detailed', showZero });
  }
  const special: TbRow[] = [];
  if (env.integrated && (snap.openingStock !== 0 || showZero)) {
    const s = snap.openingStock;
    special.push({ key: 'stock:opening', kind: 'stock', id: null, name: 'Opening Stock', level: 0, parentKey: null, hasChildren: false, opening: s, debit: 0, credit: 0, closing: s });
  }
  rows = [...special, ...rows];
  const diff = snap.openingDifference;
  if (diff !== 0) {
    rows.push({ key: 'diff', kind: 'difference', id: null, name: 'Difference in opening balances', level: 0, parentKey: null, hasChildren: false, opening: diff, debit: 0, credit: 0, closing: diff });
  }
  const totals = splitTotals(rows);
  const unbalancedBy = totals.closing.debit - totals.closing.credit;
  return {
    from: snap.from,
    to: snap.to,
    mode,
    yearStart: snap.yearStart,
    inventoryIntegrated: env.integrated,
    rows,
    totals,
    openingStock: env.integrated ? snap.openingStock : 0,
    openingDifference: diff,
    unbalancedBy,
    balanced: unbalancedBy === 0,
  };
}

/** Sub-groups and ledgers of one group with Trial-Balance figures (Tally "Group Summary"). */
export function groupSummary(env: ReportEnv, input: GroupSummaryInput): GroupSummaryResult {
  const g = groupNode(env, input.groupId);
  const isNominal = g.cls.isIncome || g.cls.isExpense;
  // P&L basis: nominal ledgers restart at `from` (opening = their opening balance only when `from` is on
  // or before the books beginning — exactly nominalMovement), so the summary agrees with the P&L line.
  const basis = input.basis === 'profitLoss' && isNominal ? 'profitLoss' : 'trialBalance';
  const snap = buildSnapshot(env, basis === 'profitLoss' ? { from: input.from, to: input.to, yearStart: input.from } : { from: input.from, to: input.to });
  const showZero = input.showZero ?? false;
  const stockGroupId = env.groupByCode.get('STOCK_IN_HAND');
  const stockInside = env.integrated && stockGroupId !== undefined && (env.tree.byId.get(stockGroupId)?.chainIds.includes(g.id) ?? false);
  const stockRow = (level: number, parentKey: string | null): TbRow => {
    const opening = stockAt(env, snap.from);
    const closing = stockAtEnd(env, snap.to);
    return {
      key: 'stock:closing',
      kind: 'stock',
      id: null,
      name: 'Closing Stock (stock summary)',
      level,
      parentKey,
      hasChildren: false,
      opening,
      debit: closing > opening ? closing - opening : 0,
      credit: closing < opening ? opening - closing : 0,
      closing,
    };
  };
  const extraRows = stockInside
    ? (groupId: number, level: number, parentKey: string): TbRow[] => (groupId === stockGroupId ? [stockRow(level, parentKey)] : [])
    : undefined;
  const byGroup = ledgersByGroup(env);
  const rows: TbRow[] = [];
  for (const c of g.childIds) rows.push(...tbTree(env, snap, [c], 0, null, { withLedgers: true, showZero, extraRows }));
  for (const l of byGroup.get(g.id) ?? []) {
    const b = snap.ledgers.get(l.id) as Balance;
    if (!showZero && isZero(b)) continue;
    rows.push({ key: `l:${l.id}`, kind: 'ledger', id: l.id, name: l.name, level: 0, parentKey: null, hasChildren: false, ...pick(b) });
  }
  if (stockInside && g.id === stockGroupId) rows.push(stockRow(0, null));
  // Stock rows also roll into the parents shown above them (Stock-in-Hand, Current Assets).
  if (stockInside) {
    const s = rows.find((r) => r.kind === 'stock');
    if (s) {
      for (const r of rows) {
        if (r.kind !== 'group' || r.id === null) continue;
        const sg = env.tree.byId.get(stockGroupId as number);
        if (sg?.chainIds.includes(r.id)) {
          r.opening += s.opening;
          r.debit += s.debit;
          r.credit += s.credit;
          r.closing += s.closing;
        }
      }
    }
  }
  const totals = { opening: 0, debit: 0, credit: 0, closing: 0 };
  for (const r of rows) {
    if (r.level !== 0) continue;
    totals.opening += r.opening;
    totals.debit += r.debit;
    totals.credit += r.credit;
    totals.closing += r.closing;
  }
  return {
    from: snap.from,
    to: snap.to,
    group: { id: g.id, name: g.name, path: g.path, nature: g.nature, isNominal },
    basis,
    rows,
    totals,
  };
}

/** Cash-in-Hand, Bank Accounts and Bank OD A/c with their ledgers (Tally "Cash/Bank Book(s)"). */
export function cashBank(env: ReportEnv, input: { from: string; to: string }): CashBankResult {
  const snap = buildSnapshot(env, { from: input.from, to: input.to });
  const roots: number[] = [];
  for (const code of ['CASH_IN_HAND', 'BANK_ACCOUNTS', 'BANK_OD'] as const) {
    const id = env.groupByCode.get(code);
    if (id !== undefined) roots.push(id);
  }
  const rows = tbTree(env, snap, roots, 0, null, { withLedgers: true, showZero: true });
  // Hide empty groups (no ledgers at all) but keep zero-balance ledgers: a new bank account shows up.
  const visible = rows.filter((r) => r.kind !== 'group' || r.hasChildren);
  const totals = { opening: 0, debit: 0, credit: 0, closing: 0 };
  for (const r of visible) {
    if (r.level !== 0) continue;
    totals.opening += r.opening;
    totals.debit += r.debit;
    totals.credit += r.credit;
    totals.closing += r.closing;
  }
  return { from: snap.from, to: snap.to, rows: visible, totals };
}

/** Σ closing (signed) of the given ledgers in a snapshot. */
export function sumClosing(snap: Snapshot, ids: Iterable<number>): Paise {
  let s = 0;
  for (const id of ids) s += snap.ledgers.get(id)?.closing ?? 0;
  return s;
}

/**
 * Books-of-accounts helpers shared by every module that reads balances (reports, outstanding,
 * banking, dashboard, GST). See README.md in this folder for the full reference.
 *
 *   BOOKS_FILTER('le')                     SQL fragment: which ledger_entries count in the books
 *   groupChain / primaryGroup / groupDescendantIds / groupCodeSet / loadGroupTree
 *   ledgerClass(db, ledgerId)              cash / bank / party / sales / … flags from the group chain
 *   ledgerBalance(db, id, { from?, to, today })
 *   closingBalances(db, { asOf, today, ledgerIds? })
 *   groupBalances(db, { from?, to, today })   one aggregate query + JS roll-up (Trial Balance)
 *
 * Money is integer paise, Dr + / Cr −. `debit`/`credit` are unsigned period totals.
 */
import type { GroupCode, GroupNature } from '../../../shared/constants.ts';
import type { Paise } from '../../../shared/money.ts';
import { LEDGER_CLASSES, type LedgerBalance, type LedgerClass, type LedgerClassName } from '../../../shared/types/accounts.ts';
import type { Db } from '../../db/db.ts';
import { notFound, validation } from '../../lib/errors.ts';

// ───────────────────────────── Books filter ─────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * SQL condition selecting rows that count in the books:
 *   `<a>.affects_books = 1 AND (<a>.is_post_dated = 0 OR <a>.date <= :today)`
 * Works on ledger_entries (and any table with the same denormalised columns). The caller must bind
 * `today` (use ctx.clock.today()). Optional, cancelled, memorandum and order vouchers have
 * affects_books = 0; post-dated vouchers count once their date is reached.
 */
export function BOOKS_FILTER(alias?: string): string {
  if (alias !== undefined && !IDENT.test(alias)) throw new Error(`BOOKS_FILTER: invalid table alias ${JSON.stringify(alias)}`);
  const a = alias ? `${alias}.` : '';
  return `${a}affects_books = 1 AND (${a}is_post_dated = 0 OR ${a}date <= :today)`;
}

// ───────────────────────────── Groups ─────────────────────────────

export interface GroupNode {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parentId: number | null;
  nature: GroupNature;
  affectsGrossProfit: boolean;
  reservedCode: GroupCode | null;
  isPredefined: boolean;
  isSubledger: boolean;
  netBalances: boolean;
  usedForCalculation: boolean;
  sortOrder: number;
}

export interface GroupDbRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  parent_id: number | null;
  nature: GroupNature;
  affects_gross_profit: number;
  reserved_code: GroupCode | null;
  is_predefined: number;
  is_subledger: number;
  net_balances: number;
  used_for_calculation: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function toGroupNode(r: GroupDbRow): GroupNode {
  return {
    id: r.id,
    guid: r.guid,
    name: r.name,
    alias: r.alias,
    parentId: r.parent_id,
    nature: r.nature,
    affectsGrossProfit: r.affects_gross_profit === 1,
    reservedCode: r.reserved_code,
    isPredefined: r.is_predefined === 1,
    isSubledger: r.is_subledger === 1,
    netBalances: r.net_balances === 1,
    usedForCalculation: r.used_for_calculation === 1,
    sortOrder: r.sort_order,
  };
}

/** Longest group chain walked (guards against a corrupted parent cycle). */
const MAX_DEPTH = 64;

/** Groups from the primary group down to `groupId` (inclusive). Throws NOT_FOUND for an unknown group. */
export function groupChain(db: Db, groupId: number): GroupNode[] {
  const rows = db.all<GroupDbRow & { lvl: number }>(
    `WITH RECURSIVE chain(id, parent_id, lvl) AS (
       SELECT id, parent_id, 0 FROM groups WHERE id = :id
       UNION ALL
       SELECT g.id, g.parent_id, c.lvl + 1 FROM groups g JOIN chain c ON g.id = c.parent_id WHERE c.lvl < ${MAX_DEPTH}
     )
     SELECT g.*, c.lvl FROM chain c JOIN groups g ON g.id = c.id ORDER BY c.lvl DESC`,
    { id: groupId },
  );
  if (rows.length === 0) throw notFound('Group', groupId);
  return rows.map(toGroupNode);
}

/** The primary (top-level) group of `groupId`'s chain. */
export function primaryGroup(db: Db, groupId: number): GroupNode {
  return groupChain(db, groupId)[0];
}

/** `groupId` and all its sub-groups at any depth (recursive CTE). Empty when the group does not exist. */
export function groupDescendantIds(db: Db, groupId: number): number[] {
  return db
    .all<{ id: number }>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM groups WHERE id = :id
         UNION
         SELECT g.id FROM groups g JOIN sub s ON g.parent_id = s.id
       )
       SELECT id FROM sub`,
      { id: groupId },
    )
    .map((r) => r.id);
}

/** Reserved codes of the predefined groups in `groupId`'s chain (e.g. {CURRENT_ASSETS, SUNDRY_DEBTORS}). */
export function groupCodeSet(db: Db, groupId: number): Set<GroupCode> {
  const out = new Set<GroupCode>();
  for (const g of groupChain(db, groupId)) if (g.reservedCode) out.add(g.reservedCode);
  return out;
}

/** Classification of any ledger placed in a group with this chain (root → leaf). Pure. */
export function classFromChain(chain: readonly Pick<GroupNode, 'reservedCode' | 'nature' | 'affectsGrossProfit'>[]): LedgerClass {
  if (chain.length === 0) throw new Error('classFromChain: empty group chain');
  const codes = new Set<string>();
  for (const g of chain) if (g.reservedCode) codes.add(g.reservedCode);
  const leaf = chain[chain.length - 1];
  const isCash = codes.has('CASH_IN_HAND');
  const isBankOd = codes.has('BANK_OD');
  const isBank = isBankOd || codes.has('BANK_ACCOUNTS');
  const isDebtor = codes.has('SUNDRY_DEBTORS');
  const isCreditor = codes.has('SUNDRY_CREDITORS');
  return {
    isCash,
    isBank,
    isBankOd,
    isCashOrBank: isCash || isBank,
    isDebtor,
    isCreditor,
    isParty: isDebtor || isCreditor,
    isDutyTax: codes.has('DUTIES_TAXES'),
    isSales: codes.has('SALES_ACCOUNTS'),
    isPurchase: codes.has('PURCHASE_ACCOUNTS'),
    isIncome: leaf.nature === 'income',
    isExpense: leaf.nature === 'expenses',
    nature: leaf.nature,
    affectsGrossProfit: leaf.affectsGrossProfit,
    primaryCode: chain[0].reservedCode,
  };
}

/** Class names (LEDGER_CLASSES order) that a classification matches. */
export function ledgerClassNames(c: LedgerClass): LedgerClassName[] {
  const has: Record<LedgerClassName, boolean> = {
    cash: c.isCash,
    bank: c.isBank,
    cash_bank: c.isCashOrBank,
    party: c.isParty,
    debtor: c.isDebtor,
    creditor: c.isCreditor,
    sales: c.isSales,
    purchase: c.isPurchase,
    duty_tax: c.isDutyTax,
    income: c.isIncome,
    expense: c.isExpense,
    asset: c.nature === 'assets',
    liability: c.nature === 'liabilities',
  };
  return LEDGER_CLASSES.filter((k) => has[k]);
}

/** Classification of a ledger from its group chain. Throws NOT_FOUND for an unknown ledger. */
export function ledgerClass(db: Db, ledgerId: number): LedgerClass {
  const groupId = db.value<number>('SELECT group_id FROM ledgers WHERE id = :id', { id: ledgerId });
  if (groupId === undefined) throw notFound('Ledger', ledgerId);
  return classFromChain(groupChain(db, groupId));
}

// ───────────────────────────── Whole group tree (in memory) ─────────────────────────────

export interface GroupTreeNode extends GroupNode {
  createdAt: string;
  updatedAt: string;
  /** 0 for primary groups. */
  depth: number;
  /** Ids from the primary group down to this group (inclusive). */
  chainIds: number[];
  /** Names from the primary group down to this group (inclusive). */
  path: string[];
  /** Reserved codes in the chain. */
  codes: ReadonlySet<GroupCode>;
  primaryId: number;
  primaryCode: GroupCode | null;
  /** Direct sub-groups in display order (sort order, then name). */
  childIds: number[];
  /** Classification of ledgers placed directly in this group. */
  cls: LedgerClass;
  classNames: LedgerClassName[];
}

export interface GroupTree {
  byId: Map<number, GroupTreeNode>;
  /** Primary groups in display order. */
  rootIds: number[];
  /** Every group, depth-first in display order (parents before children). */
  order: number[];
}

const bySortThenName = (a: GroupNode, b: GroupNode): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id;

/** Load every group with its chain, path, codes and classification (a few hundred rows at most). */
export function loadGroupTree(db: Db): GroupTree {
  const rows = db.all<GroupDbRow>('SELECT * FROM groups');
  const nodes = new Map<number, GroupNode & { createdAt: string; updatedAt: string }>();
  for (const r of rows) nodes.set(r.id, { ...toGroupNode(r), createdAt: r.created_at, updatedAt: r.updated_at });

  const children = new Map<number | null, GroupNode[]>();
  for (const n of nodes.values()) {
    const key = n.parentId !== null && nodes.has(n.parentId) ? n.parentId : null;
    const list = children.get(key);
    if (list) list.push(n);
    else children.set(key, [n]);
  }
  for (const list of children.values()) list.sort(bySortThenName);

  const byId = new Map<number, GroupTreeNode>();
  const order: number[] = [];
  const visit = (n: GroupNode & { createdAt: string; updatedAt: string }, parent: GroupTreeNode | null): void => {
    if (byId.has(n.id)) return; // corrupted cycle guard
    const chainNodes = parent ? [...parent.chainIds.map((id) => byId.get(id) as GroupTreeNode), n] : [n];
    const codes = new Set<GroupCode>(parent ? parent.codes : []);
    if (n.reservedCode) codes.add(n.reservedCode);
    const cls = classFromChain(chainNodes);
    const node: GroupTreeNode = {
      ...n,
      depth: parent ? parent.depth + 1 : 0,
      chainIds: parent ? [...parent.chainIds, n.id] : [n.id],
      path: parent ? [...parent.path, n.name] : [n.name],
      codes,
      primaryId: parent ? parent.primaryId : n.id,
      primaryCode: parent ? parent.primaryCode : n.reservedCode,
      childIds: (children.get(n.id) ?? []).map((c) => c.id),
      cls,
      classNames: ledgerClassNames(cls),
    };
    byId.set(n.id, node);
    order.push(n.id);
    for (const c of children.get(n.id) ?? []) visit(nodes.get(c.id) as GroupNode & { createdAt: string; updatedAt: string }, node);
  };
  const roots = children.get(null) ?? [];
  for (const r of roots) visit(nodes.get(r.id) as GroupNode & { createdAt: string; updatedAt: string }, null);
  return { byId, rootIds: roots.map((r) => r.id), order };
}

// ───────────────────────────── Balances ─────────────────────────────

export interface BalanceQuery {
  /** First day of the period; omitted = from the beginning of the books. */
  from?: string;
  /** Last day of the period (inclusive). */
  to: string;
  /** Working date for the post-dated rule (ctx.clock.today()). */
  today: string;
}

interface PeriodSums {
  before: number | null;
  dr: number | null;
  cr: number | null;
}

/** VALIDATION when a period starts after it ends (a reversed range would silently give wrong totals). */
function assertPeriod(q: BalanceQuery): void {
  if (q.from !== undefined && q.from > q.to) {
    throw validation([{ path: 'from', message: 'The period starts after it ends. Check the From and To dates.' }]);
  }
}

const PERIOD_SUMS = /* sql */ `
  SUM(CASE WHEN date < :from THEN amount ELSE 0 END) AS before,
  SUM(CASE WHEN date >= :from AND amount > 0 THEN amount ELSE 0 END) AS dr,
  SUM(CASE WHEN date >= :from AND amount < 0 THEN -amount ELSE 0 END) AS cr`;

/**
 * Opening / debit / credit / closing of one ledger for a period, books filter applied.
 * opening = ledgers.opening_balance + entries dated before `from`.
 */
export function ledgerBalance(db: Db, ledgerId: number, q: BalanceQuery): LedgerBalance {
  assertPeriod(q);
  const ob = db.value<number>('SELECT opening_balance FROM ledgers WHERE id = :id', { id: ledgerId });
  if (ob === undefined) throw notFound('Ledger', ledgerId);
  const s = db.get<PeriodSums>(
    `SELECT ${PERIOD_SUMS} FROM ledger_entries WHERE ledger_id = :id AND date <= :to AND ${BOOKS_FILTER()}`,
    { id: ledgerId, from: q.from ?? '', to: q.to, today: q.today },
  );
  const opening = ob + (s?.before ?? 0);
  const debit = s?.dr ?? 0;
  const credit = s?.cr ?? 0;
  return { opening, debit, credit, closing: opening + debit - credit };
}

/**
 * Closing balance (opening + entries up to `asOf`, books filter) for the given ledgers, or for every
 * ledger when `ledgerIds` is omitted. One query; ledgers without entries get their opening balance.
 */
export function closingBalances(db: Db, q: { asOf: string; today: string; ledgerIds?: readonly number[] }): Map<number, Paise> {
  const where = q.ledgerIds ? 'WHERE l.id IN (SELECT value FROM json_each(:ids))' : '';
  const rows = db.all<{ id: number; bal: number }>(
    `SELECT l.id,
            l.opening_balance + COALESCE((SELECT SUM(le.amount) FROM ledger_entries le
                                          WHERE le.ledger_id = l.id AND le.date <= :asOf AND ${BOOKS_FILTER('le')}), 0) AS bal
       FROM ledgers l ${where}`,
    q.ledgerIds ? { asOf: q.asOf, today: q.today, ids: JSON.stringify(q.ledgerIds) } : { asOf: q.asOf, today: q.today },
  );
  return new Map(rows.map((r) => [r.id, r.bal]));
}

export interface LedgerPeriodBalance extends LedgerBalance {
  ledgerId: number;
  groupId: number;
}

export interface GroupPeriodBalance extends LedgerBalance {
  /** Σ of debit closing balances of the ledgers below (≥ 0). */
  closingDebit: Paise;
  /** Σ of credit closing balances of the ledgers below, as a positive number (≥ 0). */
  closingCredit: Paise;
  /** Ledgers in this group and its sub-groups. */
  ledgerCount: number;
}

export interface GroupBalances {
  from: string | null;
  to: string;
  /** Every ledger (including those without entries). */
  ledgers: Map<number, LedgerPeriodBalance>;
  /** Every group, rolled up over all its sub-groups and ledgers. */
  groups: Map<number, GroupPeriodBalance>;
  /** All ledgers together: closing = opening difference when the books balance. */
  total: GroupPeriodBalance;
  /** The group tree used for the roll-up (reuse it for report layout). */
  tree: GroupTree;
}

const emptyTotals = (): GroupPeriodBalance => ({ opening: 0, debit: 0, credit: 0, closing: 0, closingDebit: 0, closingCredit: 0, ledgerCount: 0 });

/**
 * Per-ledger and per-group opening / debit / credit / closing for a period. One aggregate query over
 * ledger_entries grouped by ledger, one over ledgers, then a roll-up in JS through each group's chain.
 * Σ over primary groups equals `total`; reports reuse this for the Trial Balance.
 */
export function groupBalances(db: Db, q: BalanceQuery & { tree?: GroupTree }): GroupBalances {
  assertPeriod(q);
  const tree = q.tree ?? loadGroupTree(db);
  const sums = new Map<number, PeriodSums>();
  for (const r of db.all<PeriodSums & { ledger_id: number }>(
    `SELECT ledger_id, ${PERIOD_SUMS} FROM ledger_entries WHERE date <= :to AND ${BOOKS_FILTER()} GROUP BY ledger_id`,
    { from: q.from ?? '', to: q.to, today: q.today },
  )) {
    sums.set(r.ledger_id, r);
  }

  const groups = new Map<number, GroupPeriodBalance>();
  for (const id of tree.order) groups.set(id, emptyTotals());
  const total = emptyTotals();
  const ledgers = new Map<number, LedgerPeriodBalance>();

  const add = (t: GroupPeriodBalance, b: LedgerBalance): void => {
    t.opening += b.opening;
    t.debit += b.debit;
    t.credit += b.credit;
    t.closing += b.closing;
    if (b.closing > 0) t.closingDebit += b.closing;
    else t.closingCredit -= b.closing;
    t.ledgerCount += 1;
  };

  for (const l of db.all<{ id: number; group_id: number; opening_balance: number }>('SELECT id, group_id, opening_balance FROM ledgers')) {
    const s = sums.get(l.id);
    const opening = l.opening_balance + (s?.before ?? 0);
    const debit = s?.dr ?? 0;
    const credit = s?.cr ?? 0;
    const row: LedgerPeriodBalance = { ledgerId: l.id, groupId: l.group_id, opening, debit, credit, closing: opening + debit - credit };
    ledgers.set(l.id, row);
    add(total, row);
    const g = tree.byId.get(l.group_id);
    if (g) for (const gid of g.chainIds) add(groups.get(gid) as GroupPeriodBalance, row);
  }
  return { from: q.from ?? null, to: q.to, ledgers, groups, total, tree };
}

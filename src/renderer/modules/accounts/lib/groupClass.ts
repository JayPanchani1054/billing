/**
 * Client-side ledger classification from the group list (mirrors core `classFromChain` in
 * src/core/modules/accounts/books.ts, which the renderer may not import). Used to decide which
 * sections the ledger form shows as soon as a group is picked, before anything is saved.
 * Pure — tested in groupClass.test.ts.
 */
import type { GroupCode, GroupNature } from '../../../../shared/constants.ts';
import type { GroupRow, LedgerClass, LedgerClassName } from '../../../../shared/types/accounts.ts';
import { LEDGER_CLASSES } from '../../../../shared/types/accounts.ts';

/** The parts of a GroupRow the classifier needs. */
export type GroupLike = Pick<GroupRow, 'id' | 'parentId' | 'reservedCode' | 'nature' | 'affectsGrossProfit'>;

export interface GroupIndex<G extends GroupLike = GroupLike> {
  byId: ReadonlyMap<number, G>;
  /** Primary group → … → group (inclusive). [] for an unknown id or a cycle. */
  chain: (groupId: number) => G[];
  /** Reserved codes along the chain. */
  codes: (groupId: number) => ReadonlySet<GroupCode>;
}

export function indexGroups<G extends GroupLike>(groups: readonly G[]): GroupIndex<G> {
  const byId = new Map<number, G>();
  for (const g of groups) byId.set(g.id, g);
  const chainCache = new Map<number, G[]>();
  const chain = (groupId: number): G[] => {
    const hit = chainCache.get(groupId);
    if (hit) return hit;
    const out: G[] = [];
    const seen = new Set<number>();
    let cur = byId.get(groupId);
    while (cur) {
      if (seen.has(cur.id)) return [];
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    chainCache.set(groupId, out);
    return out;
  };
  const codes = (groupId: number): ReadonlySet<GroupCode> => {
    const s = new Set<GroupCode>();
    for (const g of chain(groupId)) if (g.reservedCode) s.add(g.reservedCode);
    return s;
  };
  return { byId, chain, codes };
}

/** Classification of a ledger under `groupId`; null when the group is unknown. */
export function classOfGroup(index: GroupIndex, groupId: number | null | undefined): LedgerClass | null {
  if (groupId === null || groupId === undefined) return null;
  const chain = index.chain(groupId);
  if (chain.length === 0) return null;
  const codes = index.codes(groupId);
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

/** Class names (LEDGER_CLASSES order) a classification matches — same as core ledgerClassNames. */
export function classNamesOf(c: LedgerClass): LedgerClassName[] {
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

/** True when the group is (or is under) a group with this reserved code. */
export function groupIsUnder(index: GroupIndex, groupId: number | null | undefined, code: GroupCode): boolean {
  return groupId !== null && groupId !== undefined && index.codes(groupId).has(code);
}

export const NATURE_LABELS: Readonly<Record<GroupNature, string>> = {
  assets: 'Assets',
  liabilities: 'Liabilities',
  income: 'Income',
  expenses: 'Expenses',
};

/** One-line description of what a group is used for (picker hint / group form). */
export function natureHint(nature: GroupNature, affectsGrossProfit: boolean): string {
  switch (nature) {
    case 'assets':
      return 'Balance Sheet · what the business owns or is owed';
    case 'liabilities':
      return 'Balance Sheet · what the business owes, and capital';
    case 'income':
      return affectsGrossProfit ? 'Trading account · affects gross profit' : 'Profit & Loss · below gross profit';
    case 'expenses':
      return affectsGrossProfit ? 'Trading account · affects gross profit' : 'Profit & Loss · below gross profit';
  }
}

/**
 * The group a new ledger most likely belongs under when it is created from a picker limited to
 * these classes (Alt+C in a party / bank / sales picker), so the ledger form opens pre-filled.
 * Only an unambiguous answer is given: ['party'] could be a customer or a supplier → null.
 */
export function groupCodeForClasses(classes: readonly LedgerClassName[] | undefined): GroupCode | null {
  if (!classes || classes.length !== 1) return null;
  switch (classes[0]) {
    case 'debtor':
      return 'SUNDRY_DEBTORS';
    case 'creditor':
      return 'SUNDRY_CREDITORS';
    case 'bank':
      return 'BANK_ACCOUNTS';
    case 'cash':
      return 'CASH_IN_HAND';
    case 'sales':
      return 'SALES_ACCOUNTS';
    case 'purchase':
      return 'PURCHASE_ACCOUNTS';
    case 'duty_tax':
      return 'DUTIES_TAXES';
    default:
      return null;
  }
}

/**
 * The group Ledger Creation opens under: `groupId` when given and known, else the predefined group
 * with reserved code `groupCode` (e.g. 'SUNDRY_DEBTORS' from a voucher's party picker,
 * 'BANK_ACCOUNTS' from Banking); null when neither resolves (the user picks "Under").
 */
export function initialGroupId(groups: readonly Pick<GroupRow, 'id' | 'reservedCode'>[], params: { groupId?: unknown; groupCode?: unknown }): number | null {
  if (typeof params.groupId === 'number' && groups.some((g) => g.id === params.groupId)) return params.groupId;
  if (typeof params.groupCode === 'string' && params.groupCode) return groups.find((g) => g.reservedCode === params.groupCode)?.id ?? null;
  return null;
}

/**
 * Test fixture: the predefined group tree (as accounts.group.list returns it, minus unused fields)
 * plus two user sub-groups. Used only by the accounts renderer tests.
 */
import { PREDEFINED_GROUPS } from '../../../../shared/constants.ts';
import type { GroupCode } from '../../../../shared/constants.ts';
import type { GroupLike } from './groupClass.ts';

export interface TestGroup extends GroupLike {
  name: string;
}

export function predefinedTestGroups(): TestGroup[] {
  const ids = new Map<GroupCode, number>();
  PREDEFINED_GROUPS.forEach((g, i) => ids.set(g.code, i + 1));
  const out: TestGroup[] = PREDEFINED_GROUPS.map((g, i) => ({
    id: i + 1,
    name: g.name,
    parentId: g.parent ? (ids.get(g.parent) ?? null) : null,
    reservedCode: g.code,
    nature: g.nature,
    affectsGrossProfit: g.affectsGrossProfit,
  }));
  // User groups: "Mumbai Customers" under Sundry Debtors, "Office Expenses" under Indirect Expenses.
  out.push({ id: 101, name: 'Mumbai Customers', parentId: ids.get('SUNDRY_DEBTORS') ?? null, reservedCode: null, nature: 'assets', affectsGrossProfit: false });
  out.push({ id: 102, name: 'Office Expenses', parentId: ids.get('INDIRECT_EXPENSES') ?? null, reservedCode: null, nature: 'expenses', affectsGrossProfit: false });
  return out;
}

export function groupIdOf(groups: readonly TestGroup[], code: GroupCode): number {
  const g = groups.find((x) => x.reservedCode === code);
  if (!g) throw new Error(`no group ${code}`);
  return g.id;
}

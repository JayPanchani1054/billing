/**
 * Chart of accounts: groups → sub-groups → ledgers with closing balances as of a date
 * (books filter applied). Used by the Chart of Accounts screen and its Excel export.
 */
import type { LedgerCode } from '../../../shared/constants.ts';
import type { ChartInput, ChartNode, ChartOfAccounts } from '../../../shared/types/accounts.ts';
import type { Db } from '../../db/db.ts';
import { groupBalances, type GroupTreeNode } from './books.ts';

export function chartOfAccounts(db: Db, input: ChartInput, today: string): ChartOfAccounts {
  const asOf = input.asOf ?? today;
  const gb = groupBalances(db, { to: asOf, today });
  const { tree } = gb;
  const includeLedgers = input.includeLedgers !== false;

  const ledgersByGroup = new Map<number, ChartNode[]>();
  let ledgerCount = 0;
  if (includeLedgers) {
    const rows = db.all<{ id: number; name: string; alias: string | null; group_id: number; reserved_code: LedgerCode | null; is_predefined: number; is_active: number }>(
      `SELECT id, name, alias, group_id, reserved_code, is_predefined, is_active FROM ledgers ${input.activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY name`,
    );
    for (const l of rows) {
      const g = tree.byId.get(l.group_id);
      if (!g) continue;
      const node: ChartNode = {
        kind: 'ledger',
        id: l.id,
        name: l.name,
        alias: l.alias,
        nature: g.nature,
        reservedCode: l.reserved_code,
        isPredefined: l.is_predefined === 1,
        isActive: l.is_active === 1,
        closing: gb.ledgers.get(l.id)?.closing ?? 0,
        children: [],
      };
      const list = ledgersByGroup.get(l.group_id);
      if (list) list.push(node);
      else ledgersByGroup.set(l.group_id, [node]);
      ledgerCount++;
    }
  }

  const build = (g: GroupTreeNode): ChartNode => ({
    kind: 'group',
    id: g.id,
    name: g.name,
    alias: g.alias,
    nature: g.nature,
    reservedCode: g.reservedCode,
    isPredefined: g.isPredefined,
    isActive: true,
    closing: gb.groups.get(g.id)?.closing ?? 0,
    children: [
      ...g.childIds.map((id) => build(tree.byId.get(id) as GroupTreeNode)),
      ...(ledgersByGroup.get(g.id) ?? []),
    ],
  });

  return {
    asOf,
    roots: tree.rootIds.map((id) => build(tree.byId.get(id) as GroupTreeNode)),
    totalDebit: gb.total.closingDebit,
    totalCredit: gb.total.closingCredit,
    groupCount: tree.order.length,
    ledgerCount,
  };
}

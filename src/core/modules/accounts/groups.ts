/**
 * Account groups: list (tree order), get, save (create/alter), delete.
 *
 * Rules:
 *  - Sub-groups always take nature and "affects gross profit" from their parent; moving a group or
 *    changing a primary group's nature updates every group below it.
 *  - Predefined groups may change only alias, sort order and the display flags.
 *  - A group cannot be placed under itself or one of its sub-groups (no cycles).
 *  - Names (and aliases) are unique across groups, case-insensitively.
 *  - Moving a group must keep the ledgers below it valid (bank details only under bank groups, tax
 *    fields only under Duties & Taxes, GST rate details only under income/expense/fixed assets).
 *  - Delete: not predefined, no sub-groups, no ledgers.
 */
import { randomUUID } from 'node:crypto';
import type { GroupNature } from '../../../shared/constants.ts';
import type { DeleteResult, GroupDetail, GroupListInput, GroupRow, GroupSaveInput, ListResult } from '../../../shared/types/accounts.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule } from '../../lib/errors.ts';
import { loadGroupTree, type GroupDbRow, type GroupTree, type GroupTreeNode } from './books.ts';
import { Issues, cleanText, joinWords, plural, requirePermission, requireSavePermission } from './common.ts';
import { fieldsFromRow, misplacedFields, type LedgerDbRow } from './ledgerRules.ts';

function ledgerCounts(db: Db, tree: GroupTree): { direct: Map<number, number>; total: Map<number, number> } {
  const direct = new Map<number, number>();
  for (const r of db.all<{ group_id: number; n: number }>('SELECT group_id, COUNT(*) AS n FROM ledgers GROUP BY group_id')) {
    direct.set(r.group_id, r.n);
  }
  const total = new Map<number, number>();
  for (const [gid, n] of direct) {
    const node = tree.byId.get(gid);
    for (const id of node ? node.chainIds : [gid]) total.set(id, (total.get(id) ?? 0) + n);
  }
  return { direct, total };
}

function toRow(n: GroupTreeNode, tree: GroupTree): GroupRow {
  const parent = n.parentId !== null ? tree.byId.get(n.parentId) : undefined;
  return {
    id: n.id,
    guid: n.guid,
    name: n.name,
    alias: n.alias,
    parentId: n.parentId,
    parentName: parent?.name ?? null,
    depth: n.depth,
    path: [...n.path],
    primaryGroupId: n.primaryId,
    primaryCode: n.primaryCode,
    nature: n.nature,
    affectsGrossProfit: n.affectsGrossProfit,
    reservedCode: n.reservedCode,
    isPredefined: n.isPredefined,
    isSubledger: n.isSubledger,
    netBalances: n.netBalances,
    usedForCalculation: n.usedForCalculation,
    sortOrder: n.sortOrder,
    childCount: n.childIds.length,
  };
}

/** Every group, depth-first in display order (parents before children). */
export function listGroups(db: Db, input: GroupListInput = {}): ListResult<GroupRow> {
  const tree = loadGroupTree(db);
  const counts = input.includeCounts ? ledgerCounts(db, tree) : null;
  const term = input.search?.trim().toLowerCase();
  const rows: GroupRow[] = [];
  for (const id of tree.order) {
    const n = tree.byId.get(id) as GroupTreeNode;
    if (term && !n.name.toLowerCase().includes(term) && !(n.alias ?? '').toLowerCase().includes(term)) continue;
    const row = toRow(n, tree);
    if (counts) {
      row.ledgerCount = counts.direct.get(id) ?? 0;
      row.totalLedgerCount = counts.total.get(id) ?? 0;
    }
    rows.push(row);
  }
  return { rows, total: rows.length };
}

export function getGroup(db: Db, id: number): GroupDetail {
  const tree = loadGroupTree(db);
  const n = tree.byId.get(id);
  if (!n) throw notFound('Group', id);
  const counts = ledgerCounts(db, tree);
  return {
    ...toRow(n, tree),
    ledgerCount: counts.direct.get(id) ?? 0,
    totalLedgerCount: counts.total.get(id) ?? 0,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

/** Name/alias must not equal another group's name or alias. */
function checkGroupNames(db: Db, name: string | null, alias: string | null, excludeId: number, issues: Issues): void {
  const clash = (value: string): { name: string } | undefined =>
    db.get<{ name: string }>('SELECT name FROM groups WHERE (name = :v OR alias = :v COLLATE NOCASE) AND id <> :ex LIMIT 1', {
      v: value,
      ex: excludeId,
    });
  if (name) {
    const c = clash(name);
    if (c) {
      issues.add(
        'name',
        c.name.toLowerCase() === name.toLowerCase()
          ? `A group named '${c.name}' already exists. Choose a different name.`
          : `'${name}' is already the alias of group '${c.name}'. Choose a different name.`,
      );
    }
  }
  if (alias) {
    const c = clash(alias);
    if (c) issues.add('alias', `Alias '${alias}' is already used by group '${c.name}'. Choose a different alias.`);
  }
}

function groupRow(db: Db, id: number): GroupDbRow | undefined {
  return db.get<GroupDbRow>('SELECT * FROM groups WHERE id = :id', { id });
}

/**
 * After a move/nature change: every ledger below `rootId` must still satisfy the placement rules.
 * Throws BUSINESS_RULE naming the first offending ledgers.
 */
function assertLedgersStillValid(db: Db, rootId: number, groupName: string): void {
  const tree = loadGroupTree(db);
  const ids = tree.order.filter((id) => tree.byId.get(id)?.chainIds.includes(rootId));
  const ledgers = db.all<LedgerDbRow>('SELECT * FROM ledgers WHERE group_id IN (SELECT value FROM json_each(:ids)) ORDER BY name', {
    ids: JSON.stringify(ids),
  });
  const offenders: Array<{ name: string; message: string }> = [];
  for (const l of ledgers) {
    const node = tree.byId.get(l.group_id);
    if (!node) continue;
    const bad = misplacedFields(fieldsFromRow(l), node.cls);
    if (bad.length > 0) offenders.push({ name: l.name, message: bad[0].message });
  }
  if (offenders.length > 0) {
    const names = offenders.slice(0, 3).map((o) => `'${o.name}'`);
    const more = offenders.length > 3 ? ` and ${offenders.length - 3} more` : '';
    throw rule(
      `Group '${groupName}' cannot be moved there: ledger ${joinWords(names)}${more} would no longer be valid (${offenders[0].message.toLowerCase()}). ` +
        'Alter or move those ledgers first.',
      { ledgers: offenders.map((o) => o.name) },
    );
  }
}

const nextSortOrder = (db: Db): number => (db.value<number>('SELECT COALESCE(MAX(sort_order), 0) FROM groups') ?? 0) + 10;

function createGroup(ctx: CompanyCtx, input: GroupSaveInput): number {
  const { db } = ctx;
  const issues = new Issues();
  const name = cleanText(input.name);
  let alias = cleanText(input.alias);
  if (!name) issues.add('name', 'Group name is required');
  if (alias && name && alias.toLowerCase() === name.toLowerCase()) alias = null;

  let nature: GroupNature | undefined;
  let agp = false;
  const parentId = input.parentId ?? null;
  if (parentId !== null) {
    const parent = groupRow(db, parentId);
    if (!parent) issues.add('parentId', 'The selected parent group does not exist');
    else {
      nature = parent.nature;
      agp = parent.affects_gross_profit === 1;
    }
  } else {
    nature = input.nature;
    if (!nature) issues.add('nature', 'Choose the nature of a primary group: Assets, Liabilities, Income or Expenses');
    agp = input.affectsGrossProfit ?? false;
    if (agp && nature && (nature === 'assets' || nature === 'liabilities')) {
      issues.add('affectsGrossProfit', 'Only income and expense groups can affect gross profit');
    }
  }
  checkGroupNames(db, name, alias, 0, issues);
  issues.throwIfAny();

  const ts = ctx.clock.now().toISOString();
  const guid = randomUUID();
  const id = db.run(
    `INSERT INTO groups (guid, name, alias, parent_id, nature, affects_gross_profit, reserved_code, is_predefined, is_subledger,
                         net_balances, used_for_calculation, sort_order, created_at, updated_at)
     VALUES (:guid, :name, :alias, :parentId, :nature, :agp, NULL, 0, :sub, :net, :calc, :sort, :ts, :ts)`,
    {
      guid,
      name,
      alias,
      parentId,
      nature,
      agp,
      sub: input.isSubledger ?? false,
      net: input.netBalances ?? false,
      calc: input.usedForCalculation ?? false,
      sort: input.sortOrder ?? nextSortOrder(db),
      ts,
    },
  ).lastInsertRowid;
  ctx.audit({ action: 'create', entityType: 'group', entityId: id, entityGuid: guid, entityLabel: name ?? '', after: getGroup(db, id) });
  return id;
}

function alterGroup(ctx: CompanyCtx, id: number, input: GroupSaveInput): number {
  const { db } = ctx;
  const row = groupRow(db, id);
  if (!row) throw notFound('Group', id);
  const before = getGroup(db, id);
  const issues = new Issues();

  let name = row.name;
  let parentId = row.parent_id;
  let nature = row.nature;
  let agp = row.affects_gross_profit === 1;
  let alias = input.alias === undefined ? row.alias : cleanText(input.alias);

  if (row.is_predefined === 1) {
    const what = `'${row.name}' is a predefined group`;
    if (input.name !== undefined && cleanText(input.name) !== row.name) issues.add('name', `${what} and cannot be renamed. You can give it an alias.`);
    if (input.parentId !== undefined && input.parentId !== row.parent_id) issues.add('parentId', `${what} and cannot be moved under another group`);
    if (input.nature !== undefined && input.nature !== row.nature) issues.add('nature', `${what}; its nature cannot be changed`);
    if (input.affectsGrossProfit !== undefined && input.affectsGrossProfit !== agp)
      issues.add('affectsGrossProfit', `${what}; whether it affects gross profit cannot be changed`);
  } else {
    if (input.name !== undefined) {
      const n = cleanText(input.name);
      if (!n) issues.add('name', 'Group name is required');
      else name = n;
    }
    if (input.parentId !== undefined) parentId = input.parentId;
    if (parentId !== null) {
      const parent = groupRow(db, parentId);
      if (!parent) issues.add('parentId', 'The selected parent group does not exist');
      else {
        const tree = loadGroupTree(db);
        if (parentId === id || tree.byId.get(parentId)?.chainIds.includes(id)) {
          issues.add('parentId', 'A group cannot be placed under itself or under one of its own sub-groups');
        }
        nature = parent.nature;
        agp = parent.affects_gross_profit === 1;
      }
    } else {
      if (input.nature !== undefined) nature = input.nature;
      if (input.affectsGrossProfit !== undefined) agp = input.affectsGrossProfit;
      if (agp && (nature === 'assets' || nature === 'liabilities')) {
        if (input.affectsGrossProfit === true) issues.add('affectsGrossProfit', 'Only income and expense groups can affect gross profit');
        agp = false;
      }
    }
  }
  if (alias && alias.toLowerCase() === name.toLowerCase()) alias = null;
  checkGroupNames(db, name !== row.name ? name : null, alias !== row.alias ? alias : null, id, issues);
  issues.throwIfAny();

  const ts = ctx.clock.now().toISOString();
  db.run(
    `UPDATE groups SET name = :name, alias = :alias, parent_id = :parentId, nature = :nature, affects_gross_profit = :agp,
            is_subledger = :sub, net_balances = :net, used_for_calculation = :calc, sort_order = :sort, updated_at = :ts
      WHERE id = :id`,
    {
      id,
      name,
      alias,
      parentId,
      nature,
      agp,
      sub: input.isSubledger ?? row.is_subledger === 1,
      net: input.netBalances ?? row.net_balances === 1,
      calc: input.usedForCalculation ?? row.used_for_calculation === 1,
      sort: input.sortOrder ?? row.sort_order,
      ts,
    },
  );

  const structural = parentId !== row.parent_id || nature !== row.nature || agp !== (row.affects_gross_profit === 1);
  if (structural) {
    // Sub-groups inherit nature and gross-profit treatment.
    db.run(
      `WITH RECURSIVE sub(id) AS (SELECT id FROM groups WHERE parent_id = :id UNION SELECT g.id FROM groups g JOIN sub s ON g.parent_id = s.id)
       UPDATE groups SET nature = :nature, affects_gross_profit = :agp, updated_at = :ts WHERE id IN (SELECT id FROM sub)`,
      { id, nature, agp, ts },
    );
    assertLedgersStillValid(db, id, name);
  }
  ctx.audit({ action: 'alter', entityType: 'group', entityId: id, entityGuid: row.guid, entityLabel: name, before, after: getGroup(db, id) });
  return id;
}

/** Create (no id) or alter (id) a group. Requires masters.create / masters.alter. */
export function saveGroup(ctx: CompanyCtx, input: GroupSaveInput): GroupDetail {
  requireSavePermission(ctx, input.id);
  const id = ctx.db.transaction(() => (input.id === undefined ? createGroup(ctx, input) : alterGroup(ctx, input.id, input)));
  return getGroup(ctx.db, id);
}

/** Delete a user-created group without sub-groups or ledgers. Requires masters.delete. */
export function deleteGroup(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete');
  const { db } = ctx;
  return db.transaction(() => {
    const row = groupRow(db, id);
    if (!row) throw notFound('Group', id);
    if (row.is_predefined === 1) throw rule(`'${row.name}' is a predefined group and cannot be deleted.`);
    const children = db.all<{ name: string }>('SELECT name FROM groups WHERE parent_id = :id ORDER BY name', { id }).map((c) => `'${c.name}'`);
    if (children.length > 0) {
      throw rule(
        `Group '${row.name}' has ${plural(children.length, 'sub-group')} (${joinWords(children.slice(0, 5))}${children.length > 5 ? ', …' : ''}). Move or delete ${children.length === 1 ? 'it' : 'them'} first.`,
      );
    }
    const ledgers = db.value<number>('SELECT COUNT(*) FROM ledgers WHERE group_id = :id', { id }) ?? 0;
    if (ledgers > 0) {
      throw rule(`Group '${row.name}' contains ${plural(ledgers, 'ledger')}. Move ${ledgers === 1 ? 'it' : 'them'} to another group or delete ${ledgers === 1 ? 'it' : 'them'} first.`);
    }
    const before = getGroup(db, id);
    db.run('DELETE FROM groups WHERE id = :id', { id });
    ctx.audit({ action: 'delete', entityType: 'group', entityId: id, entityGuid: row.guid, entityLabel: row.name, before });
    return { id, deleted: true };
  });
}

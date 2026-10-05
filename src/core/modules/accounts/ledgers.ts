/**
 * Ledger masters: list, picker, get, save (create/alter), delete, bulk create, balances and the
 * opening-balance summary. Rules live in ledgerRules.ts.
 *
 * For the vouchers team: only ledgers for which isLedgerUsable() is true may be used in NEW vouchers
 * (inactive ledgers are hidden from pickers). Use assertLedgerUsable() to get a user-facing error.
 */
import { randomUUID } from 'node:crypto';
import type { FieldIssue } from '../../../shared/api.ts';
import { formatDrCr } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  DeleteResult,
  GstRateHistoryRow,
  LedgerBalance,
  LedgerBalanceInput,
  LedgerBulkCreateInput,
  LedgerBulkCreateResult,
  LedgerClass,
  LedgerClassName,
  LedgerDetail,
  LedgerFields,
  LedgerListInput,
  LedgerListRow,
  LedgerPickerInput,
  LedgerPickerRow,
  LedgerSaveInput,
  ListResult,
  OpeningBalanceSummary,
  OpeningBill,
  OpeningBillInput,
} from '../../../shared/types/accounts.ts';
import type { RegistrationType, SupplyKind, Taxability } from '../../../shared/types/gst.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, notFound, rule } from '../../lib/errors.ts';
import { getConfig, getFeatures } from '../company/service.ts';
import { BOOKS_FILTER, classFromChain, closingBalances, groupChain, ledgerBalance, ledgerClassNames, loadGroupTree, type GroupTree } from './books.ts';
import { Issues, assertRange, joinWords, likePattern, plural, requirePermission, requireSavePermission } from './common.ts';
import {
  LEDGER_COLUMNS,
  defaultLedgerFields,
  fieldsFromRow,
  mergeLedgerInput,
  rowParams,
  validateLedger,
  type LedgerDbRow,
} from './ledgerRules.ts';

// ───────────────────────────── Reading ─────────────────────────────

export function loadLedgerRow(db: Db, id: number): LedgerDbRow | undefined {
  return db.get<LedgerDbRow>('SELECT * FROM ledgers WHERE id = :id', { id });
}

function loadBills(db: Db, ledgerId: number): OpeningBill[] {
  return db
    .all<{ id: number; bill_name: string; bill_date: string; due_date: string | null; amount: number }>(
      'SELECT id, bill_name, bill_date, due_date, amount FROM opening_bills WHERE ledger_id = :id ORDER BY bill_date, id',
      { id: ledgerId },
    )
    .map((b) => ({ id: b.id, billName: b.bill_name, billDate: b.bill_date, dueDate: b.due_date, amount: b.amount }));
}

function loadGstHistory(db: Db, ledgerId: number): GstRateHistoryRow[] {
  return db
    .all<{
      id: number;
      applicable_from: string;
      hsn_sac: string | null;
      taxability: Taxability;
      rate: number;
      cess_rate: number;
      cess_per_unit: number;
    }>(
      `SELECT id, applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
        WHERE entity_type = 'ledger' AND entity_id = :id ORDER BY applicable_from`,
      { id: ledgerId },
    )
    .map((r) => ({
      id: r.id,
      applicableFrom: r.applicable_from,
      hsnSac: r.hsn_sac,
      taxability: r.taxability,
      rate: r.rate,
      cessRate: r.cess_rate,
      cessPerUnit: r.cess_per_unit,
    }));
}

/** Stable before/after image for the audit log (no computed balances). */
export function ledgerSnapshot(db: Db, id: number): Record<string, unknown> | null {
  const row = loadLedgerRow(db, id);
  if (!row) return null;
  return {
    id: row.id,
    guid: row.guid,
    reservedCode: row.reserved_code,
    ...fieldsFromRow(row),
    openingBills: loadBills(db, id).map(({ id: _id, ...b }) => b),
    gstRateHistory: loadGstHistory(db, id).map(({ id: _id, ...h }) => h),
  };
}

export function getLedger(db: Db, id: number, today: string, tree: GroupTree = loadGroupTree(db)): LedgerDetail {
  const row = loadLedgerRow(db, id);
  if (!row) throw notFound('Ledger', id);
  const g = tree.byId.get(row.group_id);
  const voucherCount = db.value<number>('SELECT COUNT(DISTINCT voucher_id) FROM ledger_entries WHERE ledger_id = :id', { id }) ?? 0;
  return {
    id: row.id,
    guid: row.guid,
    ...fieldsFromRow(row),
    groupName: g?.name ?? '',
    groupPath: g?.path ?? [],
    primaryGroupCode: g?.primaryCode ?? null,
    reservedCode: row.reserved_code,
    isPredefined: row.is_predefined === 1,
    classes: g ? [...g.classNames] : [],
    openingBills: loadBills(db, id),
    gstRateHistory: loadGstHistory(db, id),
    closingBalance: ledgerBalance(db, id, { to: today, today }).closing,
    voucherCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ───────────────────────────── Save ─────────────────────────────

function companyBasics(db: Db): { stateCode: string | null; booksFrom: string } {
  const c = db.get<{ state_code: string | null; books_from: string }>('SELECT state_code, books_from FROM company WHERE id = 1');
  if (!c) throw notFound('Company');
  return { stateCode: c.state_code, booksFrom: c.books_from };
}

function saveContext(db: Db, tree: GroupTree): SaveContext {
  return { tree, company: companyBasics(db), billWiseFeature: getFeatures(db).billWise };
}

const INSERT_COLS = LEDGER_COLUMNS.map(([, col]) => col);
const INSERT_SQL = `INSERT INTO ledgers (guid, ${INSERT_COLS.join(', ')}, created_at, updated_at)
  VALUES (:guid, ${INSERT_COLS.map((c) => `:${c}`).join(', ')}, :ts, :ts)`;
const UPDATE_SQL = `UPDATE ledgers SET ${INSERT_COLS.map((c) => `${c} = :${c}`).join(', ')}, updated_at = :ts WHERE id = :id`;

/** GST details define a rate when GST applies and either a rate or a non-taxable taxability is set. */
const definesRate = (f: LedgerFields): boolean =>
  f.gstApplicable && (f.gstRate !== null || (f.gstTaxability !== null && f.gstTaxability !== 'taxable'));

function gstDetailsChanged(before: LedgerFields | null, after: LedgerFields): boolean {
  if (!before || !definesRate(before)) return true;
  return (
    before.gstRate !== after.gstRate ||
    before.hsnSac !== after.hsnSac ||
    before.gstTaxability !== after.gstTaxability ||
    (before.cessRate ?? 0) !== (after.cessRate ?? 0)
  );
}

/**
 * Keep gst_rate_history in step with the ledger's GST details:
 *  - with `applicableFrom`: upsert a row effective from that date (older rows are kept);
 *  - without it: correct the latest row (or create the first one, effective from the books beginning).
 * The ledger's own GST columns always mirror the LATEST history row, so after a back-dated entry they
 * are re-synchronised from it.
 */
function writeGstHistory(db: Db, id: number, before: LedgerFields | null, after: LedgerFields, applicableFrom: string | undefined, booksFrom: string): void {
  if (!definesRate(after) || !gstDetailsChanged(before, after)) return;
  const latestDate = (): string | undefined =>
    db.value<string>(
      `SELECT applicable_from FROM gst_rate_history WHERE entity_type = 'ledger' AND entity_id = :id ORDER BY applicable_from DESC LIMIT 1`,
      { id },
    );
  const from = applicableFrom ?? latestDate() ?? booksFrom;
  db.run(
    `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate)
     VALUES ('ledger', :id, :from, :hsn, :tax, :rate, :cess)
     ON CONFLICT (entity_type, entity_id, applicable_from)
     DO UPDATE SET hsn_sac = excluded.hsn_sac, taxability = excluded.taxability, rate = excluded.rate, cess_rate = excluded.cess_rate`,
    { id, from, hsn: after.hsnSac, tax: after.gstTaxability ?? 'taxable', rate: after.gstRate ?? 0, cess: after.cessRate ?? 0 },
  );
  if (from !== latestDate()) {
    db.run(
      `UPDATE ledgers SET (hsn_sac, gst_taxability, gst_rate, cess_rate) =
              (SELECT hsn_sac, taxability, rate, cess_rate FROM gst_rate_history
                WHERE entity_type = 'ledger' AND entity_id = :id ORDER BY applicable_from DESC LIMIT 1)
        WHERE id = :id`,
      { id },
    );
  }
}

interface SaveContext {
  tree: GroupTree;
  company: { stateCode: string | null; booksFrom: string };
  /** Company feature F11 "maintain bill-wise details". */
  billWiseFeature: boolean;
}

/** Validate and write one ledger (no permission check, caller provides the transaction). Returns its id. */
function saveLedgerTx(ctx: CompanyCtx, input: LedgerSaveInput, sc: SaveContext): number {
  const { db } = ctx;
  const row = input.id !== undefined ? loadLedgerRow(db, input.id) : undefined;
  if (input.id !== undefined && !row) throw notFound('Ledger', input.id);
  const existing = row ? fieldsFromRow(row) : null;
  const { fields, provided } = mergeLedgerInput(input, existing ?? defaultLedgerFields());
  // New customers/suppliers keep bills by default when bill-wise details are enabled (F11), as in Tally.
  if (!row && !provided.has('billWise') && sc.billWiseFeature && sc.tree.byId.get(fields.groupId)?.cls.isParty) fields.billWise = true;

  const billsProvided = Array.isArray(input.openingBills);
  const bills: OpeningBillInput[] = billsProvided
    ? (input.openingBills as OpeningBillInput[]).map((b) => ({ ...b }))
    : row
      ? loadBills(db, row.id).map(({ id: _id, ...b }) => b)
      : [];

  const issues = new Issues();
  validateLedger(
    fields,
    bills,
    {
      db,
      id: row ? row.id : null,
      existing,
      reservedCode: row?.reserved_code ?? null,
      tree: sc.tree,
      provided,
      companyStateCode: sc.company.stateCode,
      booksFrom: sc.company.booksFrom,
      allowNonStandardRate: input.allowNonStandardRate === true,
      billsProvided,
    },
    issues,
  );
  issues.throwIfAny();

  const ts = ctx.clock.now().toISOString();
  const before = row ? ledgerSnapshot(db, row.id) : null;
  let id: number;
  let guid: string;
  if (!row) {
    guid = randomUUID();
    id = db.run(INSERT_SQL, { ...rowParams(fields), guid, ts }).lastInsertRowid;
  } else {
    id = row.id;
    guid = row.guid;
    db.run(UPDATE_SQL, { ...rowParams(fields), ts, id });
  }
  if (!row || billsProvided) {
    db.run('DELETE FROM opening_bills WHERE ledger_id = :id', { id });
    for (const b of bills) {
      db.run(
        'INSERT INTO opening_bills (ledger_id, bill_name, bill_date, due_date, amount) VALUES (:id, :name, :date, :due, :amount)',
        { id, name: b.billName, date: b.billDate, due: b.dueDate ?? null, amount: b.amount },
      );
    }
  }
  writeGstHistory(db, id, existing, fields, input.applicableFrom, sc.company.booksFrom);

  ctx.audit({
    action: row ? 'alter' : 'create',
    entityType: 'ledger',
    entityId: id,
    entityGuid: guid,
    entityLabel: fields.name,
    before: before ?? undefined,
    after: ledgerSnapshot(db, id),
  });
  return id;
}

/** Create (no id) or alter (id) a ledger. Requires masters.create / masters.alter. */
export function saveLedger(ctx: CompanyCtx, input: LedgerSaveInput): LedgerDetail {
  requireSavePermission(ctx, input.id);
  const tree = loadGroupTree(ctx.db);
  const id = ctx.db.transaction(() => saveLedgerTx(ctx, input, saveContext(ctx.db, tree)));
  return getLedger(ctx.db, id, ctx.clock.today(), tree);
}

/**
 * Tally-style "multiple ledgers" creation. All-or-nothing: if any row is invalid nothing is created
 * and the VALIDATION error lists every problem with paths like `rows[3].gstin`.
 */
export function bulkCreateLedgers(ctx: CompanyCtx, input: LedgerBulkCreateInput): LedgerBulkCreateResult {
  requirePermission(ctx, 'masters.create');
  const { db } = ctx;
  const sc = saveContext(db, loadGroupTree(db));
  return db.transaction(() => {
    const ids: number[] = [];
    const problems: FieldIssue[] = [];
    let badRows = 0;
    input.rows.forEach((r, i) => {
      const label = `Row ${i + 1}${r.name?.trim() ? ` ('${r.name.trim()}')` : ''}`;
      try {
        ids.push(
          db.transaction(() =>
            saveLedgerTx(ctx, { name: r.name, groupId: r.groupId, openingBalance: r.openingBalance ?? 0, gstin: r.gstin ?? null, stateCode: r.stateCode ?? null }, sc),
          ),
        );
      } catch (err) {
        if (!(err instanceof AppError) || err.code === 'INTERNAL') throw err;
        badRows++;
        const details = Array.isArray(err.details) ? (err.details as FieldIssue[]) : [];
        if (err.code === 'VALIDATION' && details.length > 0) {
          for (const d of details) problems.push({ path: `rows[${i}].${d.path}`, message: `${label}: ${d.message}` });
        } else {
          problems.push({ path: `rows[${i}]`, message: `${label}: ${err.message}` });
        }
      }
    });
    if (problems.length > 0) {
      throw new AppError(
        'VALIDATION',
        `${badRows} of ${plural(input.rows.length, 'row')} ${badRows === 1 ? 'has' : 'have'} errors, so no ledgers were created. Correct ${badRows === 1 ? 'it' : 'them'} and try again.`,
        problems,
      );
    }
    return { created: ids.length, ids };
  });
}

// ───────────────────────────── Delete ─────────────────────────────

export interface LedgerUsage {
  /** Distinct vouchers referring to the ledger in any way. */
  vouchers: number;
  entries: number;
  billAllocations: number;
  costAllocations: number;
  inventoryLines: number;
  gstLines: number;
  bankStatementLines: number;
  openingBills: number;
  /** Voucher types that use it as a default ledger. */
  voucherTypes: string[];
  /** It is the bank printed on invoices (F12 configuration). */
  companyInvoiceBank: boolean;
}

export function ledgerUsage(db: Db, id: number): LedgerUsage {
  const count = (sql: string): number => db.value<number>(sql, { id }) ?? 0;
  return {
    vouchers: count(
      `SELECT COUNT(*) FROM (
         SELECT voucher_id FROM ledger_entries WHERE ledger_id = :id
         UNION SELECT voucher_id FROM bill_allocations WHERE ledger_id = :id
         UNION SELECT voucher_id FROM cost_allocations WHERE ledger_id = :id
         UNION SELECT voucher_id FROM inventory_entries WHERE ledger_id = :id
         UNION SELECT voucher_id FROM gst_lines WHERE ledger_id = :id
         UNION SELECT id FROM vouchers WHERE party_ledger_id = :id)`,
    ),
    entries: count('SELECT COUNT(*) FROM ledger_entries WHERE ledger_id = :id'),
    billAllocations: count('SELECT COUNT(*) FROM bill_allocations WHERE ledger_id = :id'),
    costAllocations: count('SELECT COUNT(*) FROM cost_allocations WHERE ledger_id = :id'),
    inventoryLines: count('SELECT COUNT(*) FROM inventory_entries WHERE ledger_id = :id'),
    gstLines: count('SELECT COUNT(*) FROM gst_lines WHERE ledger_id = :id'),
    bankStatementLines: count('SELECT COUNT(*) FROM bank_statement_lines WHERE ledger_id = :id'),
    openingBills: count('SELECT COUNT(*) FROM opening_bills WHERE ledger_id = :id'),
    voucherTypes: db
      .all<{ name: string }>(
        `SELECT name FROM voucher_types
          WHERE json_valid(config) AND (json_extract(config, '$.defaultLedgerId') = :id
             OR json_extract(config, '$.defaultPartyLedgerId') = :id OR json_extract(config, '$.bankLedgerId') = :id)
          ORDER BY name`,
        { id },
      )
      .map((r) => r.name),
    companyInvoiceBank: getConfig(db).invoice.bankLedgerId === id,
  };
}

const isFkError = (err: unknown): boolean => err instanceof Error && (err as { errcode?: unknown }).errcode === 787;

/**
 * Delete a ledger that has never been used. Refuses (BUSINESS_RULE, with a count of the vouchers using
 * it) when it is predefined, used in vouchers, bank statements or voucher-type defaults, or still has
 * opening bills / an opening balance. Requires masters.delete.
 */
export function deleteLedger(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete');
  const { db } = ctx;
  return db.transaction(() => {
    const row = loadLedgerRow(db, id);
    if (!row) throw notFound('Ledger', id);
    if (row.reserved_code !== null || row.is_predefined === 1) {
      throw rule(`'${row.name}' is a predefined ledger and cannot be deleted. You can rename it instead.`);
    }
    const u = ledgerUsage(db, id);
    const reasons: string[] = [];
    if (u.vouchers > 0) reasons.push(`it is used in ${plural(u.vouchers, 'voucher')}`);
    if (u.bankStatementLines > 0) reasons.push(`it has ${plural(u.bankStatementLines, 'imported bank statement line')}`);
    if (u.voucherTypes.length > 0) reasons.push(`it is a default ledger of voucher type ${joinWords(u.voucherTypes.map((n) => `'${n}'`))}`);
    if (u.companyInvoiceBank) reasons.push('it is the bank printed on invoices (F12 Configuration)');
    if (u.openingBills > 0) reasons.push(`it has ${plural(u.openingBills, 'opening bill')}`);
    if (row.opening_balance !== 0) reasons.push(`it has an opening balance of ₹ ${formatDrCr(row.opening_balance)}`);
    if (reasons.length > 0) {
      const hint =
        u.vouchers > 0
          ? ' Mark it inactive instead (Alter ledger → Active: No) so that it no longer appears in new vouchers.'
          : ' Remove these first, then delete the ledger.';
      throw rule(`Ledger '${row.name}' cannot be deleted: ${joinWords(reasons)}.${hint}`, u);
    }
    const before = ledgerSnapshot(db, id);
    db.run(`DELETE FROM gst_rate_history WHERE entity_type = 'ledger' AND entity_id = :id`, { id });
    try {
      db.run('DELETE FROM ledgers WHERE id = :id', { id });
    } catch (err) {
      if (isFkError(err)) throw rule(`Ledger '${row.name}' cannot be deleted: other records still refer to it. Mark it inactive instead.`);
      throw err;
    }
    ctx.audit({ action: 'delete', entityType: 'ledger', entityId: id, entityGuid: row.guid, entityLabel: row.name, before });
    return { id, deleted: true };
  });
}

// ───────────────────────────── Usability (for vouchers) ─────────────────────────────

export interface LedgerInfo extends LedgerFields {
  id: number;
  guid: string;
  reservedCode: LedgerDetail['reservedCode'];
  isPredefined: boolean;
  /** Classification from the group chain (cash/bank/party/sales/…). */
  cls: LedgerClass;
  classes: LedgerClassName[];
}

/**
 * Everything the posting engine needs about one ledger, without balances (two queries).
 * Throws NOT_FOUND for an unknown id.
 */
export function ledgerInfo(db: Db, id: number): LedgerInfo {
  const row = loadLedgerRow(db, id);
  if (!row) throw notFound('Ledger', id);
  const cls = classFromChain(groupChain(db, row.group_id));
  return {
    id: row.id,
    guid: row.guid,
    reservedCode: row.reserved_code,
    isPredefined: row.is_predefined === 1,
    ...fieldsFromRow(row),
    cls,
    classes: ledgerClassNames(cls),
  };
}

/** True when the ledger exists and is active. Only usable ledgers may be used in NEW vouchers. */
export function isLedgerUsable(db: Db, ledgerId: number): boolean {
  return db.value<number>('SELECT is_active FROM ledgers WHERE id = :id', { id: ledgerId }) === 1;
}

/** Throw NOT_FOUND / BUSINESS_RULE (user-facing) unless isLedgerUsable(). */
export function assertLedgerUsable(db: Db, ledgerId: number): void {
  const row = db.get<{ name: string; is_active: number }>('SELECT name, is_active FROM ledgers WHERE id = :id', { id: ledgerId });
  if (!row) throw notFound('Ledger', ledgerId);
  if (row.is_active !== 1) {
    throw rule(`Ledger '${row.name}' is inactive and cannot be used in new vouchers. Alter the ledger and set Active to Yes to use it again.`, {
      ledgerId,
    });
  }
}

export interface LedgerGstRate {
  /** null when taken from the ledger master (no history row covers the date). */
  applicableFrom: string | null;
  hsnSac: string | null;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  /** Paise per unit. */
  cessPerUnit: Paise;
  supplyType: SupplyKind | null;
}

/**
 * GST details of a sales/purchase/income/expense ledger in force on `date`: the latest
 * gst_rate_history row on or before the date, else the ledger's current values. null when GST is not
 * applicable on the ledger or it defines no rate (the rate then comes from items / line overrides).
 */
export function ledgerGstRateOn(db: Db, ledgerId: number, date: string): LedgerGstRate | null {
  const row = loadLedgerRow(db, ledgerId);
  if (!row) throw notFound('Ledger', ledgerId);
  const f = fieldsFromRow(row);
  if (!f.gstApplicable) return null;
  const h = db.get<{ applicable_from: string; hsn_sac: string | null; taxability: Taxability; rate: number; cess_rate: number; cess_per_unit: number }>(
    `SELECT applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
      WHERE entity_type = 'ledger' AND entity_id = :id AND applicable_from <= :date ORDER BY applicable_from DESC LIMIT 1`,
    { id: ledgerId, date },
  );
  if (h) {
    return {
      applicableFrom: h.applicable_from,
      hsnSac: h.hsn_sac,
      taxability: h.taxability,
      rate: h.rate,
      cessRate: h.cess_rate,
      cessPerUnit: h.cess_per_unit,
      supplyType: f.gstSupplyType,
    };
  }
  if (!definesRate(f)) return null;
  return {
    applicableFrom: null,
    hsnSac: f.hsnSac,
    taxability: f.gstTaxability ?? 'taxable',
    rate: f.gstRate ?? 0,
    cessRate: f.cessRate ?? 0,
    cessPerUnit: 0,
    supplyType: f.gstSupplyType,
  };
}

// ───────────────────────────── Lists & picker ─────────────────────────────

/**
 * Group ids a ledger list is restricted to (null = no restriction): the given groups (with their
 * sub-groups unless includeSubgroups is false) intersected with the groups whose ledgers match ANY
 * of `classes`.
 */
export function resolveGroupFilter(
  tree: GroupTree,
  f: { groupIds?: readonly number[]; includeSubgroups?: boolean; classes?: readonly string[] },
): number[] | null {
  let set: Set<number> | null = null;
  if (f.groupIds && f.groupIds.length > 0) {
    const wanted = new Set(f.groupIds);
    set = new Set();
    for (const id of tree.order) {
      const node = tree.byId.get(id);
      if (!node) continue;
      if (f.includeSubgroups === false ? wanted.has(id) : node.chainIds.some((c) => wanted.has(c))) set.add(id);
    }
  }
  if (f.classes && f.classes.length > 0) {
    const classes = f.classes;
    const byClass = new Set<number>();
    for (const id of tree.order) {
      const node = tree.byId.get(id);
      if (node && classes.some((c) => (node.classNames as readonly string[]).includes(c))) byClass.add(id);
    }
    set = set ? new Set([...set].filter((id) => byClass.has(id))) : byClass;
  }
  return set ? [...set] : null;
}

interface ListDbRow {
  id: number;
  name: string;
  alias: string | null;
  group_id: number;
  gstin: string | null;
  state_code: string | null;
  gst_registration_type: RegistrationType | null;
  maintain_bill_wise: number;
  reserved_code: LedgerListRow['reservedCode'];
  is_predefined: number;
  is_active: number;
}

export const LEDGER_LIST_DEFAULT_LIMIT = 100;
export const LEDGER_LIST_MAX_LIMIT = 10_000;

export function listLedgers(db: Db, input: LedgerListInput, today: string): ListResult<LedgerListRow> {
  const tree = loadGroupTree(db);
  const groupIds = resolveGroupFilter(tree, input);
  if (groupIds && groupIds.length === 0) return { rows: [], total: 0 };

  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (groupIds) {
    where.push('l.group_id IN (SELECT value FROM json_each(:groupIds))');
    params.groupIds = JSON.stringify(groupIds);
  }
  const term = input.search?.trim();
  if (term) {
    where.push(`(l.name LIKE :q ESCAPE '\\' OR l.alias LIKE :q ESCAPE '\\' OR l.gstin LIKE :q ESCAPE '\\')`);
    params.q = likePattern(term);
  }
  if (input.activeOnly) where.push('l.is_active = 1');
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.value<number>(`SELECT COUNT(*) FROM ledgers l ${whereSql}`, params) ?? 0;
  const limit = Math.min(Math.max(1, input.limit ?? LEDGER_LIST_DEFAULT_LIMIT), LEDGER_LIST_MAX_LIMIT);
  const offset = Math.max(0, input.offset ?? 0);
  const rows = db.all<ListDbRow>(
    `SELECT l.id, l.name, l.alias, l.group_id, l.gstin, l.state_code, l.gst_registration_type, l.maintain_bill_wise,
            l.reserved_code, l.is_predefined, l.is_active
       FROM ledgers l ${whereSql} ORDER BY l.name, l.id LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset },
  );
  const balances = input.withBalance
    ? closingBalances(db, { asOf: input.asOf ?? today, today, ledgerIds: rows.map((r) => r.id) })
    : null;

  return {
    total,
    rows: rows.map((r) => {
      const g = tree.byId.get(r.group_id);
      const out: LedgerListRow = {
        id: r.id,
        name: r.name,
        alias: r.alias,
        groupId: r.group_id,
        groupName: g?.name ?? '',
        primaryGroupCode: g?.primaryCode ?? null,
        classes: g ? [...g.classNames] : [],
        gstin: r.gstin,
        stateCode: r.state_code,
        registrationType: r.gst_registration_type,
        billWise: r.maintain_bill_wise === 1,
        reservedCode: r.reserved_code,
        isPredefined: r.is_predefined === 1,
        isActive: r.is_active === 1,
      };
      if (balances) out.closingBalance = balances.get(r.id) ?? 0;
      return out;
    }),
  };
}

/**
 * Every matching ledger in compact form for type-ahead pickers (voucher entry). One query: ledgers
 * with their closing balance from a correlated aggregate over the covering index idx_le_books.
 * Inactive ledgers are left out unless includeInactive.
 */
export function ledgerPicker(db: Db, input: LedgerPickerInput, today: string): LedgerPickerRow[] {
  const tree = loadGroupTree(db);
  const groupIds = resolveGroupFilter(tree, input);
  if (groupIds && groupIds.length === 0) return [];
  const where: string[] = [];
  const params: Record<string, string> = { asOf: input.asOf ?? today, today };
  if (groupIds) {
    where.push('l.group_id IN (SELECT value FROM json_each(:groupIds))');
    params.groupIds = JSON.stringify(groupIds);
  }
  if (!input.includeInactive) where.push('l.is_active = 1');
  const rows = db.all<{
    id: number;
    name: string;
    alias: string | null;
    group_id: number;
    gstin: string | null;
    state_code: string | null;
    gst_registration_type: RegistrationType | null;
    maintain_bill_wise: number;
    is_active: number;
    bal: number;
  }>(
    `SELECT l.id, l.name, l.alias, l.group_id, l.gstin, l.state_code, l.gst_registration_type, l.maintain_bill_wise, l.is_active,
            l.opening_balance + COALESCE((SELECT SUM(le.amount) FROM ledger_entries le
                                          WHERE le.ledger_id = l.id AND le.date <= :asOf AND ${BOOKS_FILTER('le')}), 0) AS bal
       FROM ledgers l ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.name`,
    params,
  );
  return rows.map((r) => {
    const g = tree.byId.get(r.group_id);
    return {
      id: r.id,
      name: r.name,
      alias: r.alias,
      groupId: r.group_id,
      groupName: g?.name ?? '',
      classes: g ? g.classNames.slice() : [],
      balance: r.bal,
      gstin: r.gstin,
      stateCode: r.state_code,
      registrationType: r.gst_registration_type,
      billWise: r.maintain_bill_wise === 1,
      isActive: r.is_active === 1,
    };
  });
}

// ───────────────────────────── Balances ─────────────────────────────

export function getLedgerBalance(db: Db, input: LedgerBalanceInput, today: string): LedgerBalance {
  const to = input.to ?? today;
  assertRange(input.from, to);
  return ledgerBalance(db, input.ledgerId, { from: input.from, to, today });
}

/** Totals of ledger opening balances (opening stock is added by the reports module). */
export function openingBalanceSummary(db: Db): OpeningBalanceSummary {
  const r = db.get<{ dr: number; cr: number; n: number }>(
    `SELECT COALESCE(SUM(CASE WHEN opening_balance > 0 THEN opening_balance END), 0) AS dr,
            COALESCE(SUM(CASE WHEN opening_balance < 0 THEN -opening_balance END), 0) AS cr,
            COUNT(CASE WHEN opening_balance <> 0 THEN 1 END) AS n
       FROM ledgers`,
  );
  const dr = r?.dr ?? 0;
  const cr = r?.cr ?? 0;
  return { totalDebit: dr, totalCredit: cr, difference: dr - cr, ledgerCount: r?.n ?? 0 };
}

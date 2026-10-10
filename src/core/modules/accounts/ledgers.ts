/**
 * Ledger masters: list, picker, get, save (create/alter), delete, bulk create, balances and the
 * opening-balance summary. Rules live in ledgerRules.ts.
 *
 * For the vouchers team: only ledgers for which isLedgerUsable() is true may be used in NEW vouchers
 * (inactive ledgers are hidden from pickers). Use assertLedgerUsable() to get a user-facing error.
 */
import { randomUUID } from 'node:crypto';
import type { FieldIssue } from '../../../shared/api.ts';
import { formatDate } from '../../../shared/dates.ts';
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
import { aliasClashIssues, aliasListIssues, allAliases, extraAliasLike, extraAliasMap, extraAliases, normalizeAliases, writeExtraAliases } from '../../lib/masterAliases.ts';
import type { CompanyFeatures } from '../../../shared/settings.ts';
import { getConfig, getFeatures } from '../company/service.ts';
import { BOOKS_FILTER, classFromChain, closingBalances, groupChain, ledgerBalance, ledgerClassNames, loadGroupTree, type GroupTree } from './books.ts';
import { Issues, assertRange, joinWords, likePattern, plural, requirePermission, requireSavePermission } from './common.ts';
import {
  LEDGER_COLUMNS,
  defaultLedgerFields,
  fieldsFromRow,
  groupNameClash,
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

/** Additional aliases for the audit image (key present only when there are some, so older images are unchanged). */
function extraAliasSnapshot(db: Db, id: number): { otherAliases?: string[] } {
  const extras = extraAliases(db, 'ledger', id);
  return extras.length > 0 ? { otherAliases: extras } : {};
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
    ...extraAliasSnapshot(db, id),
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
    aliases: allAliases(row.alias, extraAliases(db, 'ledger', row.id)),
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
  return { tree, company: companyBasics(db), features: getFeatures(db), lockedUpTo: getConfig(db).lockedUpTo };
}

const INSERT_COLS = LEDGER_COLUMNS.map(([, col]) => col);
const INSERT_SQL = `INSERT INTO ledgers (guid, ${INSERT_COLS.join(', ')}, created_at, updated_at)
  VALUES (:guid, ${INSERT_COLS.map((c) => `:${c}`).join(', ')}, :ts, :ts)`;
const UPDATE_SQL = `UPDATE ledgers SET ${INSERT_COLS.map((c) => `${c} = :${c}`).join(', ')}, updated_at = :ts WHERE id = :id`;

/** GST details define a rate when GST applies and either a rate or a non-taxable taxability is set. */
export const definesRate = (f: Pick<LedgerFields, 'gstApplicable' | 'gstRate' | 'gstTaxability'>): boolean =>
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

interface HistoryDbRow {
  applicable_from: string;
  hsn_sac: string | null;
  taxability: Taxability;
  rate: number;
  cess_rate: number;
  cess_per_unit: number;
}

/** The GST fields of a ledger that gst_rate_history stores. */
const HISTORY_FIELDS = ['gstTaxability', 'gstRate', 'cessRate', 'hsnSac'] as const;

function historyRowOn(db: Db, id: number, date: string): HistoryDbRow | undefined {
  return db.get<HistoryDbRow>(
    `SELECT applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
      WHERE entity_type = 'ledger' AND entity_id = :id AND applicable_from <= :date ORDER BY applicable_from DESC LIMIT 1`,
    { id, date },
  );
}

function historyEdgeRow(db: Db, id: number, latest: boolean): HistoryDbRow | undefined {
  return db.get<HistoryDbRow>(
    `SELECT applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
      WHERE entity_type = 'ledger' AND entity_id = :id ORDER BY applicable_from ${latest ? 'DESC' : 'ASC'} LIMIT 1`,
    { id },
  );
}

const historyCount = (db: Db, id: number): number =>
  db.value<number>(`SELECT COUNT(*) FROM gst_rate_history WHERE entity_type = 'ledger' AND entity_id = :id`, { id }) ?? 0;

/**
 * Keep gst_rate_history in step with the ledger's GST details. The posting engine reads the history
 * first (latest row on or before the voucher date), so it must never disagree with the master:
 *  - GST not applicable, or no rate defined (rate from items): the history no longer applies and is removed.
 *  - with `applicableFrom`: the row effective from that date is the row in force on that date (or the
 *    earliest row) with the GST fields given in THIS save applied over it, so a back-dated change of one
 *    detail never copies today's other details into the past. Later rows are kept. Nothing is written
 *    when the result equals the details already in force on that date.
 *  - without it: the latest row is corrected to the master's values (the first row starts at the books
 *    beginning).
 * The ledger's own GST columns always mirror the LATEST history row.
 */
function writeGstHistory(
  db: Db,
  id: number,
  before: LedgerFields | null,
  after: LedgerFields,
  provided: ReadonlySet<keyof LedgerFields>,
  applicableFrom: string | undefined,
  booksFrom: string,
): void {
  if (!definesRate(after)) {
    db.run(`DELETE FROM gst_rate_history WHERE entity_type = 'ledger' AND entity_id = :id`, { id });
    return;
  }
  const own = {
    taxability: after.gstTaxability ?? 'taxable',
    rate: after.gstRate ?? 0,
    cess: after.cessRate ?? 0,
    hsn: after.hsnSac,
  };
  let from: string;
  let row: typeof own;
  if (applicableFrom === undefined) {
    if (!gstDetailsChanged(before, after) && historyCount(db, id) > 0) return;
    from = historyEdgeRow(db, id, true)?.applicable_from ?? booksFrom;
    row = own;
  } else {
    from = applicableFrom;
    const base = historyRowOn(db, id, from) ?? historyEdgeRow(db, id, false);
    // Without an earlier rate (first GST details, or a ledger that had none) everything comes from the master.
    const fresh = !base || !before || !definesRate(before);
    const given = (k: (typeof HISTORY_FIELDS)[number]): boolean => fresh || provided.has(k);
    row = {
      taxability: given('gstTaxability') || !base ? own.taxability : base.taxability,
      rate: given('gstRate') || !base ? own.rate : base.rate,
      cess: given('cessRate') || !base ? own.cess : base.cess_rate,
      hsn: given('hsnSac') || !base ? own.hsn : base.hsn_sac,
    };
    if (row.taxability !== 'taxable') {
      row.rate = 0;
      row.cess = 0;
    } else if (base && base.taxability !== 'taxable' && !given('gstRate')) {
      // Made taxable from this date without a rate: take the ledger's rate, not the 0% of the exempt row.
      row.rate = own.rate;
      row.cess = own.cess;
    }
    const inForce = historyRowOn(db, id, from);
    if (inForce && inForce.taxability === row.taxability && inForce.rate === row.rate && inForce.cess_rate === row.cess && inForce.hsn_sac === row.hsn) {
      return; // already in force on that date
    }
  }
  db.run(
    `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate)
     VALUES ('ledger', :id, :from, :hsn, :tax, :rate, :cess)
     ON CONFLICT (entity_type, entity_id, applicable_from)
     DO UPDATE SET hsn_sac = excluded.hsn_sac, taxability = excluded.taxability, rate = excluded.rate, cess_rate = excluded.cess_rate`,
    { id, from, hsn: row.hsn, tax: row.taxability, rate: row.rate, cess: row.cess },
  );
  const latest = historyEdgeRow(db, id, true);
  if (latest && (latest.taxability !== own.taxability || latest.rate !== own.rate || latest.cess_rate !== own.cess || latest.hsn_sac !== own.hsn)) {
    db.run(
      `UPDATE ledgers SET hsn_sac = :hsn, gst_taxability = :tax, gst_rate = :rate, cess_rate = :cess WHERE id = :id`,
      { id, hsn: latest.hsn_sac, tax: latest.taxability, rate: latest.rate, cess: latest.cess_rate },
    );
  }
}

interface SaveContext {
  tree: GroupTree;
  company: { stateCode: string | null; booksFrom: string };
  /** Company features (F11) that drive defaults and rules. */
  features: Pick<CompanyFeatures, 'billWise' | 'gst' | 'inventory' | 'integrateInventory'>;
  /** Period lock (F12), read once per save / bulk create. */
  lockedUpTo: string | null;
}

/**
 * Tally defaults for a NEW ledger (only for fields the caller did not set):
 *  - customers/suppliers keep bills when bill-wise details are enabled (F11);
 *  - sales/purchase ledgers: "Inventory values are affected" when inventory is on, and GST applicable
 *    (taxable, rate from the items) when the company has GST — like the predefined Sales/Purchase ledgers.
 */
function applyCreateDefaults(fields: LedgerFields, provided: ReadonlySet<keyof LedgerFields>, sc: SaveContext): void {
  const cls = sc.tree.byId.get(fields.groupId)?.cls;
  if (!cls) return;
  if (!provided.has('billWise') && sc.features.billWise && cls.isParty) fields.billWise = true;
  if (cls.isSales || cls.isPurchase) {
    if (!provided.has('inventoryValuesAffected') && sc.features.inventory) fields.inventoryValuesAffected = true;
    if (!provided.has('gstApplicable') && sc.features.gst) fields.gstApplicable = true;
  }
}

/**
 * Opening balances and opening bills are as at the books beginning: when the books are locked up to a
 * date on or after it (period lock), they belong to the locked period and cannot be entered or changed.
 */
function assertOpeningUnlocked(
  sc: SaveContext,
  f: LedgerFields,
  existing: LedgerFields | null,
  newBills: OpeningBillInput[] | null,
  storedBills: OpeningBill[],
): void {
  const { lockedUpTo } = sc;
  const { booksFrom } = sc.company;
  if (!lockedUpTo || lockedUpTo < booksFrom) return;
  const key = (b: { billName: string; billDate: string; dueDate?: string | null; amount: number }): string =>
    JSON.stringify([b.billName.toLowerCase(), b.billDate, b.dueDate ?? null, b.amount]);
  const billsChanged =
    newBills !== null && JSON.stringify(newBills.map(key).sort()) !== JSON.stringify(storedBills.map(key).sort());
  const balanceChanged = existing ? existing.openingBalance !== f.openingBalance : f.openingBalance !== 0;
  if (!balanceChanged && !billsChanged) return;
  throw new AppError(
    'LOCKED',
    `Books are locked up to ${formatDate(lockedUpTo)}, which includes the opening balances (as at ${formatDate(booksFrom)}). ` +
      `Unlock the period to change the opening balance or opening bills of '${f.name}'.`,
    { lockedUpTo },
  );
}

/** Validate and write one ledger (no permission check, caller provides the transaction). Returns its id. */
function saveLedgerTx(ctx: CompanyCtx, input: LedgerSaveInput, sc: SaveContext): number {
  const { db } = ctx;
  const row = input.id !== undefined ? loadLedgerRow(db, input.id) : undefined;
  if (input.id !== undefined && !row) throw notFound('Ledger', input.id);
  const existing = row ? fieldsFromRow(row) : null;
  const { fields, provided } = mergeLedgerInput(input, existing ?? defaultLedgerFields());
  if (!row) applyCreateDefaults(fields, provided, sc);
  // Aliases (dataplus): `aliases` is the complete list (first → the alias column, the rest → ledger_aliases).
  const aliasesGiven = Array.isArray(input.aliases);
  let extras: string[] = row ? extraAliases(db, 'ledger', row.id) : [];
  if (aliasesGiven) {
    const list = normalizeAliases(fields.name ?? '', input.aliases as string[]);
    fields.alias = list[0] ?? null;
    extras = list.slice(1);
    provided.add('alias');
  }

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
      integratedInventory: sc.features.inventory && sc.features.integrateInventory,
    },
    issues,
  );
  if (input.applicableFrom !== undefined && existing && definesRate(existing) && !definesRate(fields) && !issues.has('gstRate')) {
    issues.add(
      'applicableFrom',
      'Turning GST off or clearing the GST rate removes the rate history of this ledger, so it cannot take an "applicable from" date. ' +
        'To stop charging GST from a date, set the taxability (Exempt, Nil-rated or Non-GST) from that date instead.',
    );
  }
  {
    // Re-normalise against the (possibly new) name: the alias column stays the first alias.
    const full = normalizeAliases(fields.name, [fields.alias, ...extras]);
    fields.alias = full[0] ?? null;
    extras = full.slice(1);
  }
  if (!issues.has('name') && !issues.has('alias')) {
    const full = allAliases(fields.alias, extras);
    for (const i of [...aliasListIssues(full), ...aliasClashIssues(db, 'ledger', fields.name, full, row ? row.id : null)]) {
      if (!issues.has(i.path)) issues.add(i.path, i.message);
    }
    // Ledgers and groups share one name space (as in Tally): an additional alias may not be a group's name or alias.
    extras.forEach((a, k) => {
      const g = groupNameClash(db, a);
      if (g) issues.add(`aliases[${k + 1}]`, `'${a}' is already ${g.name.toLowerCase() === a.toLowerCase() ? 'the name' : 'an alias'} of the group '${g.name}'. Choose a different alias.`);
    });
  }
  issues.throwIfAny();
  assertOpeningUnlocked(sc, fields, existing, billsProvided ? bills : null, row ? loadBills(db, row.id) : []);

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
    // (forex group) Keep the foreign amount of a re-entered opening bill (same name, same Dr/Cr side),
    // entered under Multi-currency › Opening in currency; the rewrite would otherwise drop it.
    const forexByName = new Map<string, number>();
    if (row) {
      for (const r of db.all<{ bill_name: string; forex_amount: number }>(
        'SELECT bill_name, forex_amount FROM opening_bills WHERE ledger_id = :id AND forex_amount IS NOT NULL AND forex_amount <> 0',
        { id },
      )) {
        forexByName.set(r.bill_name, r.forex_amount);
      }
    }
    db.run('DELETE FROM opening_bills WHERE ledger_id = :id', { id });
    for (const b of bills) {
      const fx = forexByName.get(b.billName);
      db.run(
        'INSERT INTO opening_bills (ledger_id, bill_name, bill_date, due_date, amount, forex_amount) VALUES (:id, :name, :date, :due, :amount, :fx)',
        { id, name: b.billName, date: b.billDate, due: b.dueDate ?? null, amount: b.amount, fx: fx !== undefined && Math.sign(fx) === Math.sign(b.amount) ? fx : null },
      );
    }
  }
  // (forex group) An opening balance in the currency must stay on the side of the rupee opening balance.
  if (row) {
    db.run(
      `UPDATE ledgers SET opening_forex_amount = NULL
        WHERE id = :id AND opening_forex_amount IS NOT NULL
          AND (opening_balance = 0 OR (opening_balance > 0) <> (opening_forex_amount > 0))`,
      { id },
    );
  }
  writeGstHistory(db, id, existing, fields, provided, input.applicableFrom, sc.company.booksFrom);
  writeExtraAliases(db, 'ledger', id, extras);

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

/** References to ledgers(id) that ledgerUsage() counts by name; any other foreign key is found from the schema. */
const KNOWN_LEDGER_REFS: ReadonlySet<string> = new Set([
  'ledger_entries.ledger_id',
  'bill_allocations.ledger_id',
  'cost_allocations.ledger_id',
  'inventory_entries.ledger_id',
  'gst_lines.ledger_id',
  'vouchers.party_ledger_id',
  'bank_statement_lines.ledger_id',
  'opening_bills.ledger_id',
  'ledger_aliases.ledger_id', // dataplus: additional aliases go with the ledger (CASCADE)
]);
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Rows in tables added by other modules that still refer to the ledger through a foreign key, found
 * from the schema (so a new table is covered without changing this module). Table/column names come
 * from sqlite_master, never from user input.
 */
export function otherLedgerReferences(db: Db, id: number): Array<{ table: string; column: string; count: number }> {
  const out: Array<{ table: string; column: string; count: number }> = [];
  const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  for (const { name: table } of tables) {
    if (!SQL_IDENT.test(table)) continue;
    for (const fk of db.all<{ table: string; from: string }>('SELECT "table", "from" FROM pragma_foreign_key_list(:t)', { t: table })) {
      if (fk.table !== 'ledgers' || !SQL_IDENT.test(fk.from) || KNOWN_LEDGER_REFS.has(`${table}.${fk.from}`)) continue;
      const count = db.value<number>(`SELECT COUNT(*) FROM "${table}" WHERE "${fk.from}" = :id`, { id }) ?? 0;
      if (count > 0) out.push({ table, column: fk.from, count });
    }
  }
  return out;
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
    const others = otherLedgerReferences(db, id);
    for (const o of others) reasons.push(`${plural(o.count, 'record')} in ${o.table.replace(/_/g, ' ')} still refer${o.count === 1 ? 's' : ''} to it`);
    if (reasons.length > 0) {
      const hint =
        u.vouchers > 0 || others.length > 0
          ? ' Mark it inactive instead (Alter ledger → Active: No) so that it no longer appears in new vouchers.'
          : ' Remove these first, then delete the ledger.';
      throw rule(`Ledger '${row.name}' cannot be deleted: ${joinWords(reasons)}.${hint}`, { ...u, otherReferences: others });
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
    where.push(`(l.name LIKE :q ESCAPE '\\' OR l.alias LIKE :q ESCAPE '\\' OR l.gstin LIKE :q ESCAPE '\\' OR ${extraAliasLike('ledger', 'l.id', 'q')})`);
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
  const otherAliases = extraAliasMap(db, 'ledger', rows.map((r) => r.id));

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
      const more = otherAliases.get(r.id);
      if (more) out.otherAliases = more;
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
  const otherAliases = extraAliasMap(db, 'ledger');
  return rows.map((r) => {
    const g = tree.byId.get(r.group_id);
    const more = otherAliases.get(r.id);
    return {
      id: r.id,
      name: r.name,
      alias: r.alias,
      ...(more ? { otherAliases: more } : {}),
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

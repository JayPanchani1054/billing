/**
 * Voucher types: the 18 predefined types plus user-created types under them ("Cash Sales",
 * "Sales - Export", "Tax Invoice (B2B)" …). A custom type inherits its base type from its parent.
 *
 * Rules:
 *  - Predefined types: numbering, flags and configuration may change; name, parent and base type may not,
 *    and they cannot be deactivated or deleted.
 *  - Numbering: method automatic | automatic_override | manual | none; prefix/suffix ≤ 16 characters;
 *    start ≥ 1; zero padding 0–9; restart yearly | monthly | never. For GST documents (sales, credit
 *    note, debit note) of a GST-registered company the full number must fit in 16 characters and use
 *    only A–Z a–z 0–9 / - (CGST Rule 46(b)); for other types these are warnings only.
 *  - Changing numbering never renumbers existing vouchers (voucher numbers are stored on the voucher).
 *  - Config JSON is validated: default sales/purchase ledger must match the base type, default party
 *    must be a party or cash/bank ledger, bank ledger must be a bank, invoice mode only for invoices.
 *    Unknown keys written by other modules are preserved.
 *  - Delete: custom types only, without vouchers or child types.
 */
import { randomUUID } from 'node:crypto';
import type { FieldIssue } from '../../../shared/api.ts';
import { PREDEFINED_VOUCHER_TYPES, type VoucherBaseType } from '../../../shared/constants.ts';
import {
  checkNumberingScheme,
  GST_DOC_NUMBER_MAX_LENGTH,
  GST_NUMBERED_BASE_TYPES,
  numberingRowProblems,
  type NumberingTextRow,
} from '../../../shared/numbering.ts';
import type {
  DeleteResult,
  ListResult,
  NumberingMethod,
  NumberingRestart,
  VoucherNumbering,
  VoucherTypeConfig,
  VoucherTypeDetail,
  VoucherTypeRow,
  VoucherTypeSaveInput,
} from '../../../shared/types/accounts.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule } from '../../lib/errors.ts';
import { getFeatures } from '../company/service.ts';
import { loadVoucherType, parseVoucherSeq, periodKey, periodRange } from '../vouchers/numbering.ts';
import { classFromChain, groupChain } from './books.ts';
import { Issues, cleanText, plural, requirePermission, requireSavePermission } from './common.ts';

interface VtDbRow {
  id: number;
  guid: string;
  name: string;
  alias: string | null;
  abbreviation: string | null;
  base_type: VoucherBaseType;
  parent_id: number | null;
  parent_name: string | null;
  is_predefined: number;
  is_active: number;
  numbering_method: NumberingMethod;
  numbering_prefix: string | null;
  numbering_suffix: string | null;
  numbering_start: number;
  numbering_width: number;
  numbering_restart: NumberingRestart;
  prevent_duplicates: number;
  use_effective_date: number;
  allow_zero_value: number;
  optional_by_default: number;
  narration_per_entry: number;
  print_after_save: number;
  config: string;
  created_at: string;
  updated_at: string;
  voucher_count: number;
}

const VT_SELECT = `SELECT vt.*, p.name AS parent_name,
       (SELECT COUNT(*) FROM vouchers v WHERE v.voucher_type_id = vt.id) AS voucher_count
  FROM voucher_types vt LEFT JOIN voucher_types p ON p.id = vt.parent_id`;

/**
 * GST documents issued by the company: invoice numbers ≤ 16 characters, A–Z a–z 0–9 / - only. One source
 * (src/shared/numbering.ts), re-exported under the names this module always used.
 */
export const GST_DOCUMENT_BASE_TYPES: readonly VoucherBaseType[] = GST_NUMBERED_BASE_TYPES;
export { GST_DOC_NUMBER_MAX_LENGTH };
const SALES_SIDE: readonly VoucherBaseType[] = ['sales', 'credit_note', 'sales_order', 'delivery_note', 'rejection_in'];
const PURCHASE_SIDE: readonly VoucherBaseType[] = ['purchase', 'debit_note', 'purchase_order', 'receipt_note', 'rejection_out'];
const INVOICE_BASES: readonly VoucherBaseType[] = ['sales', 'purchase', 'credit_note', 'debit_note'];

const BASE_ORDER = new Map<string, number>(PREDEFINED_VOUCHER_TYPES.map((p, i) => [p.baseType, i]));

export function parseVoucherTypeConfig(json: string | null | undefined): VoucherTypeConfig & Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json ?? '{}');
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as VoucherTypeConfig & Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Dated prefix / suffix rows of every voucher type (dataplus) — attached by `toRow`. */
type RowsByType = Map<number, { prefix: NumberingTextRow[]; suffix: NumberingTextRow[] }>;

function numberingRowsByType(db: Db, id?: number): RowsByType {
  const out: RowsByType = new Map();
  const rows = db.all<{ vt: number; kind: 'prefix' | 'suffix'; applicable_from: string; text: string | null }>(
    `SELECT voucher_type_id AS vt, kind, applicable_from, text FROM voucher_type_numbering_rows
      ${id === undefined ? '' : 'WHERE voucher_type_id = :id'} ORDER BY voucher_type_id, applicable_from`,
    id === undefined ? {} : { id },
  );
  for (const r of rows) {
    let e = out.get(r.vt);
    if (!e) out.set(r.vt, (e = { prefix: [], suffix: [] }));
    (r.kind === 'prefix' ? e.prefix : e.suffix).push({ applicableFrom: r.applicable_from, text: r.text });
  }
  return out;
}

const numberingOf = (r: VtDbRow, rows?: RowsByType): VoucherNumbering => ({
  method: r.numbering_method,
  prefix: r.numbering_prefix,
  suffix: r.numbering_suffix,
  start: r.numbering_start,
  width: r.numbering_width,
  restart: r.numbering_restart,
  // Keys only when there are dated rows (existing DTOs and edit-log images stay as they were).
  ...(rows?.get(r.id)?.prefix.length ? { prefixRows: rows.get(r.id)?.prefix } : {}),
  ...(rows?.get(r.id)?.suffix.length ? { suffixRows: rows.get(r.id)?.suffix } : {}),
});

function hotkeyOf(r: VtDbRow): string | null {
  if (r.is_predefined !== 1) return null;
  return PREDEFINED_VOUCHER_TYPES.find((p) => p.baseType === r.base_type)?.hotkey ?? null;
}

function toRow(r: VtDbRow, rows?: RowsByType): VoucherTypeRow {
  return {
    id: r.id,
    guid: r.guid,
    name: r.name,
    alias: r.alias,
    abbreviation: r.abbreviation,
    baseType: r.base_type,
    parentId: r.parent_id,
    parentName: r.parent_name,
    isPredefined: r.is_predefined === 1,
    isActive: r.is_active === 1,
    hotkey: hotkeyOf(r),
    numbering: numberingOf(r, rows),
    voucherCount: r.voucher_count,
  };
}

function toDetail(r: VtDbRow, gstEnabled: boolean, db?: Db): VoucherTypeDetail {
  const rows = db ? numberingRowsByType(db, r.id) : undefined;
  const check = checkNumbering(r.base_type, numberingOf(r, rows), gstEnabled);
  return {
    ...toRow(r, rows),
    preventDuplicates: r.prevent_duplicates === 1,
    useEffectiveDate: r.use_effective_date === 1,
    allowZeroValue: r.allow_zero_value === 1,
    optionalByDefault: r.optional_by_default === 1,
    narrationPerEntry: r.narration_per_entry === 1,
    printAfterSave: r.print_after_save === 1,
    config: parseVoucherTypeConfig(r.config),
    numberingWarnings: [...check.errors.map((e) => e.message), ...check.warnings],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const sortRows = (a: VtDbRow, b: VtDbRow): number =>
  (BASE_ORDER.get(a.base_type) ?? 99) - (BASE_ORDER.get(b.base_type) ?? 99) ||
  b.is_predefined - a.is_predefined ||
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

export function listVoucherTypes(db: Db, input: { search?: string; activeOnly?: boolean } = {}): ListResult<VoucherTypeRow> {
  const term = input.search?.trim().toLowerCase();
  const numberingRows = numberingRowsByType(db);
  const rows = db
    .all<VtDbRow>(VT_SELECT)
    .sort(sortRows)
    .filter(
      (r) =>
        (!input.activeOnly || r.is_active === 1) &&
        (!term || r.name.toLowerCase().includes(term) || (r.alias ?? '').toLowerCase().includes(term) || (r.abbreviation ?? '').toLowerCase().includes(term)),
    )
    .map((r) => toRow(r, numberingRows));
  return { rows, total: rows.length };
}

function loadVt(db: Db, id: number): VtDbRow | undefined {
  return db.get<VtDbRow>(`${VT_SELECT} WHERE vt.id = :id`, { id });
}

export function getVoucherType(db: Db, id: number): VoucherTypeDetail {
  const r = loadVt(db, id);
  if (!r) throw notFound('Voucher type', id);
  return toDetail(r, getFeatures(db).gst, db);
}

// ───────────────────────────── Numbering rules ─────────────────────────────

/**
 * Check a numbering scheme. For GST documents of a GST-registered company, length and character
 * problems are errors (paths under 'numbering.'); otherwise they are warnings.
 */
export function checkNumbering(baseType: VoucherBaseType, n: VoucherNumbering, gstEnabled: boolean): { errors: FieldIssue[]; warnings: string[] } {
  // Shared with the voucher-type form (src/shared/numbering.ts): tokens and dated rows included (dataplus).
  return checkNumberingScheme(baseType, n, gstEnabled);
}

// ───────────────────────────── Config rules ─────────────────────────────

function ledgerInfo(db: Db, id: number): { name: string; isActive: boolean; cls: ReturnType<typeof classFromChain> } | null {
  const l = db.get<{ name: string; group_id: number; is_active: number }>('SELECT name, group_id, is_active FROM ledgers WHERE id = :id', { id });
  if (!l) return null;
  return { name: l.name, isActive: l.is_active === 1, cls: classFromChain(groupChain(db, l.group_id)) };
}

function validateConfig(db: Db, baseType: VoucherBaseType, cfg: VoucherTypeConfig, issues: Issues): void {
  const checkLedger = (key: keyof VoucherTypeConfig, id: number | null | undefined, ok: (c: ReturnType<typeof classFromChain>) => boolean, need: string): void => {
    if (id === null || id === undefined) return;
    const info = ledgerInfo(db, id);
    const path = `config.${key}`;
    if (!info) issues.add(path, 'The selected ledger does not exist');
    else if (!info.isActive) issues.add(path, `Ledger '${info.name}' is inactive`);
    else if (!ok(info.cls)) issues.add(path, `Ledger '${info.name}' cannot be used here: ${need}`);
  };
  if (cfg.defaultLedgerId !== null && cfg.defaultLedgerId !== undefined) {
    if (SALES_SIDE.includes(baseType)) checkLedger('defaultLedgerId', cfg.defaultLedgerId, (c) => c.isSales, 'choose a ledger under Sales Accounts');
    else if (PURCHASE_SIDE.includes(baseType)) checkLedger('defaultLedgerId', cfg.defaultLedgerId, (c) => c.isPurchase, 'choose a ledger under Purchase Accounts');
    else issues.add('config.defaultLedgerId', 'A default sales or purchase ledger applies only to sales and purchase voucher types');
  }
  checkLedger(
    'defaultPartyLedgerId',
    cfg.defaultPartyLedgerId,
    (c) => c.isParty || c.isCashOrBank,
    'choose a customer/supplier (Sundry Debtors or Creditors) or a cash or bank ledger',
  );
  checkLedger('bankLedgerId', cfg.bankLedgerId, (c) => c.isBank, 'choose a ledger under Bank Accounts or Bank OD A/c');
  if (cfg.invoiceMode !== null && cfg.invoiceMode !== undefined && !INVOICE_BASES.includes(baseType)) {
    issues.add('config.invoiceMode', 'Invoice mode applies only to sales, purchase, credit note and debit note voucher types');
  }
  if (cfg.stockJournalClass !== null && cfg.stockJournalClass !== undefined && baseType !== 'stock_journal') {
    issues.add('config.stockJournalClass', 'Manufacturing Journal / Material In / Material Out applies only to stock journal voucher types');
  }
  if (cfg.posInvoice === true && baseType !== 'sales') {
    issues.add('config.posInvoice', 'POS invoice applies only to sales voucher types');
  }
  if (cfg.defaultGodownId !== null && cfg.defaultGodownId !== undefined) {
    if (db.value('SELECT 1 FROM godowns WHERE id = :id', { id: cfg.defaultGodownId }) === undefined) {
      issues.add('config.defaultGodownId', 'The selected godown does not exist');
    }
  }
}

/** Key-level merge: undefined keeps, null removes. Text values are trimmed (blank → removed). */
function mergeConfig(base: Record<string, unknown>, patch: VoucherTypeConfig | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (!patch) return out;
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    const v = typeof val === 'string' ? cleanText(val) : val;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

// ───────────────────────────── Save / delete ─────────────────────────────

function descendantsOf(db: Db, id: number): number[] {
  return db
    .all<{ id: number }>(
      `WITH RECURSIVE sub(id) AS (SELECT id FROM voucher_types WHERE parent_id = :id
                                  UNION SELECT v.id FROM voucher_types v JOIN sub s ON v.parent_id = s.id)
       SELECT id FROM sub`,
      { id },
    )
    .map((r) => r.id);
}

function checkVtNames(db: Db, name: string | null, alias: string | null, excludeId: number, issues: Issues): void {
  const clash = (v: string): string | undefined =>
    db.value<string>('SELECT name FROM voucher_types WHERE (name = :v OR alias = :v COLLATE NOCASE) AND id <> :ex LIMIT 1', { v, ex: excludeId });
  if (name) {
    const c = clash(name);
    if (c !== undefined) issues.add('name', `A voucher type named '${c}' (or with that alias) already exists. Choose a different name.`);
  }
  if (alias) {
    const c = clash(alias);
    if (c !== undefined) issues.add('alias', `Alias '${alias}' is already used by voucher type '${c}'.`);
  }
}

function writeVoucherType(ctx: CompanyCtx, input: VoucherTypeSaveInput): number {
  const { db } = ctx;
  const row = input.id !== undefined ? loadVt(db, input.id) : undefined;
  if (input.id !== undefined && !row) throw notFound('Voucher type', input.id);
  const issues = new Issues();
  const gstEnabled = getFeatures(db).gst;

  // Parent & base type.
  let parent: VtDbRow | undefined;
  if (!row) {
    if (input.parentId !== undefined) {
      parent = loadVt(db, input.parentId);
      if (!parent) issues.add('parentId', 'The selected parent voucher type does not exist');
      else if (input.baseType !== undefined && input.baseType !== parent.base_type) {
        issues.add('baseType', `The base type follows the parent type '${parent.name}' (${parent.base_type})`);
      }
    } else if (input.baseType !== undefined) {
      parent = db.get<VtDbRow>(`${VT_SELECT} WHERE vt.base_type = :b AND vt.is_predefined = 1 ORDER BY vt.id LIMIT 1`, { b: input.baseType });
      if (!parent) issues.add('baseType', 'There is no predefined voucher type of this kind');
    } else {
      issues.add('parentId', 'Choose the voucher type this one is based on (e.g. Sales)');
    }
  } else if (row.is_predefined === 1) {
    const what = `'${row.name}' is a predefined voucher type`;
    if (input.name !== undefined && cleanText(input.name) !== row.name) issues.add('name', `${what} and cannot be renamed. You can give it an alias.`);
    if (input.parentId !== undefined && input.parentId !== row.parent_id) issues.add('parentId', `${what}; its type of voucher cannot be changed`);
    if (input.baseType !== undefined && input.baseType !== row.base_type) issues.add('baseType', `${what}; its base type cannot be changed`);
    if (input.isActive === false) issues.add('isActive', `${what} and cannot be deactivated. Create your own voucher types and deactivate those instead.`);
  } else if (input.parentId !== undefined && input.parentId !== row.parent_id) {
    parent = loadVt(db, input.parentId);
    if (!parent) issues.add('parentId', 'The selected parent voucher type does not exist');
    else if (parent.id === row.id || descendantsOf(db, row.id).includes(parent.id)) {
      issues.add('parentId', 'A voucher type cannot be based on itself or on one of the types based on it');
    }
  } else if (row.parent_id !== null) {
    parent = loadVt(db, row.parent_id);
  }
  if (row && row.is_predefined !== 1 && input.baseType !== undefined && parent && input.baseType !== parent.base_type) {
    issues.add('baseType', `The base type follows the parent type '${parent.name}' (${parent.base_type})`);
  }
  const baseType: VoucherBaseType = row?.is_predefined === 1 ? row.base_type : (parent?.base_type ?? row?.base_type ?? 'journal');

  if (row && row.is_predefined !== 1 && baseType !== row.base_type) {
    const ids = [row.id, ...descendantsOf(db, row.id)];
    const used = db.value<number>('SELECT COUNT(*) FROM vouchers WHERE voucher_type_id IN (SELECT value FROM json_each(:ids))', { ids: JSON.stringify(ids) }) ?? 0;
    if (used > 0) {
      issues.add('parentId', `'${row.name}' cannot become a different kind of voucher: ${plural(used, 'voucher')} already use it (or a type based on it)`);
    }
  }

  // Name, alias, abbreviation.
  const name = input.name === undefined && row ? row.name : cleanText(input.name);
  let alias = input.alias === undefined ? (row?.alias ?? null) : cleanText(input.alias);
  if (!name) issues.add('name', 'Voucher type name is required');
  if (alias && name && alias.toLowerCase() === name.toLowerCase()) alias = null;
  checkVtNames(db, name, alias, row?.id ?? 0, issues);
  const abbreviation =
    input.abbreviation === undefined ? (row?.abbreviation ?? (name ? name.slice(0, 10).trim() : null)) : cleanText(input.abbreviation);

  // Numbering.
  const baseNumbering: VoucherNumbering = row
    ? numberingOf(row)
    : parent
      ? { ...numberingOf(parent), prefix: null, suffix: null, start: 1 }
      : { method: 'automatic', prefix: null, suffix: null, start: 1, width: 0, restart: 'yearly' };
  const n: VoucherNumbering = { ...baseNumbering };
  if (input.numbering) {
    const p = input.numbering;
    if (p.method !== undefined) n.method = p.method;
    if (p.prefix !== undefined) n.prefix = p.prefix === null ? null : p.prefix.length === 0 ? null : p.prefix;
    if (p.suffix !== undefined) n.suffix = p.suffix === null ? null : p.suffix.length === 0 ? null : p.suffix;
    if (p.start !== undefined) n.start = p.start;
    if (p.width !== undefined) n.width = p.width;
    if (p.restart !== undefined) n.restart = p.restart;
  }
  // Dated prefix / suffix rows (dataplus): given → replace that kind; else keep (create: none).
  const storedRows = row ? numberingRowsByType(db, row.id).get(row.id) : undefined;
  n.prefixRows = input.numbering?.prefixRows
    ? input.numbering.prefixRows.map((r) => ({ applicableFrom: r.applicableFrom, text: r.text === null || r.text === '' ? null : r.text })).sort((a, b) => a.applicableFrom.localeCompare(b.applicableFrom))
    : (storedRows?.prefix ?? []);
  n.suffixRows = input.numbering?.suffixRows
    ? input.numbering.suffixRows.map((r) => ({ applicableFrom: r.applicableFrom, text: r.text === null || r.text === '' ? null : r.text })).sort((a, b) => a.applicableFrom.localeCompare(b.applicableFrom))
    : (storedRows?.suffix ?? []);
  {
    const booksFrom = db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? undefined;
    const typed = (kind: 'prefix' | 'suffix'): NumberingTextRow[] => (kind === 'prefix' ? input.numbering?.prefixRows : input.numbering?.suffixRows) ?? [];
    for (const kind of ['prefix', 'suffix'] as const) {
      if (!(kind === 'prefix' ? input.numbering?.prefixRows : input.numbering?.suffixRows)) continue;
      for (const i of numberingRowProblems(kind, typed(kind), booksFrom)) if (!issues.has(i.path)) issues.add(i.path, i.message);
    }
  }
  if (!Number.isSafeInteger(n.start) || n.start < 1) issues.add('numbering.start', 'Starting number must be 1 or more');
  if (!Number.isSafeInteger(n.width) || n.width < 0 || n.width > 9) issues.add('numbering.width', 'Zero padding must be between 0 and 9 digits');
  if ((n.prefix ?? '').length > GST_DOC_NUMBER_MAX_LENGTH) issues.add('numbering.prefix', 'Prefix can have at most 16 characters');
  if ((n.suffix ?? '').length > GST_DOC_NUMBER_MAX_LENGTH) issues.add('numbering.suffix', 'Suffix can have at most 16 characters');
  for (const e of checkNumbering(baseType, n, gstEnabled).errors) if (!issues.has(e.path)) issues.add(e.path, e.message);

  // Config.
  const writeNumberingRows = (id: number): void => {
    for (const [kind, list, given] of [
      ['prefix', n.prefixRows ?? [], input.numbering?.prefixRows !== undefined],
      ['suffix', n.suffixRows ?? [], input.numbering?.suffixRows !== undefined],
    ] as const) {
      if (!given) continue;
      db.run('DELETE FROM voucher_type_numbering_rows WHERE voucher_type_id = :id AND kind = :kind', { id, kind });
      for (const r of list) {
        db.run('INSERT INTO voucher_type_numbering_rows (voucher_type_id, kind, applicable_from, text) VALUES (:id, :kind, :from, :text)', {
          id,
          kind,
          from: r.applicableFrom,
          text: r.text,
        });
      }
    }
  };
  const baseConfig = row ? parseVoucherTypeConfig(row.config) : parent ? parseVoucherTypeConfig(parent.config) : {};
  const baseChanged = row !== undefined && baseType !== row.base_type;
  // A sales ledger default makes no sense once the type becomes a purchase type (and vice versa).
  if (baseChanged && input.config?.defaultLedgerId === undefined) delete baseConfig.defaultLedgerId;
  const config = mergeConfig(baseConfig, input.config);
  // mfg module: the class decides how saved journals are read back; it cannot change under them.
  if (row && (config.stockJournalClass ?? null) !== (baseConfig.stockJournalClass ?? null)) {
    const used = db.value<number>('SELECT COUNT(*) FROM vouchers WHERE voucher_type_id = :id', { id: row.id }) ?? 0;
    if (used > 0) issues.add('config.stockJournalClass', `${plural(used, 'voucher')} of this type exist; create a new voucher type for the other use.`);
  }
  // pos module: POS bills carry tenders entered on the counter; the class cannot change under them.
  if (row && (config.posInvoice === true) !== (baseConfig.posInvoice === true)) {
    const used = db.value<number>('SELECT COUNT(*) FROM vouchers WHERE voucher_type_id = :id', { id: row.id }) ?? 0;
    if (used > 0) issues.add('config.posInvoice', `${plural(used, 'voucher')} of this type exist; create a new voucher type for the other use.`);
  }
  // On alter only what changed is re-checked (a default ledger deactivated later must not block
  // unrelated edits such as numbering); on create, and when the base type changes, everything is.
  const toCheck: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(config)) {
    if (!row || baseChanged || JSON.stringify(val) !== JSON.stringify(baseConfig[k])) toCheck[k] = val;
  }
  validateConfig(db, baseType, toCheck as VoucherTypeConfig, issues);
  issues.throwIfAny();

  // Flags (create: inherit from parent).
  const flag = (k: keyof VtDbRow & string, v: boolean | undefined): boolean => v ?? (row ? row[k] === 1 : parent ? parent[k] === 1 : false);
  const params = {
    name,
    alias,
    abbreviation,
    baseType,
    parentId: row?.is_predefined === 1 ? row.parent_id : (parent?.id ?? null),
    isActive: input.isActive ?? (row ? row.is_active === 1 : true),
    method: n.method,
    prefix: n.prefix,
    suffix: n.suffix,
    start: n.start,
    width: n.width,
    restart: n.restart,
    preventDuplicates: flag('prevent_duplicates', input.preventDuplicates),
    useEffectiveDate: flag('use_effective_date', input.useEffectiveDate),
    allowZeroValue: flag('allow_zero_value', input.allowZeroValue),
    optionalByDefault: flag('optional_by_default', input.optionalByDefault),
    narrationPerEntry: flag('narration_per_entry', input.narrationPerEntry),
    printAfterSave: flag('print_after_save', input.printAfterSave),
    config: JSON.stringify(config),
    ts: ctx.clock.now().toISOString(),
  };

  const before = row ? toDetail(row, gstEnabled, db) : undefined;
  let id: number;
  let guid: string;
  if (!row) {
    guid = randomUUID();
    id = db.run(
      `INSERT INTO voucher_types (guid, name, alias, abbreviation, base_type, parent_id, is_predefined, is_active,
                                  numbering_method, numbering_prefix, numbering_suffix, numbering_start, numbering_width, numbering_restart,
                                  prevent_duplicates, use_effective_date, allow_zero_value, optional_by_default, narration_per_entry,
                                  print_after_save, config, created_at, updated_at)
       VALUES (:guid, :name, :alias, :abbreviation, :baseType, :parentId, 0, :isActive,
               :method, :prefix, :suffix, :start, :width, :restart,
               :preventDuplicates, :useEffectiveDate, :allowZeroValue, :optionalByDefault, :narrationPerEntry,
               :printAfterSave, :config, :ts, :ts)`,
      { ...params, guid },
    ).lastInsertRowid;
  } else {
    id = row.id;
    guid = row.guid;
    db.run(
      `UPDATE voucher_types SET name = :name, alias = :alias, abbreviation = :abbreviation, base_type = :baseType, parent_id = :parentId,
              is_active = :isActive, numbering_method = :method, numbering_prefix = :prefix, numbering_suffix = :suffix,
              numbering_start = :start, numbering_width = :width, numbering_restart = :restart,
              prevent_duplicates = :preventDuplicates, use_effective_date = :useEffectiveDate, allow_zero_value = :allowZeroValue,
              optional_by_default = :optionalByDefault, narration_per_entry = :narrationPerEntry, print_after_save = :printAfterSave,
              config = :config, updated_at = :ts
        WHERE id = :id`,
      { ...params, id },
    );
    if (baseType !== row.base_type) {
      // Types based on this one follow its base type; each gets its own audit row.
      const childIds = descendantsOf(db, id);
      const childBefore = childIds.map((cid) => loadVt(db, cid)).filter((r): r is VtDbRow => r !== undefined);
      db.run(
        `UPDATE voucher_types SET base_type = :baseType, updated_at = :ts WHERE id IN (SELECT value FROM json_each(:ids))`,
        { baseType, ts: params.ts, ids: JSON.stringify(childIds) },
      );
      for (const c of childBefore) {
        ctx.audit({
          action: 'alter',
          entityType: 'voucher_type',
          entityId: c.id,
          entityGuid: c.guid,
          entityLabel: `${c.name} (follows '${name ?? row.name}')`,
          before: toDetail(c, gstEnabled, db),
          after: getVoucherType(db, c.id),
        });
      }
    }
  }
  writeNumberingRows(id);
  if (row && n.restart !== row.numbering_restart) seedRestartCounter(ctx, id);
  ctx.audit({
    action: row ? 'alter' : 'create',
    entityType: 'voucher_type',
    entityId: id,
    entityGuid: guid,
    entityLabel: name ?? '',
    before,
    after: getVoucherType(db, id),
  });
  return id;
}

/**
 * 2.0: after the restart of a series changes (yearly ↔ monthly ↔ never), the counter of the new period
 * key for today starts at the highest sequence already used in that scope — read from each number in the
 * series' format of today (parseVoucherSeq), so numbers of another year's format ('INV/25-26/0900' when
 * today's prefix is 'INV/26-27/') do not make the series jump — one pass, once. The first allocation
 * then does not have to step over every number already used (a large series switched to "never" would
 * otherwise probe thousands of numbers, up to the 100 000 skip limit). Never lowers a counter that is
 * already higher.
 */
function seedRestartCounter(ctx: CompanyCtx, voucherTypeId: number): void {
  const { db } = ctx;
  const vt = loadVoucherType(db, voucherTypeId);
  const fyStartMonth = db.value<number>('SELECT fy_start_month FROM company WHERE id = 1') ?? 4;
  const today = ctx.clock.today();
  const { from, to } = periodRange(vt, today, fyStartMonth);
  let highest = 0;
  const rows = db.all<{ number: string }>(
    'SELECT number FROM vouchers WHERE voucher_type_id = :vt AND date BETWEEN :from AND :to AND number_seq IS NOT NULL',
    { vt: vt.id, from, to },
  );
  for (const r of rows) {
    const seq = parseVoucherSeq(vt, r.number, today, fyStartMonth);
    if (seq !== null && seq > highest) highest = seq;
  }
  if (highest <= 0) return;
  db.run(
    `INSERT INTO voucher_counters (voucher_type_id, period_key, last_number) VALUES (:vt, :key, :seq)
     ON CONFLICT(voucher_type_id, period_key) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`,
    { vt: vt.id, key: periodKey(vt, today, fyStartMonth), seq: highest },
  );
}

/** Create (no id) or alter (id) a voucher type. Requires masters.create / masters.alter. */
export function saveVoucherType(ctx: CompanyCtx, input: VoucherTypeSaveInput): VoucherTypeDetail {
  requireSavePermission(ctx, input.id);
  const id = ctx.db.transaction(() => writeVoucherType(ctx, input));
  return getVoucherType(ctx.db, id);
}

/** Delete a custom voucher type that has no vouchers and no types based on it. Requires masters.delete. */
export function deleteVoucherType(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete');
  const { db } = ctx;
  return db.transaction(() => {
    const row = loadVt(db, id);
    if (!row) throw notFound('Voucher type', id);
    if (row.is_predefined === 1) throw rule(`'${row.name}' is a predefined voucher type and cannot be deleted.`);
    if (row.voucher_count > 0) {
      throw rule(`Voucher type '${row.name}' cannot be deleted: ${plural(row.voucher_count, 'voucher')} ${row.voucher_count === 1 ? 'uses' : 'use'} it. Deactivate it instead.`, {
        vouchers: row.voucher_count,
      });
    }
    const children = db.all<{ name: string }>('SELECT name FROM voucher_types WHERE parent_id = :id ORDER BY name', { id });
    if (children.length > 0) {
      throw rule(`Voucher type '${row.name}' has types based on it (${children.map((c) => `'${c.name}'`).join(', ')}). Delete or change those first.`);
    }
    const before = toDetail(row, getFeatures(db).gst, db);
    db.run('DELETE FROM voucher_counters WHERE voucher_type_id = :id', { id });
    db.run('DELETE FROM voucher_types WHERE id = :id', { id });
    ctx.audit({ action: 'delete', entityType: 'voucher_type', entityId: id, entityGuid: row.guid, entityLabel: row.name, before });
    return { id, deleted: true };
  });
}

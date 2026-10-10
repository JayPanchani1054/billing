/**
 * Tally migration: preview and import of a Tally XML export (model: tallyParse.ts).
 *
 * Masters are created through the accounts / inventory services (same validation as the screens) in
 * dependency order: groups → units → godowns → stock groups → stock categories → cost categories →
 * cost centres → ledgers → stock items → voucher types. A master that fails validation is retried
 * without the offending optional fields (e.g. an invalid GSTIN) and reported as a warning; one that
 * still fails is reported as an error and skipped. Predefined groups map by name or Tally's reserved
 * name; Tally's 'Cash' and 'Profit & Loss A/c' map to this app's reserved ledgers (their opening
 * balances are taken over).
 *
 * Vouchers are written AS RECORDED in Tally (amounts, tax, round-off and numbers are never
 * recomputed): vouchers + ledger_entries + bill/cost allocations + inventory_entries + gst_lines,
 * following the conventions of src/core/modules/vouchers/README.md §3–§5. gst_lines are derived from
 * the GST duty-ledger postings (per head) allocated over the taxable lines by HSN/rate where the
 * masters give a rate, so every line's tax sums exactly to the posted tax. Unbalanced vouchers,
 * unknown ledgers / items / voucher types, dates before the books beginning or inside the locked
 * period are reported as issues and skipped. vouchers.meta = { v: 1, source: 'tally', tally: {…},
 * importBatchId, input } (input: a best-effort VoucherInput so the voucher can be altered later).
 *
 * The whole masters phase is one transaction; vouchers follow in chunks of CHUNK vouchers, each its
 * own transaction, yielding to the event loop between chunks (progress: 'data.tally.progress').
 * Every master created or altered is audited by its service (run.ctx is the caller's audited context),
 * every voucher written gets its own 'create' / 'alter' entry (before/after snapshot, source 'tally',
 * importBatchId), F11 changes need company.manage and are audited, and a final 'import' entry records
 * the counts (and the import_batches row id). Nothing bypasses the edit log.
 */
import { randomUUID } from 'node:crypto';
import {
  ACCOUNTING_BASE_TYPES,
  GST_BASE_TYPES,
  PREDEFINED_GROUPS,
  PREDEFINED_LEDGERS,
  PREDEFINED_VOUCHER_TYPES,
  type GroupNature,
  type VoucherBaseType,
} from '../../../shared/constants.ts';
import { addDays, formatDate } from '../../../shared/dates.ts';
import { classifySupply, findState, GST_RATES, isKnownStateCode, isStandardRate, normalizeStateCode } from '../../../shared/gst/index.ts';
import { allocate } from '../../../shared/money.ts';
import type { LedgerSaveInput, OpeningBillInput, VoucherTypeSaveInput } from '../../../shared/types/accounts.ts';
import type {
  TallyCounts,
  TallyImportInput,
  TallyImportResult,
  TallyIssue,
  TallyPreviewInput,
  TallyPreviewResult,
  TallyProgress,
} from '../../../shared/types/data.ts';
import type { RegistrationType, Taxability } from '../../../shared/types/gst.ts';
import type { CostingMethod, StockItemSaveInput, StockOpeningInput } from '../../../shared/types/inventory.ts';
import type { BillAllocationInput, InstrumentType, ItemLineInput, LedgerLineInput, VoucherInput, VoucherMode } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { aliasOwner, extraAliasMap, type AliasKind } from '../../lib/masterAliases.ts';
import type { Db } from '../../db/db.ts';
import { AppError, validation } from '../../lib/errors.ts';
import type { FieldIssue } from '../../../shared/api.ts';
import type { ledgerClass } from '../accounts/books.ts';
import { saveCostCategory, saveCostCentre } from '../accounts/costCentres.ts';
import { saveGroup } from '../accounts/groups.ts';
import { saveLedger } from '../accounts/ledgers.ts';
import { saveVoucherType } from '../accounts/voucherTypes.ts';
import { getConfig, getFeatures, saveFeatures } from '../company/service.ts';
import { mainGodownId, saveGodown, saveStockCategory, saveStockGroup } from '../inventory/masters.ts';
import { saveItem } from '../inventory/items.ts';
import { saveUnit } from '../inventory/units.ts';
import { loadVoucherType, parseVoucherSeq, periodKey, periodRange, type VoucherTypeInfo } from '../vouchers/numbering.ts';
import { loadVoucherRow, snapshotFromDb } from '../vouchers/service.ts';
import { dbTaxLookup, resolveItemTaxProfile, resolveLedgerTaxProfile, type TaxLookup } from '../vouchers/taxprofile.ts';
import { hasPermission, plural, requirePermission, yieldToEventLoop } from './common.ts';
import {
  parseTallyFile,
  voucherLabel,
  type TallyDutyHead,
  type TallyFile,
  type TEntry,
  type TGroup,
  type TLedger,
  type TNamed,
  type TStockItem,
  type TVoucher,
} from './tallyParse.ts';

/** Vouchers per transaction during import. */
export const CHUNK = 250;
const MAX_ISSUES = 2000;
const SAMPLE = 10;

// ───────────────────────────── Shared helpers ─────────────────────────────

const key = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

const TALLY_BASE: Record<string, VoucherBaseType> = Object.fromEntries(PREDEFINED_VOUCHER_TYPES.map((t) => [key(t.name), t.baseType]));
// Older Tally spellings.
TALLY_BASE['rejection in'] = 'rejection_in';
TALLY_BASE['rejection out'] = 'rejection_out';
TALLY_BASE['memo'] = 'memorandum';

const UNSUPPORTED_BASES: ReadonlySet<VoucherBaseType> = new Set(['physical_stock']);

/** Base type of a Tally voucher type name: built-in name, the file's VOUCHERTYPE chain, or this company's types. */
function baseTypeResolver(db: Db, file: TallyFile): (name: string) => VoucherBaseType | null {
  const parents = new Map(file.voucherTypes.map((t) => [key(t.name), t.parent]));
  const dbTypes = new Map(db.all<{ name: string; base_type: string }>('SELECT name, base_type FROM voucher_types').map((r) => [key(r.name), r.base_type as VoucherBaseType]));
  const cache = new Map<string, VoucherBaseType | null>();
  return (name: string): VoucherBaseType | null => {
    const k0 = key(name);
    if (cache.has(k0)) return cache.get(k0) ?? null;
    let k = k0;
    let out: VoucherBaseType | null = null;
    for (let depth = 0; depth < 32 && k; depth++) {
      if (dbTypes.has(k)) {
        out = dbTypes.get(k) ?? null;
        break;
      }
      if (TALLY_BASE[k]) {
        out = TALLY_BASE[k];
        break;
      }
      const p = parents.get(k);
      if (!p) break;
      k = key(p);
    }
    cache.set(k0, out);
    return out;
  };
}

/** Lower-cased name / alias → id of a master table (table names are constants). */
function nameIndex(db: Db, table: 'groups' | 'ledgers' | 'stock_items' | 'stock_groups' | 'stock_categories' | 'godowns' | 'cost_centres' | 'cost_categories'): Map<string, number> {
  const hasAlias = table !== 'cost_categories';
  const rows = db.all<{ id: number; name: string; alias: string | null }>(`SELECT id, name, ${hasAlias ? 'alias' : 'NULL AS alias'} FROM ${table} ORDER BY id`);
  const map = new Map<string, number>();
  for (const r of rows) if (r.alias && !map.has(key(r.alias))) map.set(key(r.alias), r.id);
  // Additional aliases of ledgers / stock items (dataplus).
  if (table === 'ledgers' || table === 'stock_items') {
    for (const [id, list] of extraAliasMap(db, table === 'ledgers' ? 'ledger' : 'stock_item')) for (const a of list) if (!map.has(key(a))) map.set(key(a), id);
  }
  for (const r of rows) map.set(key(r.name), r.id);
  return map;
}

/**
 * Every Tally alias (NAME.LIST) of a ledger / stock item that no other master of the kind uses yet;
 * the ones in use elsewhere are reported and left out (dataplus: all aliases are kept, not only the first).
 */
function importableAliases(run: Run, kind: AliasKind, aliases: readonly string[], selfId: number | null, object: string): string[] {
  const out: string[] = [];
  for (const a of aliases) {
    const owner = aliasOwner(run.db, kind, a, selfId);
    if (owner) {
      run.add({ severity: 'warning', code: 'field_dropped', message: `Alias "${a}" is already used by '${owner.name}'; imported without it.`, object });
      continue;
    }
    out.push(a);
  }
  return out;
}

function unitIndex(db: Db): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of db.all<{ id: number; symbol: string; formal_name: string | null }>('SELECT id, symbol, formal_name FROM units ORDER BY is_compound DESC, id DESC')) {
    if (r.formal_name) map.set(key(r.formal_name), r.id);
  }
  for (const r of db.all<{ id: number; symbol: string }>('SELECT id, symbol FROM units ORDER BY id')) map.set(key(r.symbol), r.id);
  return map;
}

const PREDEFINED_GROUP_BY_NAME = new Map(PREDEFINED_GROUPS.map((g) => [key(g.name), g.code]));
// Tally's alternative names of predefined groups.
const TALLY_GROUP_ALIASES: Record<string, string> = {
  'bank occ a/c': 'BANK_OD',
  'bank od a/c': 'BANK_OD',
  'direct income': 'DIRECT_INCOMES',
  'indirect income': 'INDIRECT_INCOMES',
  'income (direct)': 'DIRECT_INCOMES',
  'income (indirect)': 'INDIRECT_INCOMES',
  'expenses (direct)': 'DIRECT_EXPENSES',
  'expenses (indirect)': 'INDIRECT_EXPENSES',
  'current assets': 'CURRENT_ASSETS',
  'loans (liability)': 'LOANS_LIABILITY',
};
const RESERVED_LEDGER_BY_NAME = new Map(PREDEFINED_LEDGERS.filter((l) => l.code === 'CASH' || l.code === 'PROFIT_LOSS').map((l) => [key(l.name), l.code]));

function issueSink(issues: TallyIssue[]): (i: TallyIssue) => void {
  let dropped = 0;
  return (i) => {
    if (issues.length < MAX_ISSUES) issues.push(i);
    else if (++dropped === 1) issues.push({ severity: 'info', code: 'too_many_issues', message: `More than ${MAX_ISSUES} issues — the rest are not listed.` });
  };
}

/** Messages of an AppError (field issues listed individually). */
function messageOf(err: unknown): string {
  if (err instanceof AppError) {
    if (err.code === 'INTERNAL') throw err;
    const d = err.details;
    if (Array.isArray(d) && d.length > 0 && d.every((x) => x && typeof x === 'object' && 'message' in x)) return (d as FieldIssue[]).map((x) => x.message).join('; ');
    return err.message;
  }
  throw err;
}

function stateCodeOrNull(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) {
    const c = normalizeStateCode(t);
    return isKnownStateCode(c) ? c : null;
  }
  return findState(t)?.code ?? null;
}

// ───────────────────────────── Preview ─────────────────────────────

/** Σ ledger openings + opening stock value (0 when the Tally books balance). */
function openingDifference(file: TallyFile): number {
  const ledgers = file.ledgers.reduce((s, l) => s + l.opening, 0);
  const stock = file.stockItems.reduce((s, i) => s + i.openings.reduce((a, o) => a + (o.value ?? Math.round(o.qty * (o.rate ?? 0) * 100)), 0), 0);
  return ledgers + stock;
}

export function previewTally(ctx: CompanyCtx, input: TallyPreviewInput): TallyPreviewResult {
  requirePermission(ctx, 'data.import');
  const file = parseTallyFile(input.bytes);
  const db = ctx.db;
  const issues: TallyIssue[] = [...file.issues];
  const add = issueSink(issues);
  const baseOf = baseTypeResolver(db, file);

  const groupNames = nameIndex(db, 'groups');
  const ledgerNames = nameIndex(db, 'ledgers');
  const itemNames = nameIndex(db, 'stock_items');
  const units = unitIndex(db);
  const fileGroups = new Set(file.groups.map((g) => key(g.name)));
  const fileLedgers = new Set(file.ledgers.map((l) => key(l.name)));
  const fileItems = new Set(file.stockItems.map((i) => key(i.name)));
  const fileUnits = new Set(file.units.map((u) => key(u.name)));
  const groupKnown = (n: string): boolean => fileGroups.has(key(n)) || groupNames.has(key(n)) || PREDEFINED_GROUP_BY_NAME.has(key(n)) || key(n) in TALLY_GROUP_ALIASES;

  for (const g of file.groups) if (g.parent && !groupKnown(g.parent)) add({ severity: 'error', code: 'unknown_parent', message: `Parent group "${g.parent}" is not in the file or this company.`, object: `GROUP ${g.name}` });
  for (const l of file.ledgers) {
    const mapsToExisting = RESERVED_LEDGER_BY_NAME.has(key(l.reservedName ?? '')) || RESERVED_LEDGER_BY_NAME.has(key(l.name)) || ledgerNames.has(key(l.name));
    if (mapsToExisting) {
      // Taken over by an existing (or reserved) ledger: its group stays as it is.
    } else if (!l.parent) add({ severity: 'error', code: 'unknown_parent', message: 'The ledger has no group.', object: `LEDGER ${l.name}` });
    else if (!groupKnown(l.parent)) add({ severity: 'error', code: 'unknown_parent', message: `Group "${l.parent}" is not in the file or this company.`, object: `LEDGER ${l.name}` });
    if (l.openingBills.length > 0) {
      const s = l.openingBills.reduce((a, b) => a + b.amount, 0);
      if (s !== l.opening) add({ severity: 'warning', code: 'bill_mismatch', message: 'The opening bills do not add up to the opening balance; the bills will not be imported.', object: `LEDGER ${l.name}` });
    }
  }
  for (const i of file.stockItems) {
    if (!i.unit) add({ severity: 'error', code: 'missing_unit', message: 'The item has no unit.', object: `STOCKITEM ${i.name}` });
    else if (!fileUnits.has(key(i.unit)) && !units.has(key(i.unit))) add({ severity: 'error', code: 'unknown_unit', message: `Unit "${i.unit}" is not in the file or this company.`, object: `STOCKITEM ${i.name}` });
  }
  const diff = openingDifference(file);
  if (diff !== 0) {
    add({
      severity: 'warning',
      code: 'opening_difference',
      message: `Opening balances (ledgers and opening stock) do not balance (difference ₹ ${(Math.abs(diff) / 100).toFixed(2)} ${diff > 0 ? 'Dr' : 'Cr'}). It will show as a difference in opening balances.`,
    });
  }

  const byType = new Map<string, number>();
  let from: string | null = null;
  let to: string | null = null;
  const unknownLedgers = new Map<string, number>();
  for (const v of file.vouchers) {
    byType.set(v.vchType, (byType.get(v.vchType) ?? 0) + 1);
    if (v.date) {
      if (from === null || v.date < from) from = v.date;
      if (to === null || v.date > to) to = v.date;
    }
    const base = baseOf(v.vchType);
    if (!base) add({ severity: 'error', code: 'unknown_voucher_type', message: `Voucher type "${v.vchType}" is not known (add its VOUCHERTYPE master to the export).`, object: `VOUCHER ${voucherLabel(v)}` });
    else if (UNSUPPORTED_BASES.has(base)) add({ severity: 'warning', code: 'unsupported', message: 'Physical stock vouchers are not imported. Enter the stock count again after the import.', object: `VOUCHER ${voucherLabel(v)}` });
    if (!v.isCancelled) {
      const total = v.entries.reduce((s, e) => s + e.amount, 0);
      const isAccounting = base !== null && (ACCOUNTING_BASE_TYPES.includes(base) || base === 'memorandum' || base === 'reversing_journal');
      if (isAccounting && total !== 0) add({ severity: 'error', code: 'unbalanced', message: `Debit and credit differ by ₹ ${(Math.abs(total) / 100).toFixed(2)}; the voucher will be skipped.`, object: `VOUCHER ${voucherLabel(v)}` });
      for (const e of v.entries) if (!fileLedgers.has(key(e.ledger)) && !ledgerNames.has(key(e.ledger))) unknownLedgers.set(e.ledger, (unknownLedgers.get(e.ledger) ?? 0) + 1);
      for (const l of v.inventory) {
        if (!fileItems.has(key(l.item)) && !itemNames.has(key(l.item))) add({ severity: 'error', code: 'unknown_item', message: `Stock item "${l.item}" is not in the file or this company.`, object: `VOUCHER ${voucherLabel(v)}` });
      }
    }
  }
  for (const [name, count] of unknownLedgers) {
    add({ severity: 'error', code: 'unknown_ledger', message: `Ledger "${name}" is used in ${plural(count, 'voucher')} but is not in the file or this company. Export the masters too.` });
  }
  if (file.currencies.some((c) => !/^(₹|inr|rs\.?)$/i.test(c.name.trim()))) {
    add({ severity: 'info', code: 'currency', message: 'Foreign currency masters are not imported; amounts are taken in rupees.' });
  }
  for (const u of file.unsupported) add({ severity: 'info', code: 'unsupported', message: `${plural(u.count, u.type)} cannot be imported and will be ignored.` });

  const count = (names: Array<{ name: string }>, idx: Map<string, number>): number => names.filter((n) => idx.has(key(n.name))).length;
  return {
    fileName: input.fileName,
    encoding: file.encoding,
    companyName: file.companyName,
    counts: file.counts,
    unsupported: file.unsupported,
    vouchersByType: [...byType.entries()]
      .map(([voucherType, n]) => ({ voucherType, baseType: baseOf(voucherType), count: n }))
      .sort((a, b) => b.count - a.count || a.voucherType.localeCompare(b.voucherType)),
    dateRange: from && to ? { from, to } : null,
    samples: {
      groups: file.groups.slice(0, SAMPLE).map((g) => ({ name: g.name, parent: g.parent })),
      ledgers: file.ledgers.slice(0, SAMPLE).map((l) => ({ name: l.name, parent: l.parent || null, openingBalance: l.opening, gstin: l.gstin })),
      stockItems: file.stockItems.slice(0, SAMPLE).map((i) => ({
        name: i.name,
        unit: i.unit,
        openingQty: i.openings.reduce((s, o) => s + o.qty, 0),
        openingValue: i.openings.reduce((s, o) => s + (o.value ?? 0), 0),
      })),
      vouchers: file.vouchers.slice(0, SAMPLE).map((v) => ({
        date: v.date ?? v.rawDate,
        voucherType: v.vchType,
        number: v.number,
        party: v.party,
        amount: v.entries.reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0),
      })),
    },
    existing: {
      groups: count(file.groups, groupNames),
      ledgers: count(file.ledgers, ledgerNames),
      stockItems: count(file.stockItems, itemNames),
      units: file.units.filter((u) => units.has(key(u.name))).length,
      godowns: count(file.godowns, nameIndex(db, 'godowns')),
    },
    issues,
  };
}

// ───────────────────────────── Progress ─────────────────────────────

const progressByCompany = new Map<string, TallyProgress>();
const IDLE: TallyProgress = { running: false, phase: 'idle', done: 0, total: 0, message: '' };

export function tallyProgress(ctx: CompanyCtx): TallyProgress {
  return progressByCompany.get(ctx.company.dbPath + '|' + ctx.company.id) ?? IDLE;
}

function setProgress(ctx: CompanyCtx, p: TallyProgress): void {
  progressByCompany.set(ctx.company.dbPath + '|' + ctx.company.id, p);
}

// ───────────────────────────── Import: masters ─────────────────────────────

type MasterKind = keyof TallyImportResult['masters'];

const zero = (): TallyCounts => ({ created: 0, updated: 0, skipped: 0, failed: 0 });

interface Run {
  /** Audited context: every master the import creates or alters gets its own edit-log entry. */
  ctx: CompanyCtx;
  db: Db;
  file: TallyFile;
  update: boolean;
  add: (i: TallyIssue) => void;
  masters: TallyImportResult['masters'];
  /** Tally group name → this company's group id (covers renamed predefined groups). */
  groupIds: Map<string, number>;
  ledgerIds: Map<string, number>;
  booksFrom: string;
}

/**
 * Save through a service; on VALIDATION errors with field paths, retry once without those optional
 * fields (reported as a warning). `required` fields are never dropped.
 */
function saveTolerant<T extends object, R>(run: Run, object: string, input: T, required: readonly string[], save: (i: T) => R): R {
  let current: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = run.db.transaction(() => save(current as T));
      if (dropped.length > 0) {
        run.add({ severity: 'warning', code: 'field_dropped', message: `Imported without: ${dropped.join('; ')}.`, object });
      }
      return out;
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'VALIDATION' || !Array.isArray(err.details)) throw err;
      const issues = err.details as FieldIssue[];
      const fields = issues
        .map((i) => i.path.split(/[.[]/)[0])
        // A clash of the first alias is reported on 'alias' even when the whole list was sent as 'aliases'.
        .map((f) => (f === 'alias' && !('alias' in current) && 'aliases' in current ? 'aliases' : f))
        .filter((f) => f && f in current && !required.includes(f));
      if (fields.length === 0 || fields.length < issues.length) throw err;
      for (const f of new Set(fields)) delete current[f];
      for (const i of issues) dropped.push(i.message);
      current = { ...current };
    }
  }
  return run.db.transaction(() => save(current as T));
}

/** Process records whose dependencies (parents) may appear later in the file: repeat until stable. */
/**
 * Order records parents-first. `ready` says whether a record's parent already exists in the company
 * (true), will never exist ('never' — reported when the record is processed), or is still to come
 * (false). A parent placed earlier in the order also counts as ready: Tally lists masters
 * alphabetically, so 'Mumbai R&D' often comes before its parent 'R&D Projects'.
 */
function inDependencyOrder<T extends { name: string; parent: string | null }>(records: T[], ready: (r: T) => boolean | 'never'): { ordered: T[]; stuck: T[] } {
  let pending = records.filter((r) => r.name);
  const ordered: T[] = [];
  const placed = new Set<string>();
  for (;;) {
    const next: T[] = [];
    let progressed = false;
    for (const r of pending) {
      const ok = r.parent !== null && placed.has(key(r.parent)) ? true : ready(r);
      if (ok === true || ok === 'never') {
        ordered.push(r);
        placed.add(key(r.name));
        progressed = true;
      } else next.push(r);
    }
    pending = next;
    if (!progressed || pending.length === 0) break;
  }
  return { ordered, stuck: pending };
}

function groupNature(g: TGroup): GroupNature | null {
  if (g.isDeemedPositive === null) return null;
  if (g.isRevenue) return g.isDeemedPositive ? 'expenses' : 'income';
  return g.isDeemedPositive ? 'assets' : 'liabilities';
}

function resolveGroupId(run: Run, name: string | null): number | null | undefined {
  if (name === null) return null;
  const k = key(name);
  const mapped = run.groupIds.get(k);
  if (mapped !== undefined) return mapped;
  const idx = nameIndex(run.db, 'groups').get(k);
  if (idx !== undefined) return idx;
  const code = PREDEFINED_GROUP_BY_NAME.get(k) ?? TALLY_GROUP_ALIASES[k];
  if (code) return run.db.value<number>('SELECT id FROM groups WHERE reserved_code = :c', { c: code }) ?? undefined;
  return undefined;
}

function importGroups(run: Run): void {
  const c = run.masters.groups;
  const fileNames = new Set(run.file.groups.map((g) => key(g.name)));
  const { ordered, stuck } = inDependencyOrder(run.file.groups, (g) => {
    if (g.parent === null) return true;
    if (resolveGroupId(run, g.parent) !== undefined) return true;
    // Parent defined later in the file: wait; otherwise it will never resolve.
    return fileNames.has(key(g.parent)) ? false : 'never';
  });
  for (const g of stuck) {
    c.failed++;
    run.add({ severity: 'error', code: 'unknown_parent', message: `Parent group "${g.parent ?? ''}" could not be created (circular or missing).`, object: `GROUP ${g.name}` });
  }
  for (const g of ordered) {
    const object = `GROUP ${g.name}`;
    // A predefined Tally group (possibly renamed): map to ours by its reserved name.
    const reservedCode = g.reservedName ? (PREDEFINED_GROUP_BY_NAME.get(key(g.reservedName)) ?? TALLY_GROUP_ALIASES[key(g.reservedName)]) : undefined;
    if (reservedCode) {
      const id = run.db.value<number>('SELECT id FROM groups WHERE reserved_code = :c', { c: reservedCode });
      if (id !== undefined) {
        run.groupIds.set(key(g.name), id);
        c.skipped++;
        continue;
      }
    }
    const existing = resolveGroupId(run, g.name);
    const parentId = resolveGroupId(run, g.parent);
    if (parentId === undefined) {
      c.failed++;
      run.add({ severity: 'error', code: 'unknown_parent', message: `Parent group "${g.parent ?? ''}" is not in the file or this company.`, object });
      continue;
    }
    try {
      if (existing !== undefined && existing !== null) {
        run.groupIds.set(key(g.name), existing);
        const predefined = run.db.value<number>('SELECT is_predefined FROM groups WHERE id = :id', { id: existing }) === 1;
        if (!run.update || predefined) {
          c.skipped++;
          continue;
        }
        saveTolerant(run, object, { id: existing, parentId, alias: g.aliases[0] ?? undefined }, ['id'], (i) => saveGroup(run.ctx, i));
        c.updated++;
        continue;
      }
      const nature = parentId === null ? groupNature(g) : undefined;
      if (parentId === null && !nature) {
        run.add({ severity: 'warning', code: 'nature_guessed', message: 'The group nature is not in the file; it is created as an asset group.', object });
      }
      const created = saveTolerant(
        run,
        object,
        {
          name: g.name,
          parentId,
          alias: g.aliases[0] ?? undefined,
          ...(parentId === null ? { nature: nature ?? 'assets', affectsGrossProfit: g.affectsGrossProfit === true && (nature === 'income' || nature === 'expenses') } : {}),
        },
        ['name', 'parentId', 'nature'],
        (i) => saveGroup(run.ctx, i),
      );
      run.groupIds.set(key(g.name), created.id);
      c.created++;
    } catch (err) {
      c.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object });
    }
  }
}

function importUnits(run: Run): void {
  const c = run.masters.units;
  const simple = run.file.units.filter((u) => u.isSimple && u.name);
  const compound = run.file.units.filter((u) => !u.isSimple && u.name);
  for (const u of simple) {
    const object = `UNIT ${u.name}`;
    const existing = unitIndex(run.db).get(key(u.name));
    try {
      const fields = { formalName: u.formalName ?? undefined, uqc: u.uqc ?? undefined, decimalPlaces: u.decimals };
      if (existing !== undefined) {
        if (!run.update) {
          c.skipped++;
          continue;
        }
        const symbol = run.db.value<string>('SELECT symbol FROM units WHERE id = :id', { id: existing }) as string;
        saveTolerant(run, object, { id: existing, kind: 'simple' as const, symbol, ...fields }, ['id', 'kind', 'symbol'], (i) => saveUnit(run.ctx, i));
        c.updated++;
        continue;
      }
      saveTolerant(run, object, { kind: 'simple' as const, symbol: u.name, ...fields }, ['kind', 'symbol'], (i) => saveUnit(run.ctx, i));
      c.created++;
    } catch (err) {
      c.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object });
    }
  }
  for (const u of compound) {
    const object = `UNIT ${u.name}`;
    const idx = unitIndex(run.db);
    const first = u.baseUnit ? idx.get(key(u.baseUnit)) : undefined;
    const second = u.additionalUnit ? idx.get(key(u.additionalUnit)) : undefined;
    if (first === undefined || second === undefined || !u.conversion || u.conversion <= 0) {
      c.failed++;
      run.add({ severity: 'error', code: 'unknown_unit', message: `The units of this compound unit (${u.baseUnit ?? '?'} of ${u.conversion ?? '?'} ${u.additionalUnit ?? '?'}) are not known.`, object });
      continue;
    }
    const existing = run.db.value<number>('SELECT id FROM units WHERE is_compound = 1 AND first_unit_id = :f AND second_unit_id = :s AND conversion = :c', {
      f: first,
      s: second,
      c: u.conversion,
    });
    if (existing !== undefined || idx.has(key(u.name))) {
      c.skipped++;
      continue;
    }
    try {
      saveTolerant(run, object, { kind: 'compound' as const, firstUnitId: first, conversion: u.conversion, secondUnitId: second }, ['kind', 'firstUnitId', 'conversion', 'secondUnitId'], (i) =>
        saveUnit(run.ctx, i),
      );
      c.created++;
    } catch (err) {
      c.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object });
    }
  }
}

/** Generic tree master (godowns, stock groups, stock categories, cost centres). */
function importTree<T extends TNamed>(
  run: Run,
  kind: MasterKind,
  label: string,
  records: T[],
  table: 'godowns' | 'stock_groups' | 'stock_categories' | 'cost_centres',
  create: (r: T, parentId: number | null) => unknown,
  alter: ((r: T, id: number, parentId: number | null) => unknown) | null,
): void {
  const c = run.masters[kind];
  const fileNames = new Set(records.map((r) => key(r.name)));
  const lookup = (name: string): number | undefined => nameIndex(run.db, table).get(key(name));
  const { ordered, stuck } = inDependencyOrder(records, (r) => (r.parent === null || lookup(r.parent) !== undefined ? true : fileNames.has(key(r.parent)) ? false : 'never'));
  for (const r of stuck) {
    c.failed++;
    run.add({ severity: 'error', code: 'unknown_parent', message: `Parent "${r.parent ?? ''}" could not be created.`, object: `${label} ${r.name}` });
  }
  for (const r of ordered) {
    const object = `${label} ${r.name}`;
    const parentId = r.parent === null ? null : (lookup(r.parent) ?? undefined);
    if (parentId === undefined) {
      c.failed++;
      run.add({ severity: 'error', code: 'unknown_parent', message: `Parent "${r.parent ?? ''}" is not in the file or this company.`, object });
      continue;
    }
    const existing = lookup(r.name);
    try {
      if (existing !== undefined) {
        if (!run.update || !alter) {
          c.skipped++;
          continue;
        }
        alter(r, existing, parentId);
        c.updated++;
        continue;
      }
      create(r, parentId);
      c.created++;
    } catch (err) {
      c.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object });
    }
  }
}

function gstFields(gst: TallyFile['stockItems'][number]['gst']): Pick<StockItemSaveInput, 'hsnSac' | 'gstRate' | 'taxability' | 'gstApplicable' | 'cessRate'> {
  const out: Pick<StockItemSaveInput, 'hsnSac' | 'gstRate' | 'taxability' | 'gstApplicable' | 'cessRate'> = {};
  if (gst.hsn) out.hsnSac = gst.hsn;
  if (gst.taxability) out.taxability = gst.taxability;
  if (gst.rate !== null && (gst.taxability === null || gst.taxability === 'taxable')) out.gstRate = gst.rate;
  if (gst.cessRate) out.cessRate = gst.cessRate;
  if (gst.applicable === false) out.gstApplicable = false;
  else if (gst.applicable === true || out.gstRate !== undefined || (gst.taxability !== null && gst.taxability !== 'taxable')) out.gstApplicable = true;
  return out;
}

const REGISTRATION: Record<string, RegistrationType> = {
  regular: 'regular',
  composition: 'composition',
  unregistered: 'unregistered',
  'unregistered/consumer': 'unregistered',
  consumer: 'consumer',
  sez: 'sez',
  'regular - sez': 'sez',
  overseas: 'overseas',
  'deemed export': 'deemed_export',
  uin: 'uin',
  'uin holders': 'uin',
};

function directionGuess(name: string): 'output' | 'input' | 'rcm_liability' | null {
  if (/reverse|rcm/i.test(name)) return 'rcm_liability';
  if (/\binput\b|\bitc\b/i.test(name)) return 'input';
  if (/\boutput\b/i.test(name)) return 'output';
  return null;
}

function ledgerFields(run: Run, l: TLedger, groupId: number): LedgerSaveInput {
  const cls = (() => {
    try {
      return ledgerClassOfGroup(run.db, groupId);
    } catch {
      return null;
    }
  })();
  const input: LedgerSaveInput = { openingBalance: l.opening };
  const existingId = run.db.value<number>('SELECT id FROM ledgers WHERE name = :n COLLATE NOCASE', { n: l.name }) ?? null;
  const aliases = importableAliases(run, 'ledger', l.aliases, existingId, `LEDGER ${l.name}`);
  if (aliases.length > 0) input.aliases = aliases;
  if (cls?.isParty || cls?.isBank) input.billWise = l.billWise;
  if (l.costCentres) input.costCentresApplicable = true;
  if (l.creditDays !== null) input.defaultCreditDays = l.creditDays;
  if (l.creditLimit !== null) input.creditLimit = l.creditLimit;
  if (l.mailingName && l.mailingName !== l.name) input.mailingName = l.mailingName;
  if (l.address) input.address = l.address;
  const state = stateCodeOrNull(l.stateName) ?? (l.gstin && /^\d{2}/.test(l.gstin) ? stateCodeOrNull(l.gstin.slice(0, 2)) : null);
  if (state) input.stateCode = state;
  if (l.pincode) input.pincode = l.pincode;
  if (l.contact) input.contactPerson = l.contact;
  if (l.phone) input.phone = l.phone;
  if (l.mobile) input.mobile = l.mobile;
  if (l.email) input.email = l.email;
  if (l.pan) input.pan = l.pan;
  if (l.gstin) input.gstin = l.gstin;
  const reg = l.registrationType ? REGISTRATION[key(l.registrationType)] : undefined;
  if (reg) input.registrationType = reg;
  else if (l.gstin && cls?.isParty) input.registrationType = 'regular';
  if (cls?.isBank) {
    if (l.bank.accountNo) input.bankAccountNo = l.bank.accountNo;
    if (l.bank.ifsc) input.bankIfsc = l.bank.ifsc;
    if (l.bank.bankName) input.bankName = l.bank.bankName;
    if (l.bank.branch) input.bankBranch = l.bank.branch;
    if (l.bank.holder) input.bankAccountHolder = l.bank.holder;
  }
  if (l.dutyHead || /^gst$/i.test(l.taxType ?? '')) {
    input.taxType = 'GST';
    if (l.dutyHead) input.gstDutyHead = l.dutyHead;
    const dir = directionGuess(l.name);
    if (dir) input.gstTaxDirection = dir;
  } else if (l.taxType && cls?.isDutyTax) {
    const t = l.taxType.toUpperCase();
    input.taxType = t === 'TDS' || t === 'TCS' ? t : 'OTHER';
  }
  if (cls && !cls.isDutyTax && !cls.isParty && !cls.isCashOrBank) {
    const g = gstFields(l.gst);
    if (g.gstApplicable !== undefined) input.gstApplicable = g.gstApplicable;
    if (g.gstRate !== undefined && g.gstRate !== null) {
      input.gstRate = g.gstRate;
      if (!isStandardRate(g.gstRate)) input.allowNonStandardRate = true;
    }
    if (g.hsnSac) input.hsnSac = g.hsnSac;
    if (g.taxability) input.gstTaxability = g.taxability;
    if (g.cessRate) input.cessRate = g.cessRate;
    if (l.gst.supplyType) input.gstSupplyType = l.gst.supplyType;
  }
  return input;
}

function ledgerClassOfGroup(db: Db, groupId: number): ReturnType<typeof ledgerClass> {
  return classifyGroup(db, groupId);
}

function classifyGroup(db: Db, groupId: number): ReturnType<typeof ledgerClass> {
  const codes = new Set<string>();
  let nature: GroupNature = 'assets';
  let gp = false;
  let first = true;
  let id: number | null = groupId;
  let primaryCode: string | null = null;
  for (let i = 0; i < 64 && id !== null; i++) {
    const r: { parent_id: number | null; reserved_code: string | null; nature: GroupNature; affects_gross_profit: number } | undefined = db.get(
      'SELECT parent_id, reserved_code, nature, affects_gross_profit FROM groups WHERE id = :id',
      { id },
    );
    if (!r) break;
    if (r.reserved_code) codes.add(r.reserved_code);
    if (first) {
      nature = r.nature;
      gp = r.affects_gross_profit === 1;
      first = false;
    }
    if (r.parent_id === null) primaryCode = r.reserved_code;
    id = r.parent_id;
  }
  const isBankOd = codes.has('BANK_OD');
  const isBank = isBankOd || codes.has('BANK_ACCOUNTS');
  const isCash = codes.has('CASH_IN_HAND');
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
    isIncome: nature === 'income',
    isExpense: nature === 'expenses',
    nature,
    affectsGrossProfit: gp,
    primaryCode: primaryCode as ReturnType<typeof ledgerClass>['primaryCode'],
  };
}

function openingBillsOf(run: Run, l: TLedger, object: string): OpeningBillInput[] | undefined {
  if (l.openingBills.length === 0 || !l.billWise) return undefined;
  const sum = l.openingBills.reduce((s, b) => s + b.amount, 0);
  if (sum !== l.opening) {
    run.add({ severity: 'warning', code: 'bill_mismatch', message: 'The opening bills do not add up to the opening balance; they were not imported.', object });
    return undefined;
  }
  const fallback = addDays(run.booksFrom, -1);
  return l.openingBills.map((b) => {
    const billDate = b.date && b.date < run.booksFrom ? b.date : fallback;
    return { billName: b.name, billDate, dueDate: b.creditDays !== null ? addDays(billDate, b.creditDays) : null, amount: b.amount };
  });
}

function importLedgers(run: Run): void {
  const c = run.masters.ledgers;
  for (const l of run.file.ledgers) {
    if (!l.name) continue;
    const object = `LEDGER ${l.name}`;
    try {
      // Tally's own Cash / Profit & Loss A/c (possibly renamed) → this company's reserved ledgers.
      const reservedCode = RESERVED_LEDGER_BY_NAME.get(key(l.reservedName ?? '')) ?? RESERVED_LEDGER_BY_NAME.get(key(l.name));
      let existing: number | undefined = reservedCode ? run.db.value<number>('SELECT id FROM ledgers WHERE reserved_code = :c', { c: reservedCode }) : undefined;
      existing ??= nameIndex(run.db, 'ledgers').get(key(l.name));
      if (existing !== undefined) {
        run.ledgerIds.set(key(l.name), existing);
        const row = run.db.get<{ is_predefined: number; reserved_code: string | null; opening_balance: number; group_id: number }>(
          'SELECT is_predefined, reserved_code, opening_balance, group_id FROM ledgers WHERE id = :id',
          { id: existing },
        );
        const predefined = row !== undefined && (row.is_predefined === 1 || row.reserved_code !== null);
        if (predefined) {
          // Predefined ledgers take over the opening balance only (their settings are fixed).
          if (l.opening !== 0 && (row.opening_balance === 0 || run.update)) {
            const bills = openingBillsOf(run, l, object);
            saveTolerant(run, object, { id: existing, openingBalance: l.opening, ...(bills ? { openingBills: bills } : {}) }, ['id', 'openingBalance'], (i) => saveLedger(run.ctx, i));
            c.updated++;
          } else c.skipped++;
          continue;
        }
        if (!run.update) {
          c.skipped++;
          continue;
        }
        const gid = resolveGroupId(run, l.parent || null) ?? row?.group_id ?? null;
        if (gid === null) throw validation([{ path: 'groupId', message: `Group "${l.parent}" does not exist` }]);
        const bills = openingBillsOf(run, l, object);
        saveTolerant(run, object, { ...ledgerFields(run, l, gid), id: existing, groupId: gid, ...(bills ? { openingBills: bills } : {}) }, ['id', 'groupId', 'openingBalance'], (i) =>
          saveLedger(run.ctx, i),
        );
        c.updated++;
        continue;
      }
      const gid = l.parent ? resolveGroupId(run, l.parent) : undefined;
      if (gid === undefined || gid === null) {
        c.failed++;
        run.add({ severity: 'error', code: 'unknown_parent', message: `Group "${l.parent}" is not in the file or this company.`, object });
        continue;
      }
      const bills = openingBillsOf(run, l, object);
      const saved = saveTolerant(run, object, { ...ledgerFields(run, l, gid), name: l.name, groupId: gid, ...(bills ? { openingBills: bills } : {}) }, ['name', 'groupId', 'openingBalance'], (i) =>
        saveLedger(run.ctx, i),
      );
      run.ledgerIds.set(key(l.name), saved.id);
      c.created++;
    } catch (err) {
      c.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object });
    }
  }
}

const COSTING: Record<string, CostingMethod> = {
  'avg. cost': 'avg_cost',
  'avg cost': 'avg_cost',
  'average cost': 'avg_cost',
  fifo: 'fifo',
  'fifo perpetual': 'fifo',
  lifo: 'lifo',
  'lifo perpetual': 'lifo',
  'last purchase cost': 'last_purchase',
  'std. cost': 'std_cost',
  'standard cost': 'std_cost',
};

function importStockItems(run: Run): void {
  const c = run.masters.stockItems;
  const units = unitIndex(run.db);
  const groups = nameIndex(run.db, 'stock_groups');
  const categories = nameIndex(run.db, 'stock_categories');
  const godowns = nameIndex(run.db, 'godowns');
  const main = mainGodownId(run.db);
  for (const it of run.file.stockItems) {
    if (!it.name) continue;
    const object = `STOCKITEM ${it.name}`;
    try {
      const existing = nameIndex(run.db, 'stock_items').get(key(it.name));
      if (existing !== undefined && !run.update) {
        c.skipped++;
        continue;
      }
      const unitId = it.unit ? units.get(key(it.unit)) : undefined;
      if (unitId === undefined && existing === undefined) {
        c.failed++;
        run.add({ severity: 'error', code: 'unknown_unit', message: `Unit "${it.unit ?? ''}" is not known.`, object });
        continue;
      }
      const input: StockItemSaveInput = { ...gstFields(it.gst) };
      if (unitId !== undefined) input.unitId = unitId;
      {
        const aliases = importableAliases(run, 'stock_item', it.aliases, existing ?? null, object);
        if (aliases.length > 0) input.aliases = aliases;
      }
      if (it.description) input.description = it.description;
      if (it.parent) {
        const g = groups.get(key(it.parent));
        if (g === undefined) run.add({ severity: 'warning', code: 'unknown_parent', message: `Stock group "${it.parent}" is not known; the item is created without a group.`, object });
        else input.groupId = g;
      }
      if (it.category) {
        const cat = categories.get(key(it.category));
        if (cat !== undefined) input.categoryId = cat;
      }
      const costing = it.costingMethod ? COSTING[key(it.costingMethod)] : undefined;
      if (costing) input.costingMethod = costing;
      if (it.maintainBatches && it.openings.some((o) => o.batch)) input.maintainBatches = true;
      if (input.gstRate !== undefined && input.gstRate !== null && !isStandardRate(input.gstRate)) {
        run.add({ severity: 'warning', code: 'non_standard_rate', message: `GST rate ${input.gstRate}% is not a notified rate.`, object });
      }
      const openings: StockOpeningInput[] = it.openings.map((o) => {
        const godownId = o.godown ? (godowns.get(key(o.godown)) ?? main) : main;
        const op: StockOpeningInput = { qty: o.qty, godownId };
        if (o.batch && input.maintainBatches) op.batchName = o.batch;
        if (o.value !== null) op.value = o.value;
        if (o.rate !== null) op.rate = o.rate;
        else if (o.value !== null && o.qty !== 0) op.rate = Math.round((o.value / 100 / o.qty) * 1e6) / 1e6;
        return op;
      });
      if (openings.length > 0) input.openings = openings;
      if (existing !== undefined) {
        saveTolerant(run, object, { ...input, id: existing }, ['id'], (i) => saveItem(run.ctx, i));
        c.updated++;
      } else {
        const res = saveTolerant(run, object, { ...input, name: it.name }, ['name', 'unitId'], (i) => saveItem(run.ctx, i));
        for (const w of res.warnings) run.add({ severity: 'info', code: 'item_note', message: w, object });
        c.created++;
      }
    } catch (err) {
      c.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object });
    }
  }
}

function importVoucherTypes(run: Run, baseOf: (name: string) => VoucherBaseType | null): void {
  const c = run.masters.voucherTypes;
  const existing = new Set(run.db.all<{ name: string }>('SELECT name FROM voucher_types').map((r) => key(r.name)));
  for (const t of run.file.voucherTypes) {
    if (!t.name) continue;
    if (existing.has(key(t.name)) || TALLY_BASE[key(t.name)]) {
      c.skipped++;
      continue;
    }
    const object = `VOUCHERTYPE ${t.name}`;
    const base = baseOf(t.name);
    if (!base) {
      c.failed++;
      run.add({ severity: 'warning', code: 'unsupported', message: 'This voucher type is not supported (payroll, job work and attendance types are not imported).', object });
      continue;
    }
    const method = key(t.numberingMethod ?? '');
    const input: VoucherTypeSaveInput = {
      name: t.name,
      baseType: base,
      abbreviation: t.abbreviation ?? undefined,
      isActive: t.isActive,
      numbering: { method: method === 'manual' ? 'manual' : method === 'none' ? 'none' : 'automatic_override' },
    };
    try {
      saveTolerant(run, object, input, ['name', 'baseType'], (i) => saveVoucherType(run.ctx, i));
      existing.add(key(t.name));
      c.created++;
    } catch (err) {
      c.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object });
    }
  }
}

function enableNeededFeatures(run: Run): void {
  const f = getFeatures(run.db);
  const want: Partial<Record<'costCentres' | 'multipleGodowns' | 'batches', boolean>> = {};
  if (!f.costCentres && (run.file.costCentres.length > 0 || run.file.vouchers.some((v) => v.entries.some((e) => e.costs.length > 0)))) want.costCentres = true;
  if (!f.multipleGodowns && run.file.godowns.some((g) => key(g.name) !== 'main location')) want.multipleGodowns = true;
  if (!f.batches && run.file.stockItems.some((i) => i.maintainBatches && i.openings.some((o) => o.batch))) want.batches = true;
  const keys = Object.keys(want);
  if (keys.length === 0) return;
  const names = keys.map((k) => ({ costCentres: 'Cost centres', multipleGodowns: 'Multiple godowns', batches: 'Batches' })[k as 'costCentres']).join(', ');
  // Changing F11 needs the same right as on the Features screen; without it the data is still imported.
  if (!hasPermission(run.ctx, 'company.manage')) {
    run.add({ severity: 'warning', code: 'features_not_enabled', message: `The Tally data uses: ${names}. Ask a user who can manage the company to turn ${keys.length === 1 ? 'it' : 'them'} on in Features (F11).` });
    return;
  }
  saveFeatures(run.ctx, want); // audited ('settings' entry with before/after)
  run.add({ severity: 'info', code: 'features_enabled', message: `Turned on in F11 (used in the Tally data): ${names}.` });
}

function importMasters(run: Run, baseOf: (name: string) => VoucherBaseType | null): void {
  enableNeededFeatures(run);
  importGroups(run);
  importUnits(run);
  importTree(
    run,
    'godowns',
    'GODOWN',
    run.file.godowns,
    'godowns',
    (g, parentId) => saveTolerant(run, `GODOWN ${g.name}`, { name: g.name, parentId, alias: g.aliases[0] ?? undefined, address: g.address ?? undefined }, ['name'], (i) => saveGodown(run.ctx, i)),
    (g, id, parentId) => {
      const name = run.db.value<string>('SELECT name FROM godowns WHERE id = :id', { id }) as string;
      return saveTolerant(run, `GODOWN ${g.name}`, { id, name, parentId, address: g.address ?? undefined }, ['id', 'name'], (i) => saveGodown(run.ctx, i));
    },
  );
  importTree(
    run,
    'stockGroups',
    'STOCKGROUP',
    run.file.stockGroups,
    'stock_groups',
    (g, parentId) => saveTolerant(run, `STOCKGROUP ${g.name}`, { name: g.name, parentId, alias: g.aliases[0] ?? undefined, ...gstFields(g.gst) }, ['name'], (i) => saveStockGroup(run.ctx, i)),
    (g, id, parentId) => {
      const name = run.db.value<string>('SELECT name FROM stock_groups WHERE id = :id', { id }) as string;
      return saveTolerant(run, `STOCKGROUP ${g.name}`, { id, name, parentId, ...gstFields(g.gst) }, ['id', 'name'], (i) => saveStockGroup(run.ctx, i));
    },
  );
  importTree(
    run,
    'stockCategories',
    'STOCKCATEGORY',
    run.file.stockCategories,
    'stock_categories',
    (g, parentId) => saveTolerant(run, `STOCKCATEGORY ${g.name}`, { name: g.name, parentId, alias: g.aliases[0] ?? undefined }, ['name'], (i) => saveStockCategory(run.ctx, i)),
    null,
  );
  // Cost categories (flat).
  const cats = run.masters.costCategories;
  for (const cat of run.file.costCategories) {
    if (!cat.name) continue;
    if (nameIndex(run.db, 'cost_categories').has(key(cat.name))) {
      cats.skipped++;
      continue;
    }
    try {
      saveTolerant(run, `COSTCATEGORY ${cat.name}`, { name: cat.name }, ['name'], (i) => saveCostCategory(run.ctx, i));
      cats.created++;
    } catch (err) {
      cats.failed++;
      run.add({ severity: 'error', code: 'master_failed', message: messageOf(err), object: `COSTCATEGORY ${cat.name}` });
    }
  }
  importTree(
    run,
    'costCentres',
    'COSTCENTRE',
    run.file.costCentres,
    'cost_centres',
    (cc, parentId) => {
      const categories = nameIndex(run.db, 'cost_categories');
      const categoryId =
        (cc.category ? categories.get(key(cc.category)) : undefined) ??
        (parentId !== null ? run.db.value<number>('SELECT category_id FROM cost_centres WHERE id = :id', { id: parentId }) : undefined) ??
        (run.db.value<number>('SELECT id FROM cost_categories ORDER BY is_predefined DESC, id LIMIT 1') as number);
      return saveTolerant(run, `COSTCENTRE ${cc.name}`, { name: cc.name, categoryId, parentId, alias: cc.aliases[0] ?? undefined }, ['name', 'categoryId'], (i) => saveCostCentre(run.ctx, i));
    },
    null,
  );
  importLedgers(run);
  importStockItems(run);
  importVoucherTypes(run, baseOf);
}

// ───────────────────────────── Import: vouchers ─────────────────────────────

interface LedgerInfo {
  id: number;
  name: string;
  cls: ReturnType<typeof ledgerClass>;
  reservedCode: string | null;
  dutyHead: TallyDutyHead | null;
  billWise: boolean;
  creditDays: number | null;
  costCentres: boolean;
  stateCode: string | null;
  gstin: string | null;
  registrationType: string | null;
  address: string | null;
  pincode: string | null;
}

interface ItemInfo {
  id: number;
  name: string;
  unit: string;
  uqc: string | null;
  isService: boolean;
  decimals: number;
}

interface VoucherEnv {
  run: Run;
  baseOf: (name: string) => VoucherBaseType | null;
  ledgers: Map<string, LedgerInfo>;
  ledgerById: Map<number, LedgerInfo>;
  items: Map<string, ItemInfo>;
  godowns: Map<string, number>;
  centres: Map<string, number>;
  types: Map<string, number>;
  mainGodown: number;
  lookup: TaxLookup;
  company: { stateCode: string | null; registration: 'regular' | 'composition' | 'unregistered'; fyStartMonth: number };
  features: ReturnType<typeof getFeatures>;
  lockedUpTo: string | null;
  b2clThreshold: number;
  batchId: number;
  now: string;
  userName: string | null;
  counts: TallyCounts;
  /** Tally GUID → voucher id of vouchers already imported from Tally (loaded once; kept up to date). */
  guids: Map<string, number>;
  /** Set by writeVoucher: the id written for the voucher being processed (committed into `guids` by the caller). */
  lastWritten: { guid: string; id: number } | null;
}

/** GUIDs of vouchers imported from Tally earlier (one scan instead of one per voucher). */
function loadTallyGuids(db: Db): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of db.all<{ id: number; guid: unknown }>(
    `SELECT id, json_extract(meta, '$.tally.guid') AS guid FROM vouchers WHERE json_valid(meta) AND json_extract(meta, '$.source') = 'tally'`,
  )) {
    if (typeof r.guid === 'string' && r.guid !== '' && !map.has(r.guid)) map.set(r.guid, r.id);
  }
  return map;
}

function loadLedgers(db: Db): { byName: Map<string, LedgerInfo>; byId: Map<number, LedgerInfo> } {
  const rows = db.all<{
    id: number;
    name: string;
    alias: string | null;
    group_id: number;
    reserved_code: string | null;
    gst_duty_head: string | null;
    tax_type: string | null;
    maintain_bill_wise: number;
    default_credit_days: number | null;
    cost_centres_applicable: number;
    state_code: string | null;
    gstin: string | null;
    gst_registration_type: string | null;
    address: string | null;
    pincode: string | null;
  }>(
    `SELECT id, name, alias, group_id, reserved_code, gst_duty_head, tax_type, maintain_bill_wise, default_credit_days, cost_centres_applicable,
            state_code, gstin, gst_registration_type, address, pincode FROM ledgers ORDER BY id`,
  );
  const byName = new Map<string, LedgerInfo>();
  const byId = new Map<number, LedgerInfo>();
  const classes = new Map<number, ReturnType<typeof ledgerClass>>();
  for (const r of rows) {
    let cls = classes.get(r.group_id);
    if (!cls) {
      cls = classifyGroup(db, r.group_id);
      classes.set(r.group_id, cls);
    }
    const head = r.gst_duty_head === 'IGST' || r.gst_duty_head === 'CGST' || r.gst_duty_head === 'SGST' || r.gst_duty_head === 'CESS' ? r.gst_duty_head : null;
    const info: LedgerInfo = {
      id: r.id,
      name: r.name,
      cls,
      reservedCode: r.reserved_code,
      dutyHead: (r.tax_type === 'GST' || r.tax_type === null) && head ? head : null,
      billWise: r.maintain_bill_wise === 1,
      creditDays: r.default_credit_days,
      costCentres: r.cost_centres_applicable === 1,
      stateCode: r.state_code,
      gstin: r.gstin,
      registrationType: r.gst_registration_type,
      address: r.address,
      pincode: r.pincode,
    };
    byId.set(r.id, info);
    if (r.alias && !byName.has(key(r.alias))) byName.set(key(r.alias), info);
  }
  for (const [id, list] of extraAliasMap(db, 'ledger')) {
    const info = byId.get(id);
    if (info) for (const a of list) if (!byName.has(key(a))) byName.set(key(a), info);
  }
  for (const info of byId.values()) byName.set(key(info.name), info);
  return { byName, byId };
}

function loadItems(db: Db): Map<string, ItemInfo> {
  const map = new Map<string, ItemInfo>();
  const rows = db.all<{ id: number; name: string; alias: string | null; symbol: string; uqc: string | null; is_service: number; decimal_places: number }>(
    'SELECT i.id, i.name, i.alias, u.symbol, u.uqc, i.is_service, u.decimal_places FROM stock_items i JOIN units u ON u.id = i.unit_id ORDER BY i.id',
  );
  for (const r of rows) if (r.alias) map.set(key(r.alias), { id: r.id, name: r.name, unit: r.symbol, uqc: r.uqc, isService: r.is_service === 1, decimals: r.decimal_places });
  {
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    for (const [id, list] of extraAliasMap(db, 'stock_item')) {
      const r = byId.get(id);
      if (r) for (const a of list) if (!map.has(key(a))) map.set(key(a), { id: r.id, name: r.name, unit: r.symbol, uqc: r.uqc, isService: r.is_service === 1, decimals: r.decimal_places });
    }
  }
  for (const r of rows) map.set(key(r.name), { id: r.id, name: r.name, unit: r.symbol, uqc: r.uqc, isService: r.is_service === 1, decimals: r.decimal_places });
  return map;
}

const STOCK_OUT: ReadonlySet<VoucherBaseType> = new Set(['sales', 'debit_note', 'delivery_note', 'rejection_out', 'sales_order']);
const STOCK_IN: ReadonlySet<VoucherBaseType> = new Set(['purchase', 'credit_note', 'receipt_note', 'rejection_in', 'purchase_order']);
const ORDERS: ReadonlySet<VoucherBaseType> = new Set(['sales_order', 'purchase_order']);
const INVOICE_TRACKED: ReadonlySet<VoucherBaseType> = new Set(['sales', 'purchase', 'credit_note', 'debit_note']);

function instrumentType(t: string | null): InstrumentType {
  const s = key(t ?? '');
  if (s.includes('cheque') || s === 'dd' || s.includes('demand draft')) return s === 'dd' || s.includes('demand draft') ? 'dd' : 'cheque';
  if (s.includes('e-fund') || s.includes('neft')) return 'neft';
  if (s.includes('rtgs')) return 'rtgs';
  if (s.includes('imps')) return 'imps';
  if (s.includes('upi')) return 'upi';
  if (s.includes('card')) return 'card';
  if (s === 'cash') return 'cash';
  return 'other';
}

interface EntryRow {
  ledger: LedgerInfo;
  amount: number;
  role: string;
  head: TallyDutyHead | null;
  bills: Array<{ refType: 'new' | 'against' | 'advance' | 'on_account'; name: string | null; amount: number; creditDays: number | null; dueDate: string | null }>;
  costs: Array<{ centreId: number; amount: number }>;
  bank: TEntry['bank'];
  fromInventory: boolean;
}

interface InvRow {
  item: ItemInfo;
  godownId: number;
  batch: string | null;
  qty: number;
  billedQty: number | null;
  rate: number;
  discountPct: number;
  amount: number;
  ledgerId: number | null;
  trackingRef: string | null;
  orderRef: string | null;
  isConsumption: boolean;
  affectsStock: boolean;
  hsn: string | null;
  gstRate: number | null;
}

interface GstRow {
  source: 'item' | 'ledger';
  itemId: number | null;
  ledgerId: number | null;
  description: string | null;
  hsn: string | null;
  uqc: string | null;
  qty: number | null;
  supply: 'goods' | 'services';
  taxability: Taxability;
  rate: number;
  cessRate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  itc: string | null;
}

class SkipVoucher extends Error {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  constructor(code: string, message: string, severity: 'error' | 'warning' = 'error') {
    super(message);
    this.code = code;
    this.severity = severity;
  }
}

/** Merge entries of the same ledger that come from inventory accounting allocations. */
function mergeEntries(entries: TEntry[]): TEntry[] {
  const out: TEntry[] = [];
  const byLedger = new Map<string, TEntry>();
  for (const e of entries) {
    if (!e.fromInventory) {
      out.push({ ...e, bills: [...e.bills], costs: [...e.costs] });
      continue;
    }
    const k = key(e.ledger);
    const prev = byLedger.get(k);
    if (prev) {
      prev.amount += e.amount;
      prev.costs.push(...e.costs);
      prev.bills.push(...e.bills);
    } else {
      const copy = { ...e, bills: [...e.bills], costs: [...e.costs] };
      byLedger.set(k, copy);
      out.push(copy);
    }
  }
  return out.filter((e) => e.amount !== 0 || e.bills.length > 0);
}

function numberSeq(db: Db, typeId: number, num: string | null, date?: string, fyStartMonth?: number): number | null {
  if (!num) return null;
  const vt = loadVoucherType(db, typeId);
  const seq = parseVoucherSeq(vt, num, date, fyStartMonth);
  if (seq !== null) return seq;
  const m = /(\d{1,15})(?!.*\d)/.exec(num);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Keep the automatic numbering counter at or above an imported number in this type's own format, so
 * the next voucher entered after a migration does not have to skip over thousands of used numbers.
 */
function advanceCounter(db: Db, vt: VoucherTypeInfo, num: string | null, date: string, fyStartMonth: number): void {
  if (!num || vt.numberingMethod === 'none' || vt.numberingMethod === 'manual') return;
  const seq = parseVoucherSeq(vt, num, date, fyStartMonth);
  if (seq === null) return;
  db.run(
    `INSERT INTO voucher_counters (voucher_type_id, period_key, last_number) VALUES (:vt, :key, :seq)
     ON CONFLICT(voucher_type_id, period_key) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`,
    { vt: vt.id, key: periodKey(vt, date, fyStartMonth), seq },
  );
}

function snapRate(rate: number): number {
  for (const r of GST_RATES) if (Math.abs(r - rate) <= 0.05) return r;
  return Math.round(rate * 100) / 100;
}

/** Write one Tally voucher (inside the caller's savepoint). Returns 'created' | 'updated' | 'skipped'. */
function writeVoucher(env: VoucherEnv, v: TVoucher): 'created' | 'updated' | 'skipped' {
  const { run } = env;
  const db = run.db;
  if (!v.date) throw new SkipVoucher('bad_date', `The voucher date "${v.rawDate}" is not a valid date.`);
  const base = env.baseOf(v.vchType);
  if (!base) throw new SkipVoucher('unknown_voucher_type', `Voucher type "${v.vchType}" is not known.`);
  if (UNSUPPORTED_BASES.has(base)) throw new SkipVoucher('unsupported', 'Physical stock vouchers are not imported.', 'warning');
  const typeId = env.types.get(key(v.vchType)) ?? env.types.get(key(PREDEFINED_VOUCHER_TYPES.find((t) => t.baseType === base)?.name ?? ''));
  if (typeId === undefined) throw new SkipVoucher('unknown_voucher_type', `Voucher type "${v.vchType}" does not exist in this company.`);
  if (v.date < run.booksFrom) throw new SkipVoucher('before_books', `The voucher is dated before the books beginning date (${run.booksFrom}).`);
  if (env.lockedUpTo && v.date <= env.lockedUpTo) throw new SkipVoucher('locked', `The books are locked up to ${env.lockedUpTo}.`);

  // Duplicate: same Tally GUID, or the same number in the same voucher type and numbering period.
  // Tally allows repeated numbers (manual numbering, Receipt/Payment "1" every day), so a number match
  // against a voucher that came from Tally with ANOTHER GUID is a different voucher, not a duplicate.
  const vt = loadVoucherType(db, typeId);
  let existingId: number | undefined = v.guid ? env.guids.get(v.guid) : undefined;
  let matchedByNumber = false;
  if (existingId === undefined && v.number) {
    const { from, to } = periodRange(vt, v.date, env.company.fyStartMonth);
    const rows = db.all<{ id: number; source: unknown; tguid: unknown }>(
      `SELECT id, CASE WHEN json_valid(meta) THEN json_extract(meta, '$.source') END AS source,
              CASE WHEN json_valid(meta) THEN json_extract(meta, '$.tally.guid') END AS tguid
         FROM vouchers INDEXED BY idx_vouchers_number WHERE voucher_type_id = :t AND number = :n AND date BETWEEN :from AND :to ORDER BY id`,
      { t: typeId, n: v.number, from, to },
    );
    const same = rows.find((r) => !(v.guid && r.source === 'tally' && typeof r.tguid === 'string' && r.tguid !== '' && r.tguid !== v.guid));
    if (same) {
      existingId = same.id;
      matchedByNumber = true;
    }
  }
  let before: ReturnType<typeof snapshotFromDb> | undefined;
  if (existingId !== undefined) {
    const ex = db.get<{ source: unknown; date: string; is_cancelled: number }>(
      `SELECT CASE WHEN json_valid(meta) THEN json_extract(meta, '$.source') END AS source, date, is_cancelled FROM vouchers WHERE id = :id`,
      { id: existingId },
    );
    const fromTally = ex?.source === 'tally';
    if (!run.update) {
      if (matchedByNumber && !fromTally) {
        run.add({
          severity: 'warning',
          code: 'number_exists',
          message: `${vt.name} number ${v.number ?? ''} is already used in this period by a voucher entered in Bahi ERP; the Tally voucher was not imported. Check that it is the same transaction.`,
          object: `VOUCHER ${voucherLabel(v)}`,
        });
      }
      return 'skipped';
    }
    // "Update existing" only refreshes vouchers that came from Tally: a voucher entered (or altered
    // into shape) in this app is never overwritten by an import.
    if (!fromTally) {
      throw new SkipVoucher(
        'number_exists',
        `${vt.name} number ${v.number ?? ''} is already used in this period by a voucher entered in Bahi ERP; it was not overwritten. Alter or delete it yourself if the Tally voucher should replace it.`,
        'warning',
      );
    }
    if (ex && env.lockedUpTo && ex.date <= env.lockedUpTo) {
      throw new SkipVoucher('locked', `The voucher already imported is in the locked period (up to ${env.lockedUpTo}); it was not updated.`, 'warning');
    }
    const row = loadVoucherRow(db, existingId);
    if (row) before = snapshotFromDb(db, row, db.value<string>('SELECT name FROM voucher_types WHERE id = :id', { id: row.voucher_type_id }) ?? vt.name);
  }

  const isAccounting = ACCOUNTING_BASE_TYPES.includes(base);
  const writesEntries = isAccounting || base === 'memorandum' || base === 'reversing_journal';
  const isGstDoc = GST_BASE_TYPES.includes(base);
  const cancelled = v.isCancelled;
  const optional = v.isOptional && !cancelled;
  const affectsBooks = isAccounting && !optional && !cancelled;
  const pdc = v.isPostDated ? 1 : 0;

  // ── Ledger entries ──
  const entries: EntryRow[] = [];
  let partyId: number | null = null;
  if (!cancelled) {
    const merged = writesEntries ? mergeEntries(v.entries) : [];
    for (const e of merged) {
      const info = env.ledgers.get(key(e.ledger));
      if (!info) throw new SkipVoucher('unknown_ledger', `Ledger "${e.ledger}" does not exist.`);
      entries.push({ ledger: info, amount: e.amount, role: 'other', head: null, bills: [], costs: [], bank: e.bank, fromInventory: e.fromInventory });
      const row = entries[entries.length - 1];
      if (env.features.billWise && info.billWise && e.bills.length > 0) {
        for (const b of e.bills) {
          const days = b.creditDays ?? (b.type === 'new' ? info.creditDays : null);
          row.bills.push({ refType: b.type, name: b.type === 'on_account' ? null : (b.name ?? null), amount: b.amount, creditDays: days, dueDate: days !== null && v.date ? addDays(v.date, days) : null });
        }
        const sum = row.bills.reduce((s, b) => s + b.amount, 0);
        if (sum !== row.amount) {
          row.bills.push({ refType: 'on_account', name: null, amount: row.amount - sum, creditDays: null, dueDate: null });
          run.add({ severity: 'warning', code: 'bill_mismatch', message: `Bill allocations of "${info.name}" did not add up to the entry; the difference is kept on account.`, object: `VOUCHER ${voucherLabel(v)}` });
        }
      }
      for (const cst of e.costs) {
        const id = env.centres.get(key(cst.centre));
        if (id === undefined) {
          run.add({ severity: 'warning', code: 'unknown_cost_centre', message: `Cost centre "${cst.centre}" does not exist; its allocation was dropped.`, object: `VOUCHER ${voucherLabel(v)}` });
          continue;
        }
        row.costs.push({ centreId: id, amount: cst.amount });
      }
    }
    const total = entries.reduce((s, e) => s + e.amount, 0);
    if (writesEntries && total !== 0) {
      throw new SkipVoucher('unbalanced', `Debit and credit differ by ₹ ${(Math.abs(total) / 100).toFixed(2)} ${total > 0 ? 'Dr' : 'Cr'}.`);
    }
    // Party: PARTYLEDGERNAME, else the first customer/supplier (or cash for a cash sale).
    const named = v.party ? env.ledgers.get(key(v.party)) : undefined;
    if (named) partyId = named.id;
    else if (isGstDoc || ORDERS.has(base) || STOCK_IN.has(base) || STOCK_OUT.has(base)) {
      partyId = entries.find((e) => e.ledger.cls.isParty)?.ledger.id ?? entries.find((e) => e.ledger.cls.isCash)?.ledger.id ?? null;
    }
    for (const e of entries) {
      const c = e.ledger.cls;
      if (e.ledger.dutyHead) {
        e.role = 'tax';
        e.head = e.ledger.dutyHead;
      } else if (isGstDoc && e.ledger.id === partyId) e.role = 'party';
      else if (e.ledger.reservedCode === 'ROUND_OFF' || /^round(ing)?[ -]?off\b/i.test(e.ledger.name)) e.role = 'round_off';
      else if (c.isCashOrBank) e.role = 'cash_bank';
      else if (c.isParty) e.role = 'party';
      else if (c.isSales) e.role = 'sales';
      else if (c.isPurchase) e.role = 'purchase';
      else e.role = isGstDoc ? 'charge' : 'other';
    }
  }

  // ── Inventory ──
  const inv: InvRow[] = [];
  const movesStock = STOCK_IN.has(base) || STOCK_OUT.has(base) || base === 'stock_journal';
  if (!cancelled && v.inventory.length > 0) {
    if (!movesStock) {
      run.add({ severity: 'warning', code: 'inventory_ignored', message: `Stock lines in a ${v.vchType} voucher are not imported (only the accounting entries).`, object: `VOUCHER ${voucherLabel(v)}` });
    } else {
      for (const line of v.inventory) {
        const item = env.items.get(key(line.item));
        if (!item) throw new SkipVoucher('unknown_item', `Stock item "${line.item}" does not exist.`);
        const ledgerId = line.ledger ? (env.ledgers.get(key(line.ledger))?.id ?? null) : null;
        const outward = base === 'stock_journal' ? (line.direction ? line.direction === 'out' : line.isDeemedPositive === false) : STOCK_OUT.has(base);
        const sign = outward ? -1 : 1;
        const rateUsable = line.rate !== null && (line.rateUnit === null || key(line.rateUnit) === key(item.unit));
        const parts = line.allocations.filter((a) => a.qty !== null && a.qty !== 0);
        const shares =
          parts.length > 0
            ? (() => {
                const given = parts.map((a) => a.amount);
                const fallback = allocate(line.amount, parts.map((a) => a.qty ?? 0));
                return parts.map((a, i) => ({ alloc: a, qty: a.qty ?? 0, billed: a.billedQty, amount: given[i] ?? fallback[i] }));
              })()
            : [{ alloc: null, qty: line.qty, billed: line.billedQty, amount: line.amount }];
        for (const s of shares) {
          const godownId = s.alloc?.godown ? (env.godowns.get(key(s.alloc.godown)) ?? env.mainGodown) : env.mainGodown;
          const trackingRef = s.alloc?.trackingNo ?? null;
          const rate = rateUsable ? (line.rate as number) : s.qty !== 0 ? Math.round((s.amount / 100 / s.qty) * 1e6) / 1e6 : 0;
          const stockMoves = !ORDERS.has(base) && !optional && env.features.inventory && !item.isService && !(INVOICE_TRACKED.has(base) && trackingRef !== null);
          inv.push({
            item,
            godownId,
            batch: env.features.batches ? (s.alloc?.batch ?? null) : null,
            qty: sign * Math.abs(s.qty),
            billedQty: s.billed,
            rate,
            discountPct: line.discountPct,
            amount: Math.abs(s.amount),
            ledgerId,
            trackingRef,
            orderRef: s.alloc?.orderNo ?? null,
            isConsumption: base === 'stock_journal' && outward,
            affectsStock: stockMoves,
            hsn: null,
            gstRate: null,
          });
        }
      }
    }
  }

  // ── GST lines (as recorded: tax per head from the duty-ledger postings) ──
  const partySign = base === 'sales' || base === 'debit_note' ? 1 : -1;
  const partyInfo = partyId !== null ? env.ledgerById.get(partyId) : undefined;
  const outward = base === 'sales' || base === 'credit_note' || (base === 'debit_note' && partyInfo?.cls.isDebtor === true);
  const gstRows: GstRow[] = [];
  const heads = { IGST: 0, CGST: 0, SGST: 0, CESS: 0 };
  for (const e of entries) if (e.head) heads[e.head] += e.amount;
  for (const h of Object.keys(heads) as TallyDutyHead[]) heads[h] = Math.abs(heads[h]);
  const totalTax = heads.IGST + heads.CGST + heads.SGST + heads.CESS;
  let notes: string[] = [];
  if (isGstDoc && isAccounting && !cancelled && env.company.registration !== 'unregistered' && env.features.gst) {
    const isFixedAsset = (id: number | null): boolean => (id !== null ? env.ledgerById.get(id)?.cls.primaryCode === 'FIXED_ASSETS' : false);
    for (const r of inv) {
      const p = resolveItemTaxProfile(env.lookup, { itemId: r.item.id, date: v.date, ledgerId: r.ledgerId });
      r.hsn = p.hsnSac || null;
      r.gstRate = p.taxability === 'taxable' && !p.missing ? p.rate : null;
      gstRows.push({
        source: 'item',
        itemId: r.item.id,
        ledgerId: r.ledgerId,
        description: null,
        hsn: p.hsnSac || null,
        uqc: r.item.isService ? 'NA' : r.item.uqc,
        qty: Math.abs(r.qty),
        supply: r.item.isService || (p.hsnSac ?? '').startsWith('99') ? 'services' : 'goods',
        taxability: p.taxability,
        rate: p.missing ? -1 : p.rate,
        cessRate: p.cessRate,
        taxable: r.amount,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
        itc: outward ? null : env.company.registration !== 'regular' ? 'ineligible' : isFixedAsset(r.ledgerId) ? 'capital_goods' : r.item.isService ? 'input_services' : 'inputs',
      });
    }
    const hasItems = inv.length > 0;
    for (const e of entries) {
      if (e.role === 'party' || e.role === 'tax' || e.role === 'round_off' || e.role === 'cash_bank') continue;
      if (hasItems && e.fromInventory) continue;
      const profile = resolveLedgerTaxProfile(env.lookup, { ledgerId: e.ledger.id, date: v.date });
      if (profile.source === 'not_applicable' && !(e.role === 'sales' || e.role === 'purchase')) continue;
      gstRows.push({
        source: 'ledger',
        itemId: null,
        ledgerId: e.ledger.id,
        description: null,
        hsn: profile.hsnSac || null,
        uqc: null,
        qty: null,
        supply: profile.supplyKind,
        taxability: profile.source === 'not_applicable' ? 'non_gst' : profile.taxability,
        rate: profile.missing || profile.source === 'not_applicable' ? -1 : profile.rate,
        cessRate: profile.cessRate,
        taxable: -partySign * e.amount,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
        itc: outward ? null : env.company.registration !== 'regular' ? 'ineligible' : e.ledger.cls.primaryCode === 'FIXED_ASSETS' ? 'capital_goods' : profile.supplyKind === 'services' ? 'input_services' : 'inputs',
      });
    }
    if (gstRows.length > 0) {
      // Allocate the posted tax per head over the lines in proportion to taxable × rate.
      const known = gstRows.map((g) => (g.rate > 0 && g.taxable > 0 ? g.taxable * g.rate : 0));
      const weights = known.some((w) => w > 0) ? known : gstRows.map((g) => (g.taxable > 0 && g.taxability === 'taxable' ? g.taxable : 0));
      const split = (total: number): number[] => (total === 0 ? gstRows.map(() => 0) : allocate(total, weights));
      const ig = split(heads.IGST);
      const cg = split(heads.CGST);
      const sg = split(heads.SGST);
      const ce = split(heads.CESS);
      gstRows.forEach((g, i) => {
        g.igst = ig[i];
        g.cgst = cg[i];
        g.sgst = sg[i];
        g.cess = ce[i];
        const tax = g.igst + g.cgst + g.sgst;
        if (g.rate < 0) g.rate = g.taxable > 0 && tax > 0 ? snapRate((tax / g.taxable) * 100) : 0;
        if (tax > 0 && g.taxability !== 'taxable') g.taxability = 'taxable';
        const expected = Math.round((g.taxable * g.rate) / 100);
        if (g.taxable > 0 && Math.abs(expected - tax) > Math.max(100, expected / 100)) {
          notes.push(`tax on line ${i + 1} (₹ ${(tax / 100).toFixed(2)}) differs from ${g.rate}% of ₹ ${(g.taxable / 100).toFixed(2)}`);
        }
      });
      if (totalTax > 0 && weights.every((w) => w === 0)) notes.push('GST was posted but no taxable line was found');
    }
  }
  if (notes.length > 0) {
    run.add({ severity: 'info', code: 'gst_as_recorded', message: `Kept as recorded in Tally: ${notes.join('; ')}.`, object: `VOUCHER ${voucherLabel(v)}` });
    notes = [];
  }

  // ── Header ──
  const party = partyInfo;
  const posCode = stateCodeOrNull(v.placeOfSupply) ?? (outward ? (party?.stateCode ?? env.company.stateCode) : env.company.stateCode);
  const interState = heads.IGST > 0 ? true : heads.CGST + heads.SGST > 0 ? false : (party?.stateCode ?? env.company.stateCode) !== env.company.stateCode;
  const partyEntry = entries.find((e) => e.role === 'party' && e.ledger.id === partyId);
  const debits = entries.reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0);
  const taxable = gstRows.reduce((s, g) => s + g.taxable, 0);
  const roundOff = entries.filter((e) => e.role === 'round_off').reduce((s, e) => s - partySign * e.amount, 0);
  const invValueRows = inv.reduce((s, r) => s + r.amount, 0);
  const total = cancelled ? 0 : isGstDoc && partyEntry ? Math.abs(partyEntry.amount) : writesEntries ? debits : invValueRows;
  const regParty = (v.partyGstin ?? party?.gstin) ? ((party?.registrationType as RegistrationType | null) ?? 'regular') : ((party?.registrationType as RegistrationType | null) ?? 'unregistered');
  const gstNature =
    gstRows.length > 0
      ? classifySupply(
          { direction: outward ? 'outward' : 'inward', companyRegistration: env.company.registration, partyRegistration: regParty, interState, b2clThresholdPaise: env.b2clThreshold },
          { invoiceValue: total, allNonTaxable: gstRows.every((g) => g.taxability !== 'taxable'), goodsValue: gstRows.filter((g) => g.supply === 'goods').reduce((s, g) => s + g.taxable, 0), servicesValue: gstRows.filter((g) => g.supply === 'services').reduce((s, g) => s + g.taxable, 0) },
        )
      : null;
  const invoiceMode = isGstDoc && isAccounting ? (inv.length > 0 ? 'item' : gstRows.length > 0 || v.isInvoice ? 'accounting' : null) : null;
  const affectsStock = inv.some((r) => r.affectsStock) ? 1 : 0;

  const input = buildInput(env, v, { typeId, base, partyId, entries, inv, partySign, posCode });
  const meta = {
    v: 1,
    source: 'tally',
    importBatchId: env.batchId,
    tally: { guid: v.guid, remoteId: v.remoteId, voucherType: v.vchType, isInvoice: v.isInvoice },
    input,
    createdByName: env.userName,
    updatedByName: env.userName,
    ...(cancelled ? { cancelled: { reason: 'Cancelled in Tally', at: env.now, by: run.ctx.session.userId, byName: env.userName, snapshot: null } } : {}),
  };

  const header = {
    voucher_type_id: typeId,
    base_type: base,
    number: v.number,
    number_seq: numberSeq(db, typeId, v.number, v.date ?? undefined, env.company.fyStartMonth),
    date: v.date,
    reference_no: v.reference,
    reference_date: v.referenceDate,
    party_ledger_id: partyId,
    party_name: party ? party.name : null,
    party_address: party?.address ?? null,
    party_state_code: party?.stateCode ?? null,
    party_gstin: v.partyGstin ?? party?.gstin ?? null,
    party_registration_type: party?.registrationType ?? null,
    party_pincode: party?.pincode ?? null,
    place_of_supply: gstRows.length > 0 ? posCode : null,
    invoice_mode: invoiceMode,
    is_optional: optional ? 1 : 0,
    is_post_dated: pdc,
    is_cancelled: cancelled ? 1 : 0,
    affects_books: affectsBooks ? 1 : 0,
    affects_stock: affectsStock,
    is_reverse_charge: 0,
    narration: v.narration,
    total_amount: total,
    taxable_amount: cancelled ? 0 : taxable,
    tax_amount: cancelled ? 0 : totalTax,
    round_off: cancelled ? 0 : roundOff,
    gst_nature: cancelled ? null : gstNature,
    meta: JSON.stringify(meta),
    updated_by: run.ctx.session.userId,
    updated_at: env.now,
  };
  const cols = Object.keys(header) as Array<keyof typeof header>;
  let id: number;
  if (existingId !== undefined) {
    id = existingId;
    for (const t of ['bill_allocations', 'cost_allocations', 'ledger_entries', 'inventory_entries', 'gst_lines'] as const) db.run(`DELETE FROM ${t} WHERE voucher_id = :id`, { id });
    db.run(`UPDATE vouchers SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`, { ...header, id });
  } else {
    const all = { ...header, guid: randomUUID(), created_by: run.ctx.session.userId, created_at: env.now };
    const names = Object.keys(all);
    id = db.run(`INSERT INTO vouchers (${names.join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')})`, all).lastInsertRowid;
  }
  if (v.guid) env.lastWritten = { guid: v.guid, id };
  advanceCounter(db, vt, v.number, v.date, env.company.fyStartMonth);

  const books = affectsBooks ? 1 : 0;
  entries.forEach((e, i) => {
    const bankLedger = e.ledger.cls.isCashOrBank && e.bank !== null;
    const entryId = db.run(
      `INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, role, gst_duty_head, narration, instrument_type, instrument_no,
              instrument_date, bank_name, favouring, bank_date, date, affects_books, is_post_dated)
       VALUES (:id, :line, :ledger, :amount, :role, :head, NULL, :iType, :iNo, :iDate, :iBank, :iFav, :bankDate, :date, :books, :pdc)`,
      {
        id,
        line: i + 1,
        ledger: e.ledger.id,
        amount: e.amount,
        role: e.role,
        head: e.head,
        iType: bankLedger ? instrumentType(e.bank?.type ?? null) : null,
        iNo: bankLedger ? (e.bank?.number ?? null) : null,
        iDate: bankLedger ? (e.bank?.date ?? null) : null,
        iBank: bankLedger ? (e.bank?.bankName ?? null) : null,
        iFav: bankLedger ? (e.bank?.favouring ?? null) : null,
        bankDate: bankLedger && e.ledger.cls.isBank ? (e.bank?.bankDate ?? null) : null,
        date: v.date,
        books,
        pdc,
      },
    ).lastInsertRowid;
    for (const b of e.bills) {
      db.run(
        `INSERT INTO bill_allocations (voucher_id, ledger_entry_id, ledger_id, ref_type, bill_name, amount, credit_days, due_date, date, affects_books, is_post_dated)
         VALUES (:id, :entryId, :ledger, :refType, :name, :amount, :days, :due, :date, :books, :pdc)`,
        { id, entryId, ledger: e.ledger.id, refType: b.refType, name: b.name, amount: b.amount, days: b.creditDays, due: b.dueDate, date: v.date, books, pdc },
      );
    }
    for (const cst of e.costs) {
      db.run(
        `INSERT INTO cost_allocations (voucher_id, ledger_entry_id, ledger_id, cost_centre_id, amount, date, affects_books, is_post_dated)
         VALUES (:id, :entryId, :ledger, :centre, :amount, :date, :books, :pdc)`,
        { id, entryId, ledger: e.ledger.id, centre: cst.centreId, amount: cst.amount, date: v.date, books, pdc },
      );
    }
  });
  inv.forEach((r, i) => {
    db.run(
      `INSERT INTO inventory_entries (voucher_id, line_no, item_id, godown_id, batch_name, qty, billed_qty, rate, discount_pct, amount, ledger_id,
              hsn_sac, gst_rate, tracking_ref, order_ref, is_consumption, date, affects_stock, is_post_dated)
       VALUES (:id, :line, :item, :godown, :batch, :qty, :billed, :rate, :disc, :amount, :ledger, :hsn, :gstRate, :track, :order, :cons, :date, :stock, :pdc)`,
      {
        id,
        line: i + 1,
        item: r.item.id,
        godown: r.godownId,
        batch: r.batch,
        qty: r.qty,
        billed: r.billedQty,
        rate: r.rate,
        disc: r.discountPct,
        amount: r.amount,
        ledger: r.ledgerId,
        hsn: r.hsn,
        gstRate: r.gstRate,
        track: r.trackingRef,
        order: r.orderRef,
        cons: r.isConsumption ? 1 : 0,
        date: v.date,
        stock: r.affectsStock ? 1 : 0,
        pdc,
      },
    );
  });
  gstRows.forEach((g, i) => {
    db.run(
      `INSERT INTO gst_lines (voucher_id, line_no, source, item_id, ledger_id, description, hsn_sac, uqc, qty, supply_type, taxability, rate, cess_rate,
              taxable_value, igst, cgst, sgst, cess, is_reverse_charge, itc_eligibility, date, affects_books, is_post_dated)
       VALUES (:id, :line, :source, :item, :ledger, :description, :hsn, :uqc, :qty, :supply, :taxability, :rate, :cessRate, :taxable, :igst, :cgst, :sgst,
              :cess, 0, :itc, :date, :books, :pdc)`,
      {
        id,
        line: i + 1,
        source: g.source,
        item: g.itemId,
        ledger: g.ledgerId,
        description: g.description,
        hsn: g.hsn,
        uqc: g.uqc,
        qty: g.qty,
        supply: g.supply,
        taxability: g.taxability,
        rate: g.rate,
        cessRate: g.cessRate,
        taxable: g.taxable,
        igst: g.igst,
        cgst: g.cgst,
        sgst: g.sgst,
        cess: g.cess,
        itc: g.itc,
        date: v.date,
        books,
        pdc,
      },
    );
  });
  // One edit-log entry per voucher, in the same shape as a voucher saved on screen (vouchers/service.ts),
  // so the voucher's history shows the import (and, on "update", the amounts before and after).
  const saved = loadVoucherRow(db, id);
  if (saved) {
    run.ctx.audit({
      action: existingId !== undefined ? 'alter' : 'create',
      entityType: 'voucher',
      entityId: id,
      entityGuid: saved.guid,
      entityLabel: `${vt.name} ${v.number ?? '(no number)'} dated ${formatDate(v.date)}`,
      before,
      after: { ...snapshotFromDb(db, saved, vt.name), source: 'tally', importBatchId: env.batchId, tallyGuid: v.guid ?? null },
    });
  }
  return existingId !== undefined ? 'updated' : 'created';
}

/** Best-effort VoucherInput stored in meta.input, so an imported voucher can be opened and altered. */
function buildInput(
  env: VoucherEnv,
  v: TVoucher,
  x: { typeId: number; base: VoucherBaseType; partyId: number | null; entries: EntryRow[]; inv: InvRow[]; partySign: number; posCode: string | null },
): VoucherInput {
  const common: Omit<VoucherInput, 'mode'> = {
    voucherTypeId: x.typeId,
    date: v.date as string,
    ...(v.number ? { number: v.number } : {}),
    ...(v.reference ? { referenceNo: v.reference } : {}),
    ...(v.referenceDate ? { referenceDate: v.referenceDate } : {}),
    ...(v.narration ? { narration: v.narration } : {}),
    ...(v.isOptional ? { isOptional: true } : {}),
    ...(v.isPostDated ? { isPostDated: true } : {}),
  };
  const bills = (e: EntryRow): BillAllocationInput[] | undefined =>
    e.bills.length
      ? e.bills.map((b) => ({ refType: b.refType, ...(b.name ? { billName: b.name } : {}), amount: Math.abs(b.amount), ...(b.creditDays !== null ? { creditDays: b.creditDays } : {}) }))
      : undefined;
  const items = (): ItemLineInput[] =>
    x.inv.map((r) => ({
      itemId: r.item.id,
      godownId: r.godownId,
      ...(r.batch ? { batchName: r.batch } : {}),
      qty: Math.abs(r.qty),
      ...(r.billedQty !== null && r.billedQty !== Math.abs(r.qty) ? { billedQty: r.billedQty } : {}),
      rate: r.rate,
      ...(r.discountPct ? { discountPct: r.discountPct } : {}),
      amount: r.amount,
      ...(r.ledgerId !== null ? { ledgerId: r.ledgerId } : {}),
      ...(r.trackingRef ? { trackingRef: r.trackingRef } : {}),
      ...(r.orderRef ? { orderRef: r.orderRef } : {}),
      ...(r.isConsumption ? { isConsumption: true } : {}),
    }));
  const isGstDoc = GST_BASE_TYPES.includes(x.base);
  const isAccounting = ACCOUNTING_BASE_TYPES.includes(x.base);
  if (isGstDoc && x.partyId !== null && (x.inv.length > 0 || x.entries.some((e) => e.role === 'tax'))) {
    const mode: VoucherMode = x.inv.length > 0 ? 'item_invoice' : 'accounting_invoice';
    const ledgers: LedgerLineInput[] = x.entries
      .filter((e) => e.role !== 'party' && e.role !== 'tax' && e.role !== 'round_off' && !(mode === 'item_invoice' && e.fromInventory))
      .map((e) => ({ ledgerId: e.ledger.id, amount: -x.partySign * e.amount }));
    const partyEntry = x.entries.find((e) => e.role === 'party' && e.ledger.id === x.partyId);
    const partyBills = partyEntry ? bills(partyEntry) : undefined;
    return {
      ...common,
      mode,
      partyLedgerId: x.partyId,
      ...(x.posCode ? { placeOfSupply: x.posCode } : {}),
      ...(mode === 'item_invoice' ? { items: items() } : {}),
      ...(ledgers.length ? { ledgers } : {}),
      ...(partyBills ? { partyBillAllocations: partyBills } : {}),
    };
  }
  if (!isAccounting && x.base !== 'memorandum' && x.base !== 'reversing_journal') {
    return { ...common, mode: x.base === 'stock_journal' ? 'inventory' : 'item_invoice', ...(x.partyId !== null ? { partyLedgerId: x.partyId } : {}), items: items() };
  }
  return {
    ...common,
    mode: 'ledger',
    ...(x.partyId !== null ? { partyLedgerId: x.partyId } : {}),
    ledgers: x.entries.map((e) => {
      const line: LedgerLineInput = { ledgerId: e.ledger.id, amount: e.amount };
      const b = bills(e);
      if (b) line.billAllocations = b;
      if (e.costs.length) line.costAllocations = e.costs.map((c) => ({ costCentreId: c.centreId, amount: Math.abs(c.amount) }));
      if (e.bank && e.ledger.cls.isCashOrBank && (e.bank.number || e.bank.type)) {
        line.instrument = { type: instrumentType(e.bank.type), ...(e.bank.number ? { number: e.bank.number } : {}), ...(e.bank.date ? { date: e.bank.date } : {}) };
      }
      return line;
    }),
  };
}

// ───────────────────────────── Import entry point ─────────────────────────────

const RUNNING = new Set<string>();

export async function importTally(ctx: CompanyCtx, input: TallyImportInput): Promise<TallyImportResult> {
  requirePermission(ctx, 'data.import');
  const opts = input.options;
  const doMasters = opts.masters !== false;
  if (!doMasters && !opts.vouchers) throw validation([{ path: 'options', message: 'Choose masters, vouchers or both to import' }]);
  if (doMasters && !hasPermission(ctx, 'masters.create')) throw new AppError('FORBIDDEN', 'You need permission to create masters to import them from Tally.');
  if (opts.vouchers && !hasPermission(ctx, 'vouchers.create')) throw new AppError('FORBIDDEN', 'You need permission to create vouchers to import them from Tally.');
  // Same rights as entering the data by hand: migrated vouchers are back-dated, and "update" alters.
  if (opts.vouchers && !hasPermission(ctx, 'vouchers.backdate')) {
    throw new AppError('FORBIDDEN', 'Vouchers from Tally are dated in the past. You need permission to enter back-dated vouchers ("vouchers.backdate") to import them.');
  }
  if (opts.onDuplicate === 'update') {
    if (doMasters && !hasPermission(ctx, 'masters.alter')) throw new AppError('FORBIDDEN', 'You need permission to alter masters to update existing ones from Tally. Choose "Skip" for existing records, or ask the owner.');
    if (opts.vouchers && !hasPermission(ctx, 'vouchers.alter')) throw new AppError('FORBIDDEN', 'You need permission to alter vouchers to update existing ones from Tally. Choose "Skip" for existing records, or ask the owner.');
  }
  if (opts.from && opts.to && opts.to < opts.from) throw validation([{ path: 'options.to', message: 'The end date is before the start date' }]);
  const lockKey = ctx.company.dbPath + '|' + ctx.company.id;
  if (RUNNING.has(lockKey)) throw new AppError('CONFLICT', 'A Tally import is already running for this company. Wait for it to finish.');
  RUNNING.add(lockKey);
  const started = Date.now();
  const issues: TallyIssue[] = [];
  const add = issueSink(issues);
  let openBatch: number | null = null;
  try {
    setProgress(ctx, { running: true, phase: 'parse', done: 0, total: 0, message: 'Reading the Tally file…' });
    await yieldToEventLoop();
    const file = parseTallyFile(input.bytes);
    for (const i of file.issues) add(i);
    const db = ctx.db;
    const booksFrom = db.value<string>('SELECT books_from FROM company WHERE id = 1') as string;
    const run: Run = {
      ctx,
      db,
      file,
      update: opts.onDuplicate === 'update',
      add,
      masters: {
        groups: zero(),
        ledgers: zero(),
        costCategories: zero(),
        costCentres: zero(),
        units: zero(),
        godowns: zero(),
        stockGroups: zero(),
        stockCategories: zero(),
        stockItems: zero(),
        voucherTypes: zero(),
      },
      groupIds: new Map(),
      ledgerIds: new Map(),
      booksFrom,
    };
    const now = ctx.clock.now().toISOString();
    const batchId = db.transaction(() =>
      db.run('INSERT INTO import_batches (kind, file_name, imported_at, user_id, meta) VALUES (:kind, :file, :ts, :user, :meta)', {
        kind: 'tally_xml',
        file: input.fileName.slice(0, 255),
        ts: now,
        user: ctx.session.userId,
        meta: JSON.stringify({ status: 'running' }),
      }).lastInsertRowid,
    );
    openBatch = batchId;
    const baseOf = baseTypeResolver(db, file);
    if (doMasters) {
      setProgress(ctx, { running: true, phase: 'masters', done: 0, total: 0, message: 'Creating groups, ledgers and stock items…' });
      await yieldToEventLoop();
      db.transaction(() => importMasters(run, baseOf));
    }

    const counts = zero();
    let stopped = false;
    if (opts.vouchers) {
      const list = file.vouchers.filter((v) => (!opts.from || (v.date !== null && v.date >= opts.from)) && (!opts.to || (v.date !== null && v.date <= opts.to)));
      // Oldest first, so bills created by earlier vouchers exist when later ones settle them.
      list.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
      const company = db.get<{ state_code: string | null; gst_registration_type: 'regular' | 'composition' | 'unregistered'; fy_start_month: number }>(
        'SELECT state_code, gst_registration_type, fy_start_month FROM company WHERE id = 1',
      );
      const config = getConfig(db);
      const loaded = loadLedgers(db);
      const env: VoucherEnv = {
        run,
        baseOf: baseTypeResolver(db, file),
        ledgers: loaded.byName,
        ledgerById: loaded.byId,
        items: loadItems(db),
        godowns: nameIndex(db, 'godowns'),
        centres: nameIndex(db, 'cost_centres'),
        types: new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM voucher_types').map((r) => [key(r.name), r.id])),
        mainGodown: mainGodownId(db),
        lookup: dbTaxLookup(db),
        company: { stateCode: company?.state_code ?? null, registration: company?.gst_registration_type ?? 'regular', fyStartMonth: company?.fy_start_month ?? 4 },
        features: getFeatures(db),
        lockedUpTo: config.lockedUpTo ?? null,
        b2clThreshold: config.gst.b2clThresholdPaise,
        batchId,
        now,
        userName: ctx.session.displayName || ctx.session.username || null,
        counts,
        guids: loadTallyGuids(db),
        lastWritten: null,
      };
      for (let start = 0; start < list.length; start += CHUNK) {
        setProgress(ctx, { running: true, phase: 'vouchers', done: start, total: list.length, message: `Importing vouchers ${start + 1}–${Math.min(start + CHUNK, list.length)} of ${list.length}…` });
        await yieldToEventLoop();
        try {
          db.transaction(() => {
            for (const v of list.slice(start, start + CHUNK)) {
              try {
                env.lastWritten = null;
                const out = db.transaction(() => writeVoucher(env, v));
                counts[out]++;
                // A failed chunk stops the import, so ids recorded here never outlive a rollback that continues.
                const w = env.lastWritten as VoucherEnv['lastWritten'];
                if (w) env.guids.set(w.guid, w.id);
              } catch (err) {
                counts.failed++;
                if (err instanceof SkipVoucher) {
                  if (err.severity === 'warning') {
                    counts.failed--;
                    counts.skipped++;
                  }
                  add({ severity: err.severity, code: err.code, message: err.message, object: `VOUCHER ${voucherLabel(v)}` });
                } else {
                  add({ severity: 'error', code: 'voucher_failed', message: messageOf(err), object: `VOUCHER ${voucherLabel(v)}` });
                }
              }
            }
          });
        } catch (err) {
          stopped = true;
          ctx.app.log('error', 'Tally import stopped', { error: err });
          add({ severity: 'error', code: 'stopped', message: `The import stopped at voucher ${start + 1}: ${err instanceof Error ? err.message : 'unexpected error'}. Vouchers before it were imported.` });
          break;
        }
      }
    }

    const result: TallyImportResult = { masters: run.masters, vouchers: counts, issues, batchId, stopped, durationMs: Date.now() - started };
    const summary = {
      file: input.fileName,
      tallyCompany: file.companyName,
      masters: Object.fromEntries(Object.entries(run.masters).map(([k, c]) => [k, c.created + c.updated])),
      vouchers: counts,
      errors: issues.filter((i) => i.severity === 'error').length,
      stopped,
    };
    db.transaction(() => {
      db.run('UPDATE import_batches SET meta = :meta WHERE id = :id', { id: batchId, meta: JSON.stringify({ status: stopped ? 'stopped' : 'done', ...summary }) });
      ctx.audit({ action: 'import', entityType: 'import_batch', entityId: batchId, entityLabel: `Tally data from ${input.fileName}`.slice(0, 300), after: summary });
    });
    setProgress(ctx, { running: false, phase: stopped ? 'failed' : 'done', done: counts.created + counts.updated, total: file.vouchers.length, message: stopped ? 'The import stopped early.' : 'Import finished.' });
    return result;
  } catch (err) {
    setProgress(ctx, { running: false, phase: 'failed', done: 0, total: 0, message: err instanceof AppError ? err.message : 'The import failed.' });
    if (openBatch !== null) {
      // Leave no batch marked 'running' behind (the masters transaction rolled back as a whole).
      const id = openBatch;
      try {
        ctx.db.transaction(() =>
          ctx.db.run('UPDATE import_batches SET meta = :meta WHERE id = :id', { id, meta: JSON.stringify({ status: 'failed', file: input.fileName, error: err instanceof Error ? err.message : String(err) }) }),
        );
      } catch {
        /* the original error matters more */
      }
    }
    throw err;
  } finally {
    RUNNING.delete(lockKey);
  }
}

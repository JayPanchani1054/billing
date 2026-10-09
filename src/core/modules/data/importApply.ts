/**
 * Per-kind import of one record (one row, or several grouped rows) through the masters and voucher
 * services, so imported data passes exactly the same validation as data entered on screen.
 * Every applier runs inside a SAVEPOINT owned by the caller (importer.ts): throwing rolls the record back.
 */
import type { GroupNature } from '../../../shared/constants.ts';
import { GST_RATES, findState, isKnownStateCode, normalizeStateCode } from '../../../shared/gst/index.ts';
import type { GroupSaveInput, LedgerSaveInput, OpeningBillInput } from '../../../shared/types/accounts.ts';
import type { ImportOptions } from '../../../shared/types/data.ts';
import type { RegistrationType, Taxability } from '../../../shared/types/gst.ts';
import type { CostingMethod, StockItemSaveInput, StockOpeningInput } from '../../../shared/types/inventory.ts';
import type { BillAllocationInput, ItemLineInput, LedgerLineInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError } from '../../lib/errors.ts';
import { loadGroupTree } from '../accounts/books.ts';
import { saveCostCategory, saveCostCentre } from '../accounts/costCentres.ts';
import { saveGroup } from '../accounts/groups.ts';
import { saveLedger } from '../accounts/ledgers.ts';
import { saveGodown, saveStockCategory, saveStockGroup } from '../inventory/masters.ts';
import { saveItem } from '../inventory/items.ts';
import { compoundSymbol, saveUnit } from '../inventory/units.ts';
import { mainGodownId } from '../inventory/index.ts';
import { loadVoucherType, periodRange } from '../vouchers/numbering.ts';
import { saveVoucher } from '../vouchers/service.ts';
import type { ImportKind } from '../../../shared/types/data.ts';

export type Typed = string | number | boolean | null;

export interface ParsedRow {
  rowNumber: number;
  values: Record<string, Typed>;
}

export interface ImportRecord {
  key: string;
  rows: ParsedRow[];
}

export interface ApplyOutcome {
  action: 'create' | 'update' | 'skip';
  status: 'ok' | 'warning' | 'duplicate';
  messages: string[];
}

export interface ApplyOptions extends ImportOptions {
  /** Preview run (everything is rolled back afterwards). */
  dryRun: boolean;
}

type Applier = (ctx: CompanyCtx, rec: ImportRecord, opts: ApplyOptions) => ApplyOutcome;

// ───────────────────────────── Value helpers ─────────────────────────────

export const fail = (message: string): never => {
  throw new AppError('VALIDATION', message);
};

const str = (row: ParsedRow, key: string): string | undefined => {
  const v = row.values[key];
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};
const num = (row: ParsedRow, key: string): number | undefined => {
  const v = row.values[key];
  return typeof v === 'number' ? v : undefined;
};
const bool = (row: ParsedRow, key: string): boolean | undefined => {
  const v = row.values[key];
  return typeof v === 'boolean' ? v : undefined;
};
const first = <T>(rows: ParsedRow[], get: (r: ParsedRow) => T | undefined): T | undefined => {
  for (const r of rows) {
    const v = get(r);
    if (v !== undefined) return v;
  }
  return undefined;
};

/** Id of a named master (name or alias, case-insensitive). Table names are constants, never user input. */
export function findByName(db: Db, table: 'groups' | 'ledgers' | 'stock_items' | 'stock_groups' | 'stock_categories' | 'godowns' | 'cost_centres', name: string): number | null {
  const id = db.value<number>(`SELECT id FROM ${table} WHERE name = :n COLLATE NOCASE ORDER BY id LIMIT 1`, { n: name.trim() });
  if (id !== undefined) return id;
  const byAlias = db.value<number>(`SELECT id FROM ${table} WHERE alias = :n COLLATE NOCASE ORDER BY id LIMIT 1`, { n: name.trim() });
  return byAlias ?? null;
}

const isPrimary = (s: string | undefined): boolean => s === undefined || /^primary$/i.test(s.trim());

function groupId(db: Db, name: string): number {
  const id = findByName(db, 'groups', name);
  if (id === null) fail(`Group "${name}" does not exist. Create it first (or check the spelling).`);
  return id as number;
}

function ledgerId(db: Db, name: string, what = 'Ledger'): number {
  const id = findByName(db, 'ledgers', name);
  if (id === null) fail(`${what} "${name}" does not exist. Create the ledger first (or check the spelling).`);
  return id as number;
}

function itemId(db: Db, name: string): number {
  const id = findByName(db, 'stock_items', name);
  if (id === null) fail(`Stock item "${name}" does not exist. Import or create the item first.`);
  return id as number;
}

function godownId(db: Db, name: string | undefined): number | undefined {
  if (name === undefined) return undefined;
  const id = findByName(db, 'godowns', name);
  if (id === null) fail(`Godown "${name}" does not exist.`);
  return id as number;
}

function unitId(db: Db, symbol: string): number {
  const id = db.value<number>('SELECT id FROM units WHERE symbol = :s COLLATE NOCASE OR formal_name = :s COLLATE NOCASE ORDER BY is_compound, id LIMIT 1', {
    s: symbol.trim(),
  });
  if (id === undefined) fail(`Unit "${symbol}" does not exist. Import or create the unit first.`);
  return id as number;
}

function voucherTypeId(db: Db, name: string, allowed: readonly string[], kindLabel: string): number {
  const row = db.get<{ id: number; base_type: string; is_active: number }>(
    'SELECT id, base_type, is_active FROM voucher_types WHERE name = :n COLLATE NOCASE OR abbreviation = :n COLLATE NOCASE ORDER BY is_predefined DESC, id LIMIT 1',
    { n: name.trim() },
  );
  if (!row) fail(`Voucher type "${name}" does not exist.`);
  const r = row as { id: number; base_type: string; is_active: number };
  if (!allowed.includes(r.base_type)) fail(`Voucher type "${name}" cannot be used for ${kindLabel}.`);
  return r.id;
}

export function stateCodeOf(text: string): string {
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) {
    const code = normalizeStateCode(t);
    if (isKnownStateCode(code)) return code;
  }
  const st = findState(t);
  if (!st) fail(`State "${text}" is not a known Indian state or GST state code.`);
  return (st as { code: string }).code;
}

const REGISTRATION_MAP: Record<string, RegistrationType> = {
  regular: 'regular',
  composition: 'composition',
  unregistered: 'unregistered',
  consumer: 'consumer',
  sez: 'sez',
  overseas: 'overseas',
  'deemed export': 'deemed_export',
  uin: 'uin',
};
const TAXABILITY_MAP: Record<string, Taxability> = { taxable: 'taxable', exempt: 'exempt', 'nil rated': 'nil_rated', 'non-gst': 'non_gst' };
const COSTING_MAP: Record<string, CostingMethod> = {
  'average cost': 'avg_cost',
  fifo: 'fifo',
  lifo: 'lifo',
  'last purchase cost': 'last_purchase',
  'standard cost': 'std_cost',
};
const BILL_TYPE_MAP: Record<string, BillAllocationInput['refType']> = { 'new ref': 'new', 'agst ref': 'against', advance: 'advance', 'on account': 'on_account' };

const choice = <T>(map: Record<string, T>, v: string | undefined): T | undefined => (v === undefined ? undefined : map[v.toLowerCase()]);

/** GST rate typed as 18 or as an Excel percentage (0.18). */
export function normaliseGstRate(v: number): number {
  if (GST_RATES.includes(v)) return v;
  const scaled = Math.round(v * 100 * 1e6) / 1e6;
  return v > 0 && v < 1 && GST_RATES.includes(scaled) ? scaled : v;
}

/** Signed opening amount: explicit Dr/Cr, else a negative amount is Cr, else the natural side of the group. */
function signedOpening(db: Db, amount: number, drcr: string | undefined, gid: number | null, messages: string[], what: string): number {
  if (amount === 0) return 0;
  if (drcr === 'Dr') return Math.abs(amount);
  if (drcr === 'Cr') return -Math.abs(amount);
  if (amount < 0) return amount;
  if (gid === null) return amount;
  const nature = loadGroupTree(db).byId.get(gid)?.nature as GroupNature | undefined;
  if (nature === 'liabilities' || nature === 'income') {
    messages.push(`${what}: Dr/Cr not given — taken as Cr (the usual side for this group).`);
    return -amount;
  }
  return amount;
}

// ───────────────────────────── Masters ─────────────────────────────

const duplicate = (messages: string[], what: string): ApplyOutcome => ({
  action: 'skip',
  status: 'duplicate',
  messages: [...messages, `${what} already exists — skipped (turn on "Update existing" to change it).`],
});

const applyGroup: Applier = (ctx, rec, opts) => {
  const row = rec.rows[0];
  const name = str(row, 'name') ?? fail('Name is required');
  const parentName = str(row, 'parent');
  const existing = findByName(ctx.db, 'groups', name as string);
  const parentId = isPrimary(parentName) ? null : groupId(ctx.db, parentName as string);
  const natureText = str(row, 'nature')?.toLowerCase();
  const input: GroupSaveInput = { name: name as string, alias: str(row, 'alias'), affectsGrossProfit: bool(row, 'affectsGrossProfit') };
  if (natureText) input.nature = natureText as GroupNature;
  if (existing !== null) {
    const predefined = ctx.db.value<number>('SELECT is_predefined FROM groups WHERE id = :id', { id: existing }) === 1;
    if (predefined || !opts.updateExisting) return duplicate([], `Group "${name as string}"`);
    saveGroup(ctx, { id: existing, alias: input.alias, parentId: parentName === undefined ? undefined : parentId });
    return { action: 'update', status: 'ok', messages: ['Already exists — updated.'] };
  }
  if (parentId === null && !input.nature) fail('Nature is required for a primary group (Assets, Liabilities, Income or Expenses).');
  saveGroup(ctx, { ...input, parentId });
  return { action: 'create', status: 'ok', messages: [] };
};

function ledgerFields(ctx: CompanyCtx, row: ParsedRow, gid: number | null, messages: string[]): LedgerSaveInput {
  const db = ctx.db;
  const input: LedgerSaveInput = {};
  const set = <K extends keyof LedgerSaveInput>(k: K, v: LedgerSaveInput[K] | undefined): void => {
    if (v !== undefined) input[k] = v;
  };
  set('alias', str(row, 'alias'));
  const ob = num(row, 'openingBalance');
  if (ob !== undefined) input.openingBalance = signedOpening(db, ob, str(row, 'openingDrCr'), gid, messages, 'Opening balance');
  set('billWise', bool(row, 'billWise'));
  set('defaultCreditDays', num(row, 'creditDays'));
  const limit = num(row, 'creditLimit');
  if (limit !== undefined) input.creditLimit = Math.abs(limit);
  set('gstin', str(row, 'gstin')?.toUpperCase().replace(/\s+/g, ''));
  set('registrationType', choice(REGISTRATION_MAP, str(row, 'registrationType')));
  const state = str(row, 'state');
  if (state !== undefined) input.stateCode = stateCodeOf(state);
  set('address', str(row, 'address'));
  set('pincode', str(row, 'pincode'));
  set('pan', str(row, 'pan')?.toUpperCase());
  set('contactPerson', str(row, 'contactPerson'));
  set('phone', str(row, 'phone'));
  set('mobile', str(row, 'mobile'));
  set('email', str(row, 'email'));
  set('bankAccountNo', str(row, 'bankAccountNo'));
  set('bankIfsc', str(row, 'bankIfsc')?.toUpperCase());
  set('bankName', str(row, 'bankName'));
  set('bankBranch', str(row, 'bankBranch'));
  set('hsnSac', str(row, 'hsnSac'));
  const rate = num(row, 'gstRate');
  if (rate !== undefined) input.gstRate = normaliseGstRate(rate);
  set('gstTaxability', choice(TAXABILITY_MAP, str(row, 'taxability')));
  const supply = str(row, 'supplyType')?.toLowerCase();
  if (supply === 'goods' || supply === 'services') input.gstSupplyType = supply;
  const gstApplicable = bool(row, 'gstApplicable');
  if (gstApplicable !== undefined) input.gstApplicable = gstApplicable;
  else if (rate !== undefined || input.gstTaxability !== undefined) input.gstApplicable = true;
  const taxType = str(row, 'taxType')?.toUpperCase();
  if (taxType === 'GST' || taxType === 'TDS' || taxType === 'TCS' || taxType === 'OTHER') input.taxType = taxType;
  const head = str(row, 'dutyHead')?.toUpperCase();
  if (head === 'IGST' || head === 'CGST' || head === 'SGST' || head === 'CESS') {
    input.gstDutyHead = head;
    if (!input.taxType) input.taxType = 'GST';
  }
  set('isActive', bool(row, 'active'));
  return input;
}

const applyLedger: Applier = (ctx, rec, opts) => {
  const row = rec.rows[0];
  const name = str(row, 'name') ?? fail('Name is required');
  const parentName = str(row, 'parent');
  const existing = findByName(ctx.db, 'ledgers', name as string);
  const messages: string[] = [];
  if (existing !== null) {
    if (!opts.updateExisting) return duplicate(messages, `Ledger "${name as string}"`);
    const reserved = ctx.db.value<string>('SELECT reserved_code FROM ledgers WHERE id = :id', { id: existing }) ?? null;
    const gid = parentName && !reserved ? groupId(ctx.db, parentName) : null;
    const fields = ledgerFields(ctx, row, gid ?? ctx.db.value<number>('SELECT group_id FROM ledgers WHERE id = :id', { id: existing }) ?? null, messages);
    saveLedger(ctx, { ...fields, id: existing, ...(gid !== null ? { groupId: gid } : {}) });
    return { action: 'update', status: messages.length ? 'warning' : 'ok', messages: [...messages, 'Already exists — updated.'] };
  }
  if (!parentName) fail('Under (the ledger’s group) is required.');
  const gid = groupId(ctx.db, parentName as string);
  saveLedger(ctx, { ...ledgerFields(ctx, row, gid, messages), name: name as string, groupId: gid });
  return { action: 'create', status: messages.length ? 'warning' : 'ok', messages };
};

function gstFieldsFor(row: ParsedRow): Pick<StockItemSaveInput, 'hsnSac' | 'gstRate' | 'taxability' | 'gstApplicable' | 'cessRate'> {
  const out: Pick<StockItemSaveInput, 'hsnSac' | 'gstRate' | 'taxability' | 'gstApplicable' | 'cessRate'> = {};
  const hsn = str(row, 'hsnSac');
  if (hsn !== undefined) out.hsnSac = hsn;
  const rate = num(row, 'gstRate');
  if (rate !== undefined) out.gstRate = normaliseGstRate(rate);
  const tax = choice(TAXABILITY_MAP, str(row, 'taxability'));
  if (tax !== undefined) out.taxability = tax;
  const cess = num(row, 'cessRate');
  if (cess !== undefined) out.cessRate = cess;
  if (rate !== undefined || (tax !== undefined && tax !== 'taxable')) out.gstApplicable = true;
  return out;
}

const applyStockGroup: Applier = (ctx, rec, opts) => {
  const row = rec.rows[0];
  const name = (str(row, 'name') ?? fail('Name is required')) as string;
  const parentName = str(row, 'parent');
  let parentId: number | null = null;
  if (!isPrimary(parentName)) {
    parentId = findByName(ctx.db, 'stock_groups', parentName as string);
    if (parentId === null) fail(`Stock group "${parentName as string}" does not exist. List it before its sub-groups.`);
  }
  const existing = findByName(ctx.db, 'stock_groups', name);
  const fields = { alias: str(row, 'alias'), ...gstFieldsFor(row) };
  if (existing !== null) {
    if (!opts.updateExisting) return duplicate([], `Stock group "${name}"`);
    const current = ctx.db.value<string>('SELECT name FROM stock_groups WHERE id = :id', { id: existing }) as string;
    saveStockGroup(ctx, { id: existing, name: current, ...fields, ...(parentName !== undefined ? { parentId } : {}) });
    return { action: 'update', status: 'ok', messages: ['Already exists — updated.'] };
  }
  saveStockGroup(ctx, { name, parentId, ...fields });
  return { action: 'create', status: 'ok', messages: [] };
};

const applyUnit: Applier = (ctx, rec, opts) => {
  const row = rec.rows[0];
  const firstName = str(row, 'firstUnit');
  if (firstName !== undefined) {
    const firstId = unitId(ctx.db, firstName);
    const secondName = str(row, 'secondUnit') ?? fail('Second Unit is required for a compound unit.');
    const secondId = unitId(ctx.db, secondName as string);
    const conversion = num(row, 'conversion') ?? fail('Conversion is required for a compound unit.');
    const existing = ctx.db.value<number>(
      'SELECT id FROM units WHERE is_compound = 1 AND first_unit_id = :f AND second_unit_id = :s AND conversion = :c',
      { f: firstId, s: secondId, c: conversion as number },
    );
    const symbol = compoundSymbol(firstName, conversion as number, secondName as string);
    if (existing !== undefined) return duplicate([], `Unit "${symbol}"`);
    saveUnit(ctx, { kind: 'compound', firstUnitId: firstId, conversion: conversion as number, secondUnitId: secondId });
    return { action: 'create', status: 'ok', messages: [] };
  }
  const symbol = (str(row, 'symbol') ?? fail('Symbol is required (or First Unit, Conversion and Second Unit for a compound unit).')) as string;
  const existing = ctx.db.value<number>('SELECT id FROM units WHERE symbol = :s COLLATE NOCASE', { s: symbol });
  const fields = { formalName: str(row, 'formalName'), uqc: str(row, 'uqc')?.toUpperCase(), decimalPlaces: num(row, 'decimals') };
  if (existing !== undefined) {
    if (!opts.updateExisting) return duplicate([], `Unit "${symbol}"`);
    saveUnit(ctx, { id: existing, kind: 'simple', symbol, ...fields });
    return { action: 'update', status: 'ok', messages: ['Already exists — updated.'] };
  }
  saveUnit(ctx, { kind: 'simple', symbol, ...fields });
  return { action: 'create', status: 'ok', messages: [] };
};

const applyGodown: Applier = (ctx, rec, opts) => {
  const row = rec.rows[0];
  const name = (str(row, 'name') ?? fail('Name is required')) as string;
  const parentName = str(row, 'parent');
  const parentId = parentName === undefined || isPrimary(parentName) ? null : (godownId(ctx.db, parentName) ?? null);
  const existing = findByName(ctx.db, 'godowns', name);
  const fields = { alias: str(row, 'alias'), address: str(row, 'address') };
  if (existing !== null) {
    if (!opts.updateExisting) return duplicate([], `Godown "${name}"`);
    const current = ctx.db.value<string>('SELECT name FROM godowns WHERE id = :id', { id: existing }) as string;
    saveGodown(ctx, { id: existing, name: current, ...fields, ...(parentName !== undefined ? { parentId } : {}) });
    return { action: 'update', status: 'ok', messages: ['Already exists — updated.'] };
  }
  saveGodown(ctx, { name, parentId, ...fields });
  return { action: 'create', status: 'ok', messages: [] };
};

const applyCostCentre: Applier = (ctx, rec, opts) => {
  const row = rec.rows[0];
  const name = (str(row, 'name') ?? fail('Name is required')) as string;
  const messages: string[] = [];
  const categoryName = str(row, 'category') ?? 'Primary Cost Category';
  let categoryId = ctx.db.value<number>('SELECT id FROM cost_categories WHERE name = :n COLLATE NOCASE', { n: categoryName }) ?? null;
  if (categoryId === null) {
    categoryId = saveCostCategory(ctx, { name: categoryName }).id;
    messages.push(`Cost category "${categoryName}" created.`);
  }
  const parentName = str(row, 'parent');
  let parentId: number | null = null;
  if (parentName !== undefined && !isPrimary(parentName)) {
    parentId = findByName(ctx.db, 'cost_centres', parentName);
    if (parentId === null) fail(`Cost centre "${parentName}" does not exist. List it before its sub-centres.`);
  }
  const existing = findByName(ctx.db, 'cost_centres', name);
  if (existing !== null) {
    if (!opts.updateExisting) return duplicate(messages, `Cost centre "${name}"`);
    saveCostCentre(ctx, { id: existing, alias: str(row, 'alias'), categoryId, parentId });
    return { action: 'update', status: 'ok', messages: [...messages, 'Already exists — updated.'] };
  }
  saveCostCentre(ctx, { name, alias: str(row, 'alias'), categoryId, parentId });
  return { action: 'create', status: messages.length ? 'warning' : 'ok', messages };
};

const applyStockItem: Applier = (ctx, rec, opts) => {
  const row = rec.rows[0];
  const db = ctx.db;
  const name = (str(row, 'name') ?? fail('Name is required')) as string;
  const messages: string[] = [];
  const input: StockItemSaveInput = { alias: str(row, 'alias'), partNo: str(row, 'partNo'), barcode: str(row, 'barcode'), description: str(row, 'description'), ...gstFieldsFor(row) };
  const parentName = str(row, 'parent');
  if (parentName !== undefined && !isPrimary(parentName)) {
    const gid = findByName(db, 'stock_groups', parentName);
    if (gid === null) fail(`Stock group "${parentName}" does not exist. Import stock groups first.`);
    input.groupId = gid as number;
  }
  const categoryName = str(row, 'category');
  if (categoryName !== undefined) {
    let cid = findByName(db, 'stock_categories', categoryName);
    if (cid === null) {
      cid = saveStockCategory(ctx, { name: categoryName }).id;
      messages.push(`Stock category "${categoryName}" created.`);
    }
    input.categoryId = cid;
  }
  const unit = str(row, 'unit');
  if (unit !== undefined) input.unitId = unitId(db, unit);
  const service = bool(row, 'isService');
  if (service !== undefined) input.isService = service;
  const costing = choice(COSTING_MAP, str(row, 'costingMethod'));
  if (costing) input.costingMethod = costing;
  for (const k of ['mrp', 'sellingPrice', 'purchasePrice'] as const) {
    const v = num(row, k);
    if (v !== undefined) input[k] = Math.abs(v);
  }
  const reorder = num(row, 'reorderLevel');
  if (reorder !== undefined) input.reorderLevel = reorder;
  const active = bool(row, 'active');
  if (active !== undefined) input.isActive = active;
  const qty = num(row, 'openingQty');
  if (qty !== undefined && qty !== 0) {
    const opening: StockOpeningInput = { qty, godownId: godownId(db, str(row, 'godown')) };
    const rate = num(row, 'openingRate');
    if (rate !== undefined) opening.rate = rate;
    const value = num(row, 'openingValue');
    if (value !== undefined) opening.value = Math.abs(value);
    if (rate === undefined && value === undefined) messages.push('Opening quantity without rate or value — valued at zero.');
    input.openings = [opening];
  }
  const existing = findByName(db, 'stock_items', name);
  if (existing !== null) {
    if (!opts.updateExisting) return duplicate(messages, `Stock item "${name}"`);
    const res = saveItem(ctx, { ...input, id: existing });
    return { action: 'update', status: 'ok', messages: [...messages, ...res.warnings, 'Already exists — updated.'] };
  }
  if (input.unitId === undefined) fail('Unit is required.');
  const res = saveItem(ctx, { ...input, name });
  const all = [...messages, ...res.warnings];
  return { action: 'create', status: all.length ? 'warning' : 'ok', messages: all };
};

// ───────────────────────────── Openings ─────────────────────────────

const applyOpeningBalances: Applier = (ctx, rec, opts) => {
  const db = ctx.db;
  const rows = rec.rows;
  const name = (str(rows[0], 'ledger') ?? fail('Ledger is required')) as string;
  const id = ledgerId(db, name);
  const gid = db.value<number>('SELECT group_id FROM ledgers WHERE id = :id', { id }) ?? null;
  const messages: string[] = [];
  const openingDrCr = first(rows, (r) => str(r, 'drCr'));
  const bills: OpeningBillInput[] = [];
  for (const r of rows) {
    const billName = str(r, 'billName');
    if (billName === undefined) continue;
    const billDate = str(r, 'billDate') ?? fail(`Row ${r.rowNumber}: Bill Date is required for bill ${billName}.`);
    const amount = num(r, 'billAmount') ?? fail(`Row ${r.rowNumber}: Bill Amount is required for bill ${billName}.`);
    bills.push({
      billName,
      billDate: billDate as string,
      dueDate: str(r, 'dueDate') ?? null,
      amount: signedOpening(db, amount as number, str(r, 'billDrCr') ?? openingDrCr, gid, messages, `Bill ${billName}`),
    });
  }
  const given = first(rows, (r) => num(r, 'openingBalance'));
  const opening = given !== undefined ? signedOpening(db, given, openingDrCr, gid, messages, 'Opening balance') : bills.reduce((s, b) => s + b.amount, 0);
  const current = db.get<{ opening_balance: number; maintain_bill_wise: number }>('SELECT opening_balance, maintain_bill_wise FROM ledgers WHERE id = :id', { id });
  const hasBills = (db.value<number>('SELECT COUNT(*) FROM opening_bills WHERE ledger_id = :id', { id }) ?? 0) > 0;
  const exists = (current?.opening_balance ?? 0) !== 0 || hasBills;
  if (exists && !opts.updateExisting) return duplicate(messages, `An opening balance for "${name}"`);
  const input: LedgerSaveInput = { id, openingBalance: opening };
  if (bills.length > 0) {
    input.openingBills = bills;
    if (current?.maintain_bill_wise !== 1) {
      input.billWise = true;
      messages.push('Bill-wise details switched on for this ledger.');
    }
  } else if (hasBills) {
    input.openingBills = [];
  }
  saveLedger(ctx, input);
  return { action: exists ? 'update' : 'create', status: messages.length ? 'warning' : 'ok', messages };
};

const applyStockOpenings: Applier = (ctx, rec, opts) => {
  const db = ctx.db;
  const name = (str(rec.rows[0], 'item') ?? fail('Item is required')) as string;
  const id = itemId(db, name);
  const exists = (db.value<number>('SELECT COUNT(*) FROM stock_openings WHERE item_id = :id', { id }) ?? 0) > 0;
  if (exists && !opts.updateExisting) return duplicate([], `Opening stock of "${name}"`);
  const openings: StockOpeningInput[] = rec.rows.map((r) => {
    const qty = num(r, 'qty') ?? fail(`Row ${r.rowNumber}: Quantity is required.`);
    const o: StockOpeningInput = { qty: qty as number, godownId: godownId(db, str(r, 'godown')) ?? mainGodownId(db) };
    const batch = str(r, 'batch');
    if (batch !== undefined) o.batchName = batch;
    const rate = num(r, 'rate');
    if (rate !== undefined) o.rate = rate;
    const value = num(r, 'value');
    if (value !== undefined) o.value = Math.abs(value);
    const mfg = str(r, 'mfgDate');
    if (mfg !== undefined) o.mfgDate = mfg;
    const exp = str(r, 'expiryDate');
    if (exp !== undefined) o.expiryDate = exp;
    return o;
  });
  const res = saveItem(ctx, { id, openings });
  return { action: exists ? 'update' : 'create', status: res.warnings.length ? 'warning' : 'ok', messages: res.warnings };
};

// ───────────────────────────── Vouchers ─────────────────────────────

function sameDate(rows: ParsedRow[]): string {
  const date = (str(rows[0], 'date') ?? fail(`Row ${rows[0].rowNumber}: Date is required.`)) as string;
  for (const r of rows) {
    const d = str(r, 'date');
    if (d !== undefined && d !== date) fail(`Row ${r.rowNumber}: all lines of one voucher must have the same date (${date}).`);
  }
  return date;
}

/** Use a typed number only when the voucher type accepts typed numbers. */
function numberFor(db: Db, vtId: number, typed: string | undefined, messages: string[]): string | undefined {
  if (typed === undefined) return undefined;
  const vt = loadVoucherType(db, vtId);
  if (vt.numberingMethod === 'manual' || vt.numberingMethod === 'automatic_override') return typed;
  messages.push(`Number ${typed} is not kept: "${vt.name}" uses automatic numbering (set it to Manual or Automatic with override to keep imported numbers).`);
  return undefined;
}

function numberExists(db: Db, vtId: number, number: string, date: string): boolean {
  const vt = loadVoucherType(db, vtId);
  const fy = db.value<number>('SELECT fy_start_month FROM company WHERE id = 1') ?? 4;
  const { from, to } = periodRange(vt, date, fy);
  // INDEXED BY: look the number up instead of scanning the type's year (see vouchers/numbering.ts NUMBER_TAKEN_SQL).
  return (
    db.value('SELECT 1 FROM vouchers INDEXED BY idx_vouchers_number WHERE voucher_type_id = :vt AND number = :n AND date BETWEEN :from AND :to LIMIT 1', {
      vt: vtId,
      n: number,
      from,
      to,
    }) !== undefined
  );
}

function saveImportedVoucher(ctx: CompanyCtx, input: VoucherInput, opts: ApplyOptions, messages: string[]): ApplyOutcome {
  const res = saveVoucher(ctx, { ...input, acknowledgeWarnings: opts.dryRun ? true : opts.acknowledgeWarnings === true });
  const warnings = res.warnings.map((w) => w.message);
  if (opts.dryRun && warnings.length > 0 && opts.acknowledgeWarnings !== true) {
    warnings.push('Turn on "Accept warnings" to import vouchers with warnings.');
  }
  const all = [...messages, ...warnings];
  return { action: 'create', status: res.warnings.length > 0 || messages.length > 0 ? 'warning' : 'ok', messages: all };
}

function invoiceApplier(side: 'sales' | 'purchase'): Applier {
  return (ctx, rec, opts) => {
    const db = ctx.db;
    const rows = rec.rows;
    const messages: string[] = [];
    const date = sameDate(rows);
    const vtName = first(rows, (r) => str(r, 'voucherType')) ?? (side === 'sales' ? 'Sales' : 'Purchase');
    const vtId = voucherTypeId(db, vtName, side === 'sales' ? ['sales'] : ['purchase'], side === 'sales' ? 'sales invoices' : 'purchase invoices');
    const partyName = (first(rows, (r) => str(r, 'party')) ?? fail('Party is required.')) as string;
    const partyLedgerId = ledgerId(db, partyName, side === 'sales' ? 'Customer' : 'Supplier');
    const input: VoucherInput = { voucherTypeId: vtId, date, mode: 'item_invoice', partyLedgerId };
    if (side === 'sales') {
      const invoiceNo = (str(rows[0], 'invoiceNo') ?? fail('Invoice No is required.')) as string;
      if (numberExists(db, vtId, invoiceNo, date)) return duplicate([], `Invoice ${invoiceNo}`);
      input.number = numberFor(db, vtId, invoiceNo, messages);
    } else {
      const ref = (str(rows[0], 'supplierInvoiceNo') ?? fail('Supplier Invoice No is required.')) as string;
      const dup = db.value(
        `SELECT 1 FROM vouchers WHERE base_type = 'purchase' AND party_ledger_id = :p AND reference_no = :r COLLATE NOCASE AND is_cancelled = 0 LIMIT 1`,
        { p: partyLedgerId, r: ref },
      );
      if (dup !== undefined) return duplicate([], `Purchase bill ${ref} of ${partyName}`);
      input.referenceNo = ref;
      input.referenceDate = first(rows, (r) => str(r, 'supplierInvoiceDate')) ?? date;
    }
    const pos = first(rows, (r) => str(r, 'placeOfSupply'));
    if (pos !== undefined) input.placeOfSupply = stateCodeOf(pos);
    const narration = first(rows, (r) => str(r, 'narration'));
    if (narration !== undefined) input.narration = narration;
    const items: ItemLineInput[] = [];
    const ledgers: LedgerLineInput[] = [];
    for (const r of rows) {
      const item = str(r, 'item');
      const ledgerName = str(r, 'ledger');
      const amount = num(r, 'amount');
      const rate = num(r, 'gstRate');
      if (item !== undefined) {
        const qty = num(r, 'qty') ?? fail(`Row ${r.rowNumber}: Qty is required for item ${item}.`);
        const line: ItemLineInput = { itemId: itemId(db, item), qty: Math.abs(qty as number), rate: Math.abs(num(r, 'rate') ?? 0) };
        if (num(r, 'rate') === undefined && amount === undefined) fail(`Row ${r.rowNumber}: Rate or Amount is required for item ${item}.`);
        const disc = num(r, 'discountPct');
        if (disc !== undefined) line.discountPct = disc;
        if (amount !== undefined) line.amount = Math.abs(amount);
        if (ledgerName !== undefined) line.ledgerId = ledgerId(db, ledgerName);
        const gd = godownId(db, str(r, 'godown'));
        if (gd !== undefined) line.godownId = gd;
        if (rate !== undefined) line.gstRateOverride = normaliseGstRate(rate);
        items.push(line);
      } else if (ledgerName !== undefined) {
        if (amount === undefined) fail(`Row ${r.rowNumber}: Amount is required for ledger line ${ledgerName}.`);
        const line: LedgerLineInput = { ledgerId: ledgerId(db, ledgerName), amount: amount as number };
        if (rate !== undefined) line.gst = { rate: normaliseGstRate(rate) };
        ledgers.push(line);
      } else {
        fail(`Row ${r.rowNumber}: give an Item (with Qty and Rate) or a Ledger (with Amount).`);
      }
    }
    if (items.length > 0) input.items = items;
    else input.mode = 'accounting_invoice';
    if (ledgers.length > 0) input.ledgers = ledgers;
    return saveImportedVoucher(ctx, input, opts, messages);
  };
}

const LEDGER_MODE_BASES = ['payment', 'receipt', 'contra', 'journal', 'sales', 'purchase', 'credit_note', 'debit_note', 'memorandum', 'reversing_journal'];

const applyLedgerVoucher: Applier = (ctx, rec, opts) => {
  const db = ctx.db;
  const rows = rec.rows;
  const messages: string[] = [];
  const date = sameDate(rows);
  const vtName = (first(rows, (r) => str(r, 'voucherType')) ?? fail('Voucher Type is required.')) as string;
  const vtId = voucherTypeId(db, vtName, LEDGER_MODE_BASES, 'Dr/Cr ledger vouchers');
  const typed = first(rows, (r) => str(r, 'number'));
  if (typed !== undefined && numberExists(db, vtId, typed, date)) return duplicate([], `${vtName} ${typed}`);
  const input: VoucherInput = { voucherTypeId: vtId, date, mode: 'ledger', number: numberFor(db, vtId, typed, messages) };
  const narration = first(rows, (r) => str(r, 'narration'));
  if (narration !== undefined) input.narration = narration;
  const ref = first(rows, (r) => str(r, 'referenceNo'));
  if (ref !== undefined) input.referenceNo = ref;
  input.ledgers = rows.map((r): LedgerLineInput => {
    const name = (str(r, 'ledger') ?? fail(`Row ${r.rowNumber}: Ledger is required.`)) as string;
    const dr = num(r, 'debit');
    const cr = num(r, 'credit');
    if ((dr === undefined || dr === 0) && (cr === undefined || cr === 0)) fail(`Row ${r.rowNumber}: enter a Debit or a Credit amount.`);
    if (dr !== undefined && dr !== 0 && cr !== undefined && cr !== 0) fail(`Row ${r.rowNumber}: enter either Debit or Credit, not both.`);
    const amount = dr !== undefined && dr !== 0 ? Math.abs(dr) : -Math.abs(cr as number);
    const line: LedgerLineInput = { ledgerId: ledgerId(db, name), amount };
    const billType = choice(BILL_TYPE_MAP, str(r, 'billType'));
    const billName = str(r, 'billName');
    if (billType !== undefined || billName !== undefined) {
      const refType = billType ?? 'against';
      line.billAllocations = [refType === 'on_account' ? { refType, amount: Math.abs(amount) } : { refType, billName, amount: Math.abs(amount) }];
    }
    const chq = str(r, 'instrumentNo');
    if (chq !== undefined) line.instrument = { type: 'cheque', number: chq, date: str(r, 'instrumentDate') };
    return line;
  });
  return saveImportedVoucher(ctx, input, opts, messages);
};

export const APPLIERS: Record<ImportKind, Applier> = {
  groups: applyGroup,
  ledgers: applyLedger,
  stock_groups: applyStockGroup,
  units: applyUnit,
  godowns: applyGodown,
  cost_centres: applyCostCentre,
  stock_items: applyStockItem,
  opening_balances: applyOpeningBalances,
  stock_openings: applyStockOpenings,
  sales_invoices: invoiceApplier('sales'),
  purchase_invoices: invoiceApplier('purchase'),
  vouchers_ledger: applyLedgerVoucher,
};

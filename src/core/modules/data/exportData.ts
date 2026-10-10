/**
 * Masters and voucher exports. Master sheets use exactly the columns of the import templates
 * (importSpecs.ts), so an exported workbook can be imported back (e.g. into another company).
 * Voucher exports are flat: Vouchers (one row per voucher), Ledger Entries (one row per ledger entry /
 * bill allocation — the layout of the 'vouchers_ledger' import) and Inventory Entries (one row per stock
 * line, headers as in the sales/purchase invoice templates). CSV output of several sheets is a .zip.
 * Voucher exports are streamed month by month into a temporary ZIP file (constant memory, one read
 * snapshot, yields to the event loop) — see "Vouchers (streamed)" below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VOUCHER_BASE_TYPES } from '../../../shared/constants.ts';
import { addDays, endOfMonth, formatDate } from '../../../shared/dates.ts';
import { stateName } from '../../../shared/gst/index.ts';
import type { ExportFileResult, ExportMastersInput, ExportVouchersInput, MasterExportKind } from '../../../shared/types/data.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { Db } from '../../db/db.ts';
import { neutraliseFormula, toCsv } from '../../lib/csv.ts';
import { allAliases, extraAliasMap, joinAliasCell } from '../../lib/masterAliases.ts';
import { randomToken } from '../../lib/crypto.ts';
import { AppError, validation } from '../../lib/errors.ts';
import { encodeUtf8WithBom } from '../../lib/text.ts';
import { MAX_ROWS as XLSX_MAX_ROWS, writeXlsx, XlsxStreamWriter, type XlsxCell, type XlsxColumn, type XlsxKind, type XlsxSheet } from '../../lib/xlsx.ts';
import { createZip, ZipFileWriter } from '../../lib/zip.ts';
import { loadGroupTree } from '../accounts/books.ts';
import { fileSlug, requirePermission, yieldToEventLoop } from './common.ts';
import { CSV_MIME, paiseText, XLSX_MIME, ZIP_MIME } from './exportTable.ts';
import { BILL_TYPE_CHOICES, COSTING_CHOICES, KIND_SPECS, REGISTRATION_CHOICES, TAXABILITY_CHOICES, type ColumnSpec } from './importSpecs.ts';

type Value = string | number | boolean | null;

interface SheetCol {
  header: string;
  type: ColumnSpec['type'];
}

interface Sheet {
  name: string;
  columns: SheetCol[];
  rows: Value[][];
}

const XLSX_KIND: Record<ColumnSpec['type'], XlsxKind> = {
  text: 'text',
  amount: 'amount',
  qty: 'number',
  number: 'number',
  percent: 'number',
  integer: 'integer',
  date: 'date',
  yesno: 'text',
  drcr: 'text',
  choice: 'text',
};

function xlsxCell(type: ColumnSpec['type'], v: Value): XlsxCell {
  if (v === null || v === '') return null;
  if (typeof v === 'boolean') return { v: v ? 'Yes' : 'No', kind: 'text' };
  if (type === 'amount' && typeof v === 'number') return { v: v / 100, kind: 'amount' };
  if (typeof v === 'number') return { v, kind: XLSX_KIND[type] === 'text' ? 'number' : XLSX_KIND[type] };
  if (type === 'date') return { v, kind: 'date' };
  return { v, kind: 'text' };
}

function csvValue(type: ColumnSpec['type'], v: Value): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (type === 'amount' && typeof v === 'number') return paiseText(v);
  if (typeof v === 'number') return String(v);
  return neutraliseFormula(v);
}

function toXlsxSheet(s: Sheet): XlsxSheet {
  const columns: XlsxColumn[] = s.columns.map((c) => ({ header: c.header, kind: XLSX_KIND[c.type], width: Math.max(10, Math.min(40, c.header.length + 4)) }));
  return { name: s.name, columns, rows: s.rows.map((r) => r.map((v, i) => xlsxCell(s.columns[i].type, v))), freezeHeader: true, autoFilter: s.rows.length > 0 };
}

function toCsvText(s: Sheet): string {
  const lines = [s.columns.map((c) => neutraliseFormula(c.header)), ...s.rows.map((r) => r.map((v, i) => csvValue(s.columns[i].type, v)))];
  return toCsv(lines, { neutraliseFormulas: false });
}

function render(sheets: Sheet[], format: 'xlsx' | 'csv', baseName: string): ExportFileResult {
  const rowCount = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (format === 'xlsx') {
    return { bytes: writeXlsx({ sheets: sheets.map(toXlsxSheet), creator: 'Bahi ERP' }), fileName: `${baseName}.xlsx`, mimeType: XLSX_MIME, rowCount };
  }
  if (sheets.length === 1) return { bytes: encodeUtf8WithBom(toCsvText(sheets[0])), fileName: `${baseName}.csv`, mimeType: CSV_MIME, rowCount };
  const entries = sheets.map((s) => ({ name: `${fileSlug(s.name)}.csv`, data: encodeUtf8WithBom(toCsvText(s)) }));
  return { bytes: createZip(entries), fileName: `${baseName}.zip`, mimeType: ZIP_MIME, rowCount };
}

/** Sheet with the import-template columns of `kind`, rows keyed by column key. */
function specSheet(kind: keyof typeof KIND_SPECS, records: Array<Record<string, Value>>): Sheet {
  const spec = KIND_SPECS[kind];
  return {
    name: spec.sheetName,
    columns: spec.columns.map((c) => ({ header: c.header, type: c.type })),
    rows: records.map((r) => spec.columns.map((c) => r[c.key] ?? null)),
  };
}

const yesNo = (n: number | null): string => (n === 1 ? 'Yes' : 'No');
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const label = (choices: readonly string[], code: string | null): string | null => {
  if (!code) return null;
  const norm = code.replace(/_/g, ' ').toLowerCase();
  return choices.find((c) => c.toLowerCase() === norm || c.toLowerCase().replace(/-/g, ' ') === norm) ?? code;
};
const COSTING_LABEL: Record<string, string> = {
  avg_cost: COSTING_CHOICES[0],
  fifo: COSTING_CHOICES[1],
  lifo: COSTING_CHOICES[2],
  last_purchase: COSTING_CHOICES[3],
  std_cost: COSTING_CHOICES[4],
};

/** Depth-first (parents before children) order of a self-referencing master table. */
function treeOrder<T extends { id: number; parent_id: number | null; name: string }>(rows: T[]): T[] {
  const children = new Map<number | null, T[]>();
  for (const r of rows) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r);
    children.set(r.parent_id, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const out: T[] = [];
  const seen = new Set<number>();
  const visit = (parent: number | null): void => {
    for (const r of children.get(parent) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      visit(r.id);
    }
  };
  visit(null);
  for (const r of rows) if (!seen.has(r.id)) out.push(r); // orphans (should not happen)
  return out;
}

// ───────────────────────────── Masters ─────────────────────────────

function groupsSheet(db: Db): Sheet {
  const tree = loadGroupTree(db);
  const aliases = new Map(db.all<{ id: number; alias: string | null }>('SELECT id, alias FROM groups').map((r) => [r.id, r.alias]));
  const rows: Array<Record<string, Value>> = [];
  for (const id of tree.order) {
    const g = tree.byId.get(id);
    if (!g) continue;
    const parent = g.parentId === null ? null : tree.byId.get(g.parentId);
    rows.push({
      name: g.name,
      parent: parent ? parent.name : 'Primary',
      alias: aliases.get(id) ?? null,
      nature: g.parentId === null ? cap(g.nature) : null,
      affectsGrossProfit: g.parentId === null && (g.nature === 'income' || g.nature === 'expenses') ? yesNo(g.affectsGrossProfit ? 1 : 0) : null,
    });
  }
  return specSheet('groups', rows);
}

interface LedgerExportRow {
  id: number;
  name: string;
  group_name: string;
  alias: string | null;
  opening_balance: number;
  maintain_bill_wise: number;
  default_credit_days: number | null;
  credit_limit: number | null;
  gstin: string | null;
  gst_registration_type: string | null;
  state_code: string | null;
  address: string | null;
  pincode: string | null;
  pan: string | null;
  contact_person: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  bank_account_no: string | null;
  bank_ifsc: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  gst_applicable: string;
  hsn_sac: string | null;
  gst_rate: number | null;
  gst_taxability: string | null;
  gst_supply_type: string | null;
  tax_type: string | null;
  gst_duty_head: string | null;
  is_active: number;
}

function ledgersSheet(db: Db): Sheet {
  const rows = db.all<LedgerExportRow>(
    `SELECT l.*, g.name AS group_name FROM ledgers l JOIN groups g ON g.id = l.group_id ORDER BY l.name COLLATE NOCASE`,
  );
  const extras = extraAliasMap(db, 'ledger');
  return specSheet(
    'ledgers',
    rows.map((l) => ({
      name: l.name,
      parent: l.group_name,
      alias: joinAliasCell(allAliases(l.alias, extras.get(l.id))),
      openingBalance: l.opening_balance === 0 ? null : Math.abs(l.opening_balance),
      openingDrCr: l.opening_balance === 0 ? null : l.opening_balance > 0 ? 'Dr' : 'Cr',
      billWise: yesNo(l.maintain_bill_wise),
      creditDays: l.default_credit_days,
      creditLimit: l.credit_limit,
      gstin: l.gstin,
      registrationType: label(REGISTRATION_CHOICES, l.gst_registration_type),
      state: l.state_code ? stateName(l.state_code) || l.state_code : null,
      address: l.address,
      pincode: l.pincode,
      pan: l.pan,
      contactPerson: l.contact_person,
      phone: l.phone,
      mobile: l.mobile,
      email: l.email,
      bankAccountNo: l.bank_account_no,
      bankIfsc: l.bank_ifsc,
      bankName: l.bank_name,
      bankBranch: l.bank_branch,
      gstApplicable: l.gst_applicable === 'applicable' ? 'Yes' : null,
      hsnSac: l.hsn_sac,
      gstRate: l.gst_rate,
      taxability: l.gst_applicable === 'applicable' ? label(TAXABILITY_CHOICES, l.gst_taxability === 'nil_rated' ? 'nil rated' : l.gst_taxability === 'non_gst' ? 'non-gst' : l.gst_taxability) : null,
      supplyType: l.gst_supply_type ? cap(l.gst_supply_type) : null,
      taxType: l.tax_type === 'OTHER' ? 'Other' : l.tax_type,
      dutyHead: l.gst_duty_head === 'CESS' ? 'Cess' : l.gst_duty_head,
      active: l.is_active === 1 ? null : 'No',
    })),
  );
}

function stockGroupsSheet(db: Db): Sheet {
  const rows = treeOrder(
    db.all<{ id: number; parent_id: number | null; name: string; alias: string | null; parent_name: string | null; hsn_sac: string | null; gst_rate: number | null; gst_taxability: string | null; gst_applicable: string }>(
      'SELECT g.id, g.parent_id, g.name, g.alias, p.name AS parent_name, g.hsn_sac, g.gst_rate, g.gst_taxability, g.gst_applicable FROM stock_groups g LEFT JOIN stock_groups p ON p.id = g.parent_id',
    ),
  );
  return specSheet(
    'stock_groups',
    rows.map((g) => ({
      name: g.name,
      parent: g.parent_name ?? 'Primary',
      alias: g.alias,
      hsnSac: g.hsn_sac,
      gstRate: g.gst_applicable === 'applicable' ? g.gst_rate : null,
      taxability: g.gst_applicable === 'applicable' ? taxLabel(g.gst_taxability) : null,
    })),
  );
}

function taxLabel(t: string | null): string | null {
  if (!t) return null;
  return t === 'nil_rated' ? 'Nil Rated' : t === 'non_gst' ? 'Non-GST' : cap(t);
}

function unitsSheet(db: Db): Sheet {
  const rows = db.all<{ symbol: string; formal_name: string | null; uqc: string | null; decimal_places: number; is_compound: number; first: string | null; conversion: number | null; second: string | null }>(
    `SELECT u.symbol, u.formal_name, u.uqc, u.decimal_places, u.is_compound, f.symbol AS first, u.conversion, s.symbol AS second
       FROM units u LEFT JOIN units f ON f.id = u.first_unit_id LEFT JOIN units s ON s.id = u.second_unit_id
      ORDER BY u.is_compound, u.symbol COLLATE NOCASE`,
  );
  return specSheet(
    'units',
    rows.map((u): Record<string, Value> =>
      u.is_compound === 1
        ? { firstUnit: u.first, conversion: u.conversion, secondUnit: u.second }
        : { symbol: u.symbol, formalName: u.formal_name, uqc: u.uqc, decimals: u.decimal_places },
    ),
  );
}

function godownsSheet(db: Db): Sheet {
  const rows = treeOrder(
    db.all<{ id: number; parent_id: number | null; name: string; alias: string | null; parent_name: string | null; address: string | null }>(
      'SELECT g.id, g.parent_id, g.name, g.alias, p.name AS parent_name, g.address FROM godowns g LEFT JOIN godowns p ON p.id = g.parent_id',
    ),
  );
  return specSheet(
    'godowns',
    rows.map((g) => ({ name: g.name, parent: g.parent_name, alias: g.alias, address: g.address })),
  );
}

function costCentresSheet(db: Db): Sheet {
  const rows = treeOrder(
    db.all<{ id: number; parent_id: number | null; name: string; alias: string | null; parent_name: string | null; category: string }>(
      `SELECT c.id, c.parent_id, c.name, c.alias, p.name AS parent_name, k.name AS category
         FROM cost_centres c JOIN cost_categories k ON k.id = c.category_id LEFT JOIN cost_centres p ON p.id = c.parent_id`,
    ),
  );
  return specSheet(
    'cost_centres',
    rows.map((c) => ({ name: c.name, category: c.category, parent: c.parent_name, alias: c.alias })),
  );
}

function stockItemsSheet(db: Db): Sheet {
  const items = db.all<{
    id: number;
    name: string;
    group_name: string | null;
    category_name: string | null;
    unit: string;
    alias: string | null;
    part_no: string | null;
    barcode: string | null;
    description: string | null;
    hsn_sac: string | null;
    gst_rate: number | null;
    gst_taxability: string;
    gst_applicable: string;
    cess_rate: number | null;
    is_service: number;
    costing_method: string;
    mrp: number | null;
    selling_price: number | null;
    purchase_price: number | null;
    reorder_level: number | null;
    is_active: number;
  }>(
    `SELECT i.*, g.name AS group_name, c.name AS category_name, u.symbol AS unit
       FROM stock_items i JOIN units u ON u.id = i.unit_id
       LEFT JOIN stock_groups g ON g.id = i.group_id LEFT JOIN stock_categories c ON c.id = i.category_id
      ORDER BY i.name COLLATE NOCASE`,
  );
  const openings = new Map<number, Array<{ qty: number; rate: number; value: number; godown: string }>>();
  for (const o of db.all<{ item_id: number; qty: number; rate: number; value: number; godown: string }>(
    'SELECT o.item_id, o.qty, o.rate, o.value, g.name AS godown FROM stock_openings o JOIN godowns g ON g.id = o.godown_id ORDER BY o.id',
  )) {
    const list = openings.get(o.item_id) ?? [];
    list.push(o);
    openings.set(o.item_id, list);
  }
  const extras = extraAliasMap(db, 'stock_item');
  return specSheet(
    'stock_items',
    items.map((i) => {
      const ops = openings.get(i.id) ?? [];
      const single = ops.length === 1 ? ops[0] : null;
      const qty = ops.reduce((s, o) => s + o.qty, 0);
      const value = ops.reduce((s, o) => s + o.value, 0);
      return {
        name: i.name,
        parent: i.group_name,
        category: i.category_name,
        unit: i.unit,
        alias: joinAliasCell(allAliases(i.alias, extras.get(i.id))),
        partNo: i.part_no,
        barcode: i.barcode,
        description: i.description,
        hsnSac: i.hsn_sac,
        gstRate: i.gst_applicable === 'applicable' ? i.gst_rate : null,
        taxability: i.gst_applicable === 'applicable' ? taxLabel(i.gst_taxability) : null,
        cessRate: i.cess_rate || null,
        isService: i.is_service === 1 ? 'Yes' : null,
        costingMethod: COSTING_LABEL[i.costing_method] ?? null,
        mrp: i.mrp,
        sellingPrice: i.selling_price,
        purchasePrice: i.purchase_price,
        reorderLevel: i.reorder_level,
        openingQty: ops.length ? qty : null,
        openingRate: single ? single.rate : null,
        openingValue: ops.length ? value : null,
        godown: single && single.godown !== 'Main Location' ? single.godown : null,
        active: i.is_active === 1 ? null : 'No',
      };
    }),
  );
}

function voucherTypesSheet(db: Db): Sheet {
  const rows = db.all<{ name: string; base_type: string; parent: string | null; abbreviation: string | null; numbering_method: string; numbering_prefix: string | null; numbering_suffix: string | null; numbering_width: number; numbering_restart: string; is_active: number; is_predefined: number }>(
    `SELECT v.*, p.name AS parent FROM voucher_types v LEFT JOIN voucher_types p ON p.id = v.parent_id ORDER BY v.is_predefined DESC, v.name COLLATE NOCASE`,
  );
  const columns: SheetCol[] = [
    { header: 'Name', type: 'text' },
    { header: 'Type of Voucher', type: 'text' },
    { header: 'Based On', type: 'text' },
    { header: 'Abbreviation', type: 'text' },
    { header: 'Numbering', type: 'text' },
    { header: 'Prefix', type: 'text' },
    { header: 'Suffix', type: 'text' },
    { header: 'Width', type: 'integer' },
    { header: 'Restart', type: 'text' },
    { header: 'Active', type: 'yesno' },
    { header: 'Predefined', type: 'yesno' },
  ];
  return {
    name: 'Voucher Types',
    columns,
    rows: rows.map((v) => [
      v.name,
      v.base_type,
      v.parent,
      v.abbreviation,
      v.numbering_method,
      v.numbering_prefix,
      v.numbering_suffix,
      v.numbering_width,
      v.numbering_restart,
      v.is_active === 1,
      v.is_predefined === 1,
    ]),
  };
}

const MASTER_SHEETS: Record<MasterExportKind, (db: Db) => Sheet> = {
  groups: groupsSheet,
  ledgers: ledgersSheet,
  stock_groups: stockGroupsSheet,
  stock_items: stockItemsSheet,
  units: unitsSheet,
  godowns: godownsSheet,
  cost_centres: costCentresSheet,
  voucher_types: voucherTypesSheet,
};

/** Dependency order (so the workbook can be imported top to bottom). */
const MASTER_ORDER: readonly MasterExportKind[] = ['groups', 'ledgers', 'units', 'stock_groups', 'godowns', 'cost_centres', 'stock_items', 'voucher_types'];

export function exportMasters(ctx: CompanyCtx, input: ExportMastersInput): ExportFileResult {
  requirePermission(ctx, 'data.export');
  const kinds = MASTER_ORDER.filter((k) => input.kinds.includes(k));
  if (kinds.length === 0) throw validation([{ path: 'kinds', message: 'Choose at least one kind of master to export' }]);
  const sheets = kinds.map((k) => MASTER_SHEETS[k](ctx.db));
  const out = render(sheets, input.format, kinds.length === 1 ? `Masters-${fileSlug(sheets[0].name)}` : 'Masters');
  ctx.db.transaction(() =>
    ctx.audit({ action: 'export', entityType: 'masters', entityLabel: `Masters: ${kinds.join(', ')}`, after: { format: input.format, kinds, rows: out.rowCount } }),
  );
  return out;
}

// ───────────────────────────── Vouchers (streamed) ─────────────────────────────
//
// A five-year voucher export runs to a million rows. Building it in memory (rows → cell arrays → XML
// string → in-memory ZIP) took ~0.75 GB of heap and crashed under a 1 GB heap, so it is streamed:
// rows are read one at a time (Db.iterate) from ONE read snapshot, converted and written straight into
// a ZIP file (XlsxStreamWriter / CSV entries → ZipFileWriter, deflated in 256 KiB blocks) in the
// company folder, which is then read back once and deleted. Peak memory ≈ the size of the finished
// file. With a file-backed company the snapshot is a separate read-only connection, so the export
// yields to the event loop every few thousand rows and other requests keep being served meanwhile.

interface VoucherExportRow {
  id: number;
  date: string;
  type_name: string;
  base_type: string;
  number: string | null;
  reference_no: string | null;
  reference_date: string | null;
  party_name: string | null;
  party_gstin: string | null;
  place_of_supply: string | null;
  narration: string | null;
  taxable_amount: number;
  tax_amount: number;
  round_off: number;
  total_amount: number;
  is_optional: number;
  is_cancelled: number;
  is_post_dated: number;
  gst_nature: string | null;
}

interface LedgerExportRow {
  voucher_id: number;
  date: string;
  type_name: string;
  number: string | null;
  ledger: string;
  amount: number;
  narration: string | null;
  entry_narration: string | null;
  reference_no: string | null;
  instrument_no: string | null;
  instrument_date: string | null;
  ref_type: string | null;
  bill_name: string | null;
  bill_amount: number | null;
}

interface InventoryExportRow {
  voucher_id: number;
  date: string;
  type_name: string;
  number: string | null;
  party_name: string | null;
  item: string;
  qty: number;
  billed_qty: number | null;
  rate: number;
  discount_pct: number;
  amount: number;
  godown: string | null;
  batch_name: string | null;
  ledger: string | null;
  gst_rate: number | null;
  hsn_sac: string | null;
}

const VOUCHER_COLUMNS: SheetCol[] = [
  { header: 'Voucher Key', type: 'text' },
  { header: 'Date', type: 'date' },
  { header: 'Voucher Type', type: 'text' },
  { header: 'Base Type', type: 'text' },
  { header: 'Voucher No', type: 'text' },
  { header: 'Reference No', type: 'text' },
  { header: 'Reference Date', type: 'date' },
  { header: 'Party', type: 'text' },
  { header: 'Party GSTIN', type: 'text' },
  { header: 'Place of Supply', type: 'text' },
  { header: 'Narration', type: 'text' },
  { header: 'Taxable Value', type: 'amount' },
  { header: 'Tax', type: 'amount' },
  { header: 'Round Off', type: 'amount' },
  { header: 'Total', type: 'amount' },
  { header: 'Optional', type: 'yesno' },
  { header: 'Cancelled', type: 'yesno' },
  { header: 'Post-dated', type: 'yesno' },
  { header: 'GST Nature', type: 'text' },
];

const INVENTORY_COLUMNS: SheetCol[] = [
  { header: 'Voucher Key', type: 'text' },
  { header: 'Date', type: 'date' },
  { header: 'Voucher Type', type: 'text' },
  { header: 'Invoice No', type: 'text' },
  { header: 'Party', type: 'text' },
  { header: 'Item', type: 'text' },
  { header: 'Qty', type: 'qty' },
  { header: 'Direction', type: 'text' },
  { header: 'Rate', type: 'number' },
  { header: 'Discount %', type: 'percent' },
  { header: 'Amount', type: 'amount' },
  { header: 'Godown', type: 'text' },
  { header: 'Batch', type: 'text' },
  { header: 'Ledger', type: 'text' },
  { header: 'GST Rate', type: 'percent' },
  { header: 'HSN/SAC', type: 'text' },
];

/** Rows written between event-loop yields (snapshot connection only). */
export const EXPORT_YIELD_ROWS = 5000;
/** Data rows one Excel sheet can hold (1,048,576 minus the header row). */
export const XLSX_MAX_DATA_ROWS = XLSX_MAX_ROWS - 1;

/**
 * The period cut into calendar months. Each query covers one month, so SQLite sorts one month's rows at
 * a time (a five-year ORDER BY would otherwise block for a second before the first row) and the
 * export can yield between months.
 */
export function monthSlices(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; ) {
    const monthEnd = endOfMonth(start);
    const end = monthEnd < to ? monthEnd : to;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return out;
}

/** VALIDATION when one sheet of an .xlsx voucher export would exceed Excel's row limit (CSV has none). */
export function assertFitsInExcel(counts: { vouchers: number; ledger: number; inventory: number }): void {
  const largest = Math.max(counts.vouchers, counts.ledger, counts.inventory);
  if (largest > XLSX_MAX_DATA_ROWS) {
    throw validation([
      {
        path: 'format',
        message: `This period has ${largest.toLocaleString('en-IN')} rows in one sheet, more than Excel can hold (${XLSX_MAX_DATA_ROWS.toLocaleString('en-IN')}). Export as CSV, or choose a shorter period.`,
      },
    ]);
  }
}

/** Where streamed sheets go: an .xlsx workbook, or one CSV file per sheet inside a .zip. */
interface SheetSink {
  begin(name: string, columns: SheetCol[]): void;
  row(values: Value[]): void;
  end(): void;
  finish(): void;
}

function xlsxSink(zip: ZipFileWriter): SheetSink {
  const book = new XlsxStreamWriter(zip, { creator: 'Bahi ERP' });
  let cols: SheetCol[] = [];
  return {
    begin(name, columns) {
      cols = columns;
      book.beginSheet({
        name,
        columns: columns.map((c) => ({ header: c.header, kind: XLSX_KIND[c.type], width: Math.max(10, Math.min(40, c.header.length + 4)) })),
        freezeHeader: true,
        autoFilter: true,
      });
    },
    row(values) {
      book.addRow(values.map((v, i) => xlsxCell(cols[i].type, v)));
    },
    end() {
      book.endSheet();
    },
    finish() {
      book.finish();
    },
  };
}

function csvSink(zip: ZipFileWriter): SheetSink {
  let cols: SheetCol[] = [];
  const used = new Set<string>();
  return {
    begin(name, columns) {
      cols = columns;
      let file = `${fileSlug(name)}.csv`;
      for (let n = 2; used.has(file); n++) file = `${fileSlug(name)}-${n}.csv`;
      used.add(file);
      zip.beginEntry(file);
      zip.write('﻿');
      zip.write(toCsv([columns.map((c) => neutraliseFormula(c.header))], { neutraliseFormulas: false }));
    },
    row(values) {
      zip.write(toCsv([values.map((v, i) => csvValue(cols[i].type, v))], { neutraliseFormulas: false }));
    },
    end() {
      zip.endEntry();
    },
    finish() {
      /* nothing else in a CSV bundle */
    },
  };
}

/**
 * A consistent read view for a long export: a separate read-only connection holding one read
 * transaction (WAL snapshot) when the company is a file, else the company connection itself (tests'
 * in-memory companies), where the export must not yield.
 */
export function openSnapshot(ctx: CompanyCtx): { db: Db; canYield: boolean; close(): void } {
  const file = ctx.company.dbPath;
  if (file !== ':memory:' && file !== '' && fs.existsSync(file)) {
    const db = new Db(file, { readOnly: true });
    try {
      db.exec('BEGIN');
    } catch (err) {
      db.close();
      throw err;
    }
    return {
      db,
      canYield: true,
      close: () => {
        try {
          db.exec('COMMIT');
        } catch {
          /* read transaction already ended */
        }
        db.close();
      },
    };
  }
  return { db: ctx.db, canYield: false, close: () => undefined };
}

export async function exportVouchers(ctx: CompanyCtx, input: ExportVouchersInput): Promise<ExportFileResult> {
  requirePermission(ctx, 'data.export');
  if (input.to < input.from) throw validation([{ path: 'to', message: 'The period end date is before its start date' }]);
  const bases = (input.baseTypes?.length ? input.baseTypes : VOUCHER_BASE_TYPES).filter((b) => (VOUCHER_BASE_TYPES as readonly string[]).includes(b));
  const params = {
    from: input.from,
    to: input.to,
    bases: JSON.stringify(bases),
    opt: input.includeOptional === false ? 0 : 1,
    canc: input.includeCancelled === true ? 1 : 0,
  };
  const filter = `v.date BETWEEN :from AND :to AND v.base_type IN (SELECT value FROM json_each(:bases))
                  AND (:opt = 1 OR v.is_optional = 0) AND (:canc = 1 OR v.is_cancelled = 0)`;
  const baseName = `Vouchers_${formatDate(input.from, 'DD-MM-YYYY')}_to_${formatDate(input.to, 'DD-MM-YYYY')}`;

  const snap = openSnapshot(ctx);
  let zip: ZipFileWriter | null = null;
  let voucherCount = 0;
  let rowCount = 0;
  let bytes: Uint8Array;
  try {
    const db = snap.db;
    const slices = monthSlices(input.from, input.to);
    const pause = async (): Promise<void> => {
      if (!snap.canYield) return;
      await yieldToEventLoop();
      if (!ctx.db.isOpen) throw new AppError('CONFLICT', 'The company was closed during the export. Export again.');
    };
    if (input.format === 'xlsx') {
      const counts = { vouchers: 0, ledger: 0, inventory: 0 };
      for (const m of slices) {
        const p = { ...params, ...m };
        counts.vouchers += db.value<number>(`SELECT COUNT(*) FROM vouchers v WHERE ${filter}`, p) ?? 0;
        counts.ledger +=
          db.value<number>(
            `SELECT COUNT(*) FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id LEFT JOIN bill_allocations ba ON ba.ledger_entry_id = le.id WHERE ${filter}`,
            p,
          ) ?? 0;
        counts.inventory += db.value<number>(`SELECT COUNT(*) FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id WHERE ${filter}`, p) ?? 0;
        await pause();
      }
      assertFitsInExcel(counts);
    }

    fs.mkdirSync(ctx.company.dir, { recursive: true });
    const tmp = path.join(ctx.company.dir, `.export-${randomToken(6)}.tmp`);
    zip = new ZipFileWriter(tmp);
    const sink = input.format === 'xlsx' ? xlsxSink(zip) : csvSink(zip);
    let sinceYield = 0;
    const tick = async (): Promise<void> => {
      rowCount++;
      if (++sinceYield >= EXPORT_YIELD_ROWS) {
        sinceYield = 0;
        await pause();
      }
    };
    const key = (id: number): string => `V${id}`;

    // Vouchers: one row per voucher.
    sink.begin('Vouchers', VOUCHER_COLUMNS);
    for (const m of slices) {
      for (const v of db.iterate<VoucherExportRow>(
        `SELECT v.id, v.date, vt.name AS type_name, v.base_type, v.number, v.reference_no, v.reference_date, v.party_name, v.party_gstin,
                v.place_of_supply, v.narration, v.taxable_amount, v.tax_amount, v.round_off, v.total_amount, v.is_optional, v.is_cancelled,
                v.is_post_dated, v.gst_nature
           FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE ${filter} ORDER BY v.date, v.id`,
        { ...params, ...m },
      )) {
        sink.row([
          key(v.id),
          v.date,
          v.type_name,
          v.base_type,
          v.number,
          v.reference_no,
          v.reference_date,
          v.party_name,
          v.party_gstin,
          v.place_of_supply ? `${v.place_of_supply}-${stateName(v.place_of_supply)}` : null,
          v.narration,
          v.taxable_amount,
          v.tax_amount,
          v.round_off,
          v.total_amount,
          v.is_optional === 1,
          v.is_cancelled === 1,
          v.is_post_dated === 1,
          v.gst_nature,
        ]);
        voucherCount++;
        await tick();
      }
      await pause();
    }
    sink.end();

    // Ledger entries: one row per bill allocation (or per entry without bills) — the layout of the
    // vouchers_ledger import, so the file can be imported back.
    const spec = KIND_SPECS.vouchers_ledger;
    sink.begin('Ledger Entries', spec.columns.map((c) => ({ header: c.header, type: c.type })));
    const refLabel: Record<string, string> = { new: BILL_TYPE_CHOICES[0], against: BILL_TYPE_CHOICES[1], advance: BILL_TYPE_CHOICES[2], on_account: BILL_TYPE_CHOICES[3] };
    let lastVoucher = -1;
    for (const m of slices) {
      for (const e of db.iterate<LedgerExportRow>(
        `SELECT v.id AS voucher_id, v.date, vt.name AS type_name, v.number, l.name AS ledger, le.amount, v.narration,
                le.narration AS entry_narration, v.reference_no, le.instrument_no, le.instrument_date,
                ba.ref_type, ba.bill_name, ba.amount AS bill_amount
           FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
           JOIN ledgers l ON l.id = le.ledger_id
           LEFT JOIN bill_allocations ba ON ba.ledger_entry_id = le.id
          WHERE ${filter}
          ORDER BY v.date, v.id, le.line_no, le.id, ba.id`,
        { ...params, ...m },
      )) {
        // The voucher narration / reference go on its first line only (as the import expects).
        const first = e.voucher_id !== lastVoucher;
        lastVoucher = e.voucher_id;
        const amount = e.bill_amount ?? e.amount;
        const record: Record<string, Value> = {
          key: key(e.voucher_id),
          date: e.date,
          voucherType: e.type_name,
          number: e.number,
          ledger: e.ledger,
          debit: amount > 0 ? amount : null,
          credit: amount < 0 ? -amount : null,
          narration: first ? e.narration : e.entry_narration,
          billType: e.ref_type ? (refLabel[e.ref_type] ?? null) : null,
          billName: e.bill_name,
          instrumentNo: e.instrument_no,
          instrumentDate: e.instrument_date,
          referenceNo: first ? e.reference_no : null,
        };
        sink.row(spec.columns.map((c) => record[c.key] ?? null));
        await tick();
      }
      await pause();
    }
    sink.end();

    // Inventory entries: one row per stock line.
    sink.begin('Inventory Entries', INVENTORY_COLUMNS);
    for (const m of slices) {
      for (const r of db.iterate<InventoryExportRow>(
        `SELECT v.id AS voucher_id, v.date, vt.name AS type_name, v.number, v.party_name, i.name AS item, ie.qty, ie.billed_qty, ie.rate,
                ie.discount_pct, ie.amount, g.name AS godown, ie.batch_name, l.name AS ledger, ie.gst_rate, ie.hsn_sac
           FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
           JOIN stock_items i ON i.id = ie.item_id LEFT JOIN godowns g ON g.id = ie.godown_id LEFT JOIN ledgers l ON l.id = ie.ledger_id
          WHERE ${filter}
          ORDER BY v.date, v.id, ie.line_no`,
        { ...params, ...m },
      )) {
        sink.row([
          key(r.voucher_id),
          r.date,
          r.type_name,
          r.number,
          r.party_name,
          r.item,
          Math.abs(r.billed_qty ?? r.qty),
          r.qty < 0 ? 'Out' : 'In',
          r.rate,
          r.discount_pct || null,
          r.amount,
          r.godown,
          r.batch_name,
          r.ledger,
          r.gst_rate,
          r.hsn_sac,
        ]);
        await tick();
      }
      await pause();
    }
    sink.end();
    sink.finish();
    zip.finish();
    bytes = new Uint8Array(fs.readFileSync(tmp));
  } finally {
    snap.close();
    zip?.abort(); // closes if still open, and deletes the temporary file in every case
  }

  ctx.db.transaction(() =>
    ctx.audit({
      action: 'export',
      entityType: 'vouchers',
      entityLabel: `Vouchers ${formatDate(input.from)} to ${formatDate(input.to)}`,
      after: { format: input.format, vouchers: voucherCount, rows: rowCount, baseTypes: input.baseTypes ?? null },
    }),
  );
  return input.format === 'xlsx'
    ? { bytes, fileName: `${baseName}.xlsx`, mimeType: XLSX_MIME, rowCount }
    : { bytes, fileName: `${baseName}.zip`, mimeType: ZIP_MIME, rowCount };
}

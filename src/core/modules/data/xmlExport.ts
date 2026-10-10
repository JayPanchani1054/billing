/**
 * 'data.xmlExport.create' — the books as a Tally "Import Data" XML file, for the CA / auditor who works in
 * TallyPrime (Gateway of Tally › Import › Masters / Transactions), and for moving back.
 *
 * Shape: ENVELOPE › HEADER (REQUEST_TAG Import Data) › BODY › IMPORTDATA › REQUESTDESC (REPORTNAME
 * "All Masters" or "Vouchers", SVCURRENTCOMPANY) › REQUESTDATA › MESSAGE_TAG* — the shape TallyPrime
 * writes on export and reads on import. Written as UTF-16LE with a BOM (what Tally itself writes, BOM
 * aside; Tally reads both). With masters AND vouchers the result is a ZIP of Masters.xml + Vouchers.xml:
 * Tally imports masters first, then transactions.
 *
 * Masters: user groups, every ledger (opening balance, bill-wise openings, party / GST registration,
 * mailing details, bank details, GST duty heads, effective-dated GST rate details of sales / purchase
 * / income / expense ledgers, aliases), units, user godowns, stock groups (GST details), stock
 * categories, stock items (base unit, alternate unit, costing method, batches, HSN / rate history,
 * opening stock per godown and batch, aliases), cost categories / centres, user voucher types (numbering
 * method, parent). Tally's own predefined groups, "Primary Cost Category" and "Main Location" are not
 * written (Tally has them); our predefined voucher types and groups carry Tally's names.
 *
 * Vouchers (the period; optional / cancelled / post-dated flagged as Tally does): accounting entries
 * (ALLLEDGERENTRIES.LIST, or LEDGERENTRIES.LIST beside inventory lines), bill-wise allocations,
 * cost-centre allocations, bank instrument details, inventory lines with godown / batch allocations
 * and the sales / purchase ledger as ACCOUNTINGALLOCATIONS, stock journal IN / OUT lists, and the GST
 * facts of the invoice (party GSTIN, registration type, place of supply, the duty-ledger postings).
 * Amounts are written AS RECORDED — Tally receives the same tax, round-off and totals.
 *
 * Conventions: Tally amounts are negative for Debit (ours are Dr +), dates 'yyyymmdd', quantities
 * ' 10 Nos', rates '100.00/Nos', '&#4;' marks Tally's logical values ('&#4; Applicable'). Every
 * value is XML-escaped; nothing typed by a user is written as markup.
 *
 * Not written (documented in the module README): quotations / proforma invoices (no Tally voucher
 * type), physical stock vouchers, e-invoice / e-way bill details, per-line GST override tags
 * (TallyPrime takes the rate details from the exported masters), SEZ / deemed export / UIN party types
 * (exported as Regular — set "Party type" in Tally), price lists, BOMs, budgets, scenarios.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PREDEFINED_VOUCHER_TYPES, type VoucherBaseType } from '../../../shared/constants.ts';
import { addDays, formatDate } from '../../../shared/dates.ts';
import { stateName, uqcDescription } from '../../../shared/gst/index.ts';
import type { XmlExportInput, XmlExportMasterCounts, XmlExportResult } from '../../../shared/types/data.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { allocate } from '../../../shared/money.ts';
import { randomToken } from '../../lib/crypto.ts';
import { AppError, validation } from '../../lib/errors.ts';
import { allAliases, extraAliasMap } from '../../lib/masterAliases.ts';
import { escapeAttr, escapeXml } from '../../lib/xml.ts';
import { ZipFileWriter } from '../../lib/zip.ts';
import { STOCK_MOVEMENT_FILTER } from '../inventory/stock.ts';
import { computeStockValuation, traceStockMovements } from '../inventory/valuation.ts';
import { billFromAggregate, loadBillAggregates } from '../outstanding/engine.ts';
import { buildSnapshot, loadReportEnv } from '../reports/engine.ts';
import { fileSlug, requirePermission, yieldToEventLoop } from './common.ts';
import { EXPORT_YIELD_ROWS, openSnapshot } from './exportData.ts';
import { ZIP_MIME } from './exportTable.ts';
import { MESSAGE_TAG, REQUEST_TAG, UDF_NAMESPACE } from './xmlFormat.ts';

export const XML_DATA_MIME = 'application/xml';

// ───────────────────────────── XML writer ─────────────────────────────

/** Tiny indented writer: every text and attribute value goes through escapeXml / escapeAttr. */
class Out {
  readonly parts: string[] = [];
  private depth = 0;

  private pad(): string {
    return ' '.repeat(this.depth);
  }
  open(tag: string, attrs: Record<string, string | null | undefined> = {}): void {
    const a = Object.entries(attrs)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => ` ${k}="${escapeAttr(v as string)}"`)
      .join('');
    this.parts.push(`${this.pad()}<${tag}${a}>\r\n`);
    this.depth++;
  }
  close(tag: string): void {
    this.depth--;
    this.parts.push(`${this.pad()}</${tag}>\r\n`);
  }
  /** <TAG>value</TAG>; skipped for null / undefined / ''. */
  el(tag: string, value: string | number | null | undefined): void {
    if (value === null || value === undefined || value === '') return;
    this.parts.push(`${this.pad()}<${tag}>${escapeXml(String(value))}</${tag}>\r\n`);
  }
  /** A Tally logical value ('&#4; Applicable') — the marker is Tally's own character reference. */
  logical(tag: string, value: string): void {
    this.parts.push(`${this.pad()}<${tag}>&#4; ${escapeXml(value)}</${tag}>\r\n`);
  }
  yesNo(tag: string, v: boolean): void {
    this.el(tag, v ? 'Yes' : 'No');
  }
  list(listTag: string, itemTag: string, values: readonly string[], attrs: Record<string, string> = { TYPE: 'String' }): void {
    if (values.length === 0) return;
    this.open(listTag, attrs);
    for (const v of values) this.el(itemTag, v);
    this.close(listTag);
  }
  /** Name + aliases as Tally's LANGUAGENAME.LIST › NAME.LIST (the first NAME is the name). */
  names(name: string, aliases: readonly string[]): void {
    this.open('LANGUAGENAME.LIST');
    this.list('NAME.LIST', 'NAME', [name, ...aliases]);
    this.el('LANGUAGEID', ' 1033');
    this.close('LANGUAGENAME.LIST');
  }
  text(): string {
    return this.parts.join('');
  }
}

// ───────────────────────────── Value formats ─────────────────────────────

/** Paise (ours, Dr +) → Tally amount text (Dr −): 1044500 → '-10445.00'. */
export function xmlAmountText(ourPaise: number): string {
  const t = -ourPaise;
  const neg = t < 0;
  const abs = Math.abs(t);
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg && abs !== 0 ? `-${body}` : body;
}

/** Paise (positive value) → '24000.00'. */
const rupees = (paise: number): string => xmlAmountText(-Math.abs(paise));

/** 'YYYY-MM-DD' → 'yyyymmdd'. */
export const xmlDateText = (iso: string): string => iso.replace(/-/g, '');

/** Quantity ' 10 Nos' (Tally pads a space); up to 4 decimals, trailing zeros dropped. */
export function xmlQtyText(qty: number, unit: string): string {
  const q = Math.abs(qty);
  const s = Number.isInteger(q) ? String(q) : String(Math.round(q * 10_000) / 10_000);
  return ` ${s} ${unit}`;
}

/** Opening quantity: signed (a negative opening stays negative), else as xmlQtyText. */
function openingQtyText(qty: number, unit: string): string {
  return qty < 0 ? ` -${xmlQtyText(qty, unit).slice(1)}` : xmlQtyText(qty, unit);
}

/** Rate '2950.50/Nos'. */
export function xmlRateText(rate: number, unit: string): string {
  const r = Math.round(rate * 10_000) / 10_000;
  const [i, f = ''] = String(r).split('.');
  return `${i}.${(f + '00').slice(0, Math.max(2, f.length))}/${unit}`;
}

const DUTY_HEAD_XML: Readonly<Record<string, string>> = { IGST: 'Integrated Tax', CGST: 'Central Tax', SGST: 'State Tax', CESS: 'Cess' };
const TAXABILITY_XML: Readonly<Record<string, string>> = { taxable: 'Taxable', exempt: 'Exempt', nil_rated: 'Nil Rated', non_gst: 'Non-GST' };
const REGISTRATION_XML: Readonly<Record<string, string>> = {
  regular: 'Regular',
  composition: 'Composition',
  consumer: 'Consumer',
  unregistered: 'Unregistered',
  // Tally keeps these as a "party type" beside a Regular / Unregistered registration (set it there).
  sez: 'Regular',
  deemed_export: 'Regular',
  uin: 'Regular',
  overseas: 'Unregistered',
};
const COSTING_XML: Readonly<Record<string, string>> = { avg_cost: 'Avg. Cost', fifo: 'FIFO', lifo: 'LIFO', last_purchase: 'Last Purchase Cost', std_cost: 'Std. Cost' };
const NUMBERING_XML: Readonly<Record<string, string>> = { automatic: 'Automatic', automatic_override: 'Automatic (Manual Override)', manual: 'Manual', none: 'None' };
const INSTRUMENT_XML: Readonly<Record<string, string>> = { cheque: 'Cheque', dd: 'DD', neft: 'e-Fund Transfer', rtgs: 'e-Fund Transfer', imps: 'e-Fund Transfer', upi: 'e-Fund Transfer', card: 'Others', cash: 'Others', other: 'Others' };
const BILL_TYPE_XML: Readonly<Record<string, string>> = { new: 'New Ref', against: 'Agst Ref', advance: 'Advance', on_account: 'On Account' };
/** Our base types with a Tally voucher type (quotation / proforma have none; physical stock is not written). */
const XML_TYPE_OF: Partial<Record<VoucherBaseType, string>> = Object.fromEntries(
  PREDEFINED_VOUCHER_TYPES.filter((t) => t.baseType !== 'quotation' && t.baseType !== 'proforma' && t.baseType !== 'physical_stock').map((t) => [t.baseType, t.name]),
);

// ───────────────────────────── Masters ─────────────────────────────

interface GstHistoryRow {
  applicable_from: string;
  hsn_sac: string | null;
  taxability: string;
  rate: number;
  cess_rate: number;
}

function gstHistory(db: Db, entityType: 'ledger' | 'stock_item', id: number): GstHistoryRow[] {
  return db.all<GstHistoryRow>(
    `SELECT applicable_from, hsn_sac, taxability, rate, cess_rate FROM gst_rate_history WHERE entity_type = :t AND entity_id = :id ORDER BY applicable_from`,
    { t: entityType, id },
  );
}

/** GSTDETAILS.LIST rows (effective-dated) of a ledger / stock group / stock item. */
function writeGstDetails(o: Out, rows: readonly GstHistoryRow[]): void {
  for (const r of rows) {
    o.open('GSTDETAILS.LIST');
    o.el('APPLICABLEFROM', xmlDateText(r.applicable_from));
    o.el('HSNCODE', r.hsn_sac);
    o.el('TAXABILITY', TAXABILITY_XML[r.taxability] ?? 'Taxable');
    if (r.taxability === 'taxable') {
      o.open('STATEWISEDETAILS.LIST');
      o.logical('STATENAME', 'Any');
      const rate = (head: string, value: number): void => {
        o.open('RATEDETAILS.LIST');
        o.el('GSTRATEDUTYHEAD', head);
        o.el('GSTRATE', ` ${value}`);
        o.close('RATEDETAILS.LIST');
      };
      rate('Central Tax', r.rate / 2);
      rate('State Tax', r.rate / 2);
      rate('Integrated Tax', r.rate);
      if (r.cess_rate) rate('Cess', r.cess_rate);
      o.close('STATEWISEDETAILS.LIST');
    }
    o.close('GSTDETAILS.LIST');
  }
}

function message(o: Out, write: () => void): void {
  o.open(MESSAGE_TAG, { 'xmlns:UDF': UDF_NAMESPACE });
  write();
  o.close(MESSAGE_TAG);
}

type MasterCounts = XmlExportMasterCounts;

// ───────────────────────────── Openings at the period start ─────────────────────────────

interface OpeningBillRow {
  name: string;
  date: string;
  dueDate: string | null;
  /** Ours, ledger-signed (Dr +). */
  amount: number;
  advance: boolean;
}

interface OpeningStockRow {
  godown: string;
  isPredefined: boolean;
  batch: string | null;
  qty: number;
  /** Paise. */
  value: number;
}

/**
 * Opening balances written on the masters. At the books beginning they are the stored ones (null maps).
 * When vouchers of a LATER period go with the masters, the Tally company starts at that period
 * (books beginning = `asOf`) and the openings must be the balances on that date — otherwise Tally
 * would see the books-beginning openings plus only the period's vouchers:
 *  - ledgers: the Trial Balance opening on `asOf` with `asOf` as the carry-forward date (reports
 *    engine): real ledgers carry their balance; income / expense ledgers start at 0 and everything
 *    they earned before `asOf`, less the stock movement, is in the Profit & Loss A/c opening;
 *  - bill-wise ledgers: the bills pending at the end of the previous day (outstanding engine); a
 *    balance not allocated to any bill becomes one opening bill named "On Account" (bills must add up
 *    to the opening balance, in Tally as here);
 *  - stock: quantity per item, godown and batch at the end of the previous day, valued at the item's
 *    stock value on that date (valuation engine; spread over its godowns / batches by quantity).
 */
interface Openings {
  asOf: string;
  ledgers: Map<number, number> | null;
  bills: Map<number, OpeningBillRow[]> | null;
  stock: Map<number, OpeningStockRow[]> | null;
}

export const ON_ACCOUNT_BILL = 'On Account';

function openingsAt(db: Db, asOf: string, booksFrom: string, today: string): Openings {
  if (asOf <= booksFrom) return { asOf: booksFrom, ledgers: null, bills: null, stock: null };
  const env = loadReportEnv(db, today);
  const snap = buildSnapshot(env, { from: asOf, to: asOf, yearStart: asOf });
  const ledgers = new Map<number, number>();
  for (const [id, b] of snap.ledgers) ledgers.set(id, b.opening);

  const dayBefore = addDays(asOf, -1);
  const billWise = db.all<{ id: number; default_credit_days: number | null }>('SELECT id, default_credit_days FROM ledgers WHERE maintain_bill_wise = 1');
  const aggregates = loadBillAggregates(
    db,
    billWise.map((l) => l.id),
    { asOf: dayBefore, today },
  );
  const bills = new Map<number, OpeningBillRow[]>();
  for (const l of billWise) {
    const list: OpeningBillRow[] = [];
    for (const a of aggregates.get(l.id) ?? []) {
      const b = billFromAggregate(a, { creditDays: l.default_credit_days });
      list.push({ name: a.billName, date: b.billDate ?? dayBefore, dueDate: b.dueDate, amount: a.pending, advance: b.refType === 'advance' });
    }
    list.sort((x, y) => (x.date === y.date ? x.name.localeCompare(y.name) : x.date < y.date ? -1 : 1));
    const rest = (ledgers.get(l.id) ?? 0) - list.reduce((s, b) => s + b.amount, 0);
    if (rest !== 0 && !list.some((b) => b.name.toLowerCase() === ON_ACCOUNT_BILL.toLowerCase())) {
      list.push({ name: ON_ACCOUNT_BILL, date: dayBefore, dueDate: null, amount: rest, advance: false });
    }
    if (list.length > 0) bills.set(l.id, list);
  }

  // Quantity per item / godown / batch at the end of the previous day, and each item's value then.
  const main = db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ?? null;
  const qtyRows = db.all<{ item_id: number; godown: string; is_predefined: number; batch: string | null; qty: number }>(
    `SELECT x.item_id, g.name AS godown, g.is_predefined, x.batch, SUM(x.qty) AS qty
       FROM (SELECT item_id, godown_id, batch_name AS batch, qty FROM stock_openings
             UNION ALL
             SELECT ie.item_id, COALESCE(ie.godown_id, :main), ie.batch_name, ie.qty
               FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
              WHERE ie.date < :asOf AND ${STOCK_MOVEMENT_FILTER}) x
       JOIN godowns g ON g.id = x.godown_id
      GROUP BY x.item_id, x.godown_id, x.batch COLLATE NOCASE
      ORDER BY x.item_id, g.is_predefined DESC, g.name, x.batch`,
    { main, asOf, today },
  );
  const valuation = computeStockValuation(db, { from: asOf, to: asOf, today });
  const valueOf = new Map(valuation.rows.map((r) => [r.itemId, r.opening.value ?? 0] as const));
  const stock = new Map<number, OpeningStockRow[]>();
  for (const r of qtyRows) {
    const qty = Math.round(r.qty * 1e6) / 1e6;
    if (qty === 0) continue;
    const list = stock.get(r.item_id) ?? [];
    list.push({ godown: r.godown, isPredefined: r.is_predefined === 1, batch: r.batch, qty, value: 0 });
    stock.set(r.item_id, list);
  }
  for (const [itemId, list] of stock) {
    const total = list.reduce((s, x) => s + x.qty, 0);
    const value = valueOf.get(itemId) ?? 0;
    if (Math.abs(total) < 1e-9) {
      stock.delete(itemId);
      continue;
    }
    // Spread the item's value over its rows by quantity; the last row takes the rounding.
    let left = value;
    list.forEach((x, i) => {
      x.value = i === list.length - 1 ? left : Math.round((value * x.qty) / total);
      left -= x.value;
    });
  }
  return { asOf, ledgers, bills, stock };
}

function writeMasters(db: Db, booksFrom: string, o: Out, openings: Openings): MasterCounts {
  const counts: MasterCounts = { groups: 0, ledgers: 0, units: 0, godowns: 0, stockGroups: 0, stockCategories: 0, stockItems: 0, costCategories: 0, costCentres: 0, voucherTypes: 0 };

  // Groups created by the user (Tally has the 28 predefined ones under the same names), parents first.
  const groups = db.all<{ id: number; name: string; alias: string | null; parent_name: string | null; nature: string; affects_gross_profit: number; is_subledger: number; parent_id: number | null }>(
    `SELECT g.id, g.name, g.alias, p.name AS parent_name, g.nature, g.affects_gross_profit, g.is_subledger, g.parent_id
       FROM groups g LEFT JOIN groups p ON p.id = g.parent_id WHERE g.is_predefined = 0 ORDER BY g.id`,
  );
  for (const g of parentsFirst(groups)) {
    message(o, () => {
      o.open('GROUP', { NAME: g.name, ACTION: 'Create' });
      if (g.parent_name) o.el('PARENT', g.parent_name);
      else o.logical('PARENT', 'Primary');
      const revenue = g.nature === 'income' || g.nature === 'expense';
      o.yesNo('ISREVENUE', revenue);
      o.yesNo('ISDEEMEDPOSITIVE', g.nature === 'assets' || g.nature === 'expense');
      o.yesNo('AFFECTSGROSSPROFIT', g.affects_gross_profit === 1);
      o.yesNo('ISSUBLEDGER', g.is_subledger === 1);
      o.names(g.name, g.alias ? [g.alias] : []);
      o.close('GROUP');
    });
    counts.groups++;
  }

  // Units (simple units; alternate units are written on the stock items).
  for (const u of db.all<{ symbol: string; formal_name: string | null; uqc: string | null; decimal_places: number }>('SELECT symbol, formal_name, uqc, decimal_places FROM units WHERE is_compound = 0 ORDER BY id')) {
    message(o, () => {
      o.open('UNIT', { NAME: u.symbol, ACTION: 'Create' });
      o.el('NAME', u.symbol);
      o.el('ORIGINALNAME', u.formal_name);
      if (u.uqc) o.el('GSTREPUOM', `${u.uqc}-${uqcDescription(u.uqc).toUpperCase()}`);
      o.yesNo('ISSIMPLEUNIT', true);
      o.el('DECIMALPLACES', ` ${u.decimal_places}`);
      o.close('UNIT');
    });
    counts.units++;
  }

  // Godowns other than "Main Location" (Tally's own), parents first.
  const godowns = db.all<{ id: number; name: string; alias: string | null; parent_name: string | null; address: string | null; parent_id: number | null }>(
    `SELECT g.id, g.name, g.alias, p.name AS parent_name, g.address, g.parent_id FROM godowns g LEFT JOIN godowns p ON p.id = g.parent_id WHERE g.is_predefined = 0 ORDER BY g.id`,
  );
  for (const g of parentsFirst(godowns)) {
    message(o, () => {
      o.open('GODOWN', { NAME: g.name, ACTION: 'Create' });
      o.el('PARENT', g.parent_name ?? '');
      o.list('ADDRESS.LIST', 'ADDRESS', (g.address ?? '').split(/\r?\n|,\s*/).map((s) => s.trim()).filter(Boolean));
      o.names(g.name, g.alias ? [g.alias] : []);
      o.close('GODOWN');
    });
    counts.godowns++;
  }

  // Stock groups and categories.
  const sgroups = db.all<{ id: number; name: string; alias: string | null; parent_name: string | null; parent_id: number | null; add_quantities: number; gst_applicable: string; hsn_sac: string | null; gst_taxability: string | null; gst_rate: number | null; cess_rate: number | null }>(
    `SELECT g.id, g.name, g.alias, p.name AS parent_name, g.parent_id, g.add_quantities, g.gst_applicable, g.hsn_sac, g.gst_taxability, g.gst_rate, g.cess_rate
       FROM stock_groups g LEFT JOIN stock_groups p ON p.id = g.parent_id ORDER BY g.id`,
  );
  for (const g of parentsFirst(sgroups)) {
    message(o, () => {
      o.open('STOCKGROUP', { NAME: g.name, ACTION: 'Create' });
      o.el('PARENT', g.parent_name ?? '');
      o.yesNo('ISADDABLE', g.add_quantities === 1);
      if (g.gst_applicable === 'applicable' && (g.gst_rate !== null || g.hsn_sac)) {
        o.logical('GSTAPPLICABLE', 'Applicable');
        writeGstDetails(o, [{ applicable_from: booksFrom, hsn_sac: g.hsn_sac, taxability: g.gst_taxability ?? 'taxable', rate: g.gst_rate ?? 0, cess_rate: g.cess_rate ?? 0 }]);
      }
      o.names(g.name, g.alias ? [g.alias] : []);
      o.close('STOCKGROUP');
    });
    counts.stockGroups++;
  }
  const cats = db.all<{ id: number; name: string; alias: string | null; parent_name: string | null; parent_id: number | null }>(
    'SELECT c.id, c.name, c.alias, p.name AS parent_name, c.parent_id FROM stock_categories c LEFT JOIN stock_categories p ON p.id = c.parent_id ORDER BY c.id',
  );
  for (const c of parentsFirst(cats)) {
    message(o, () => {
      o.open('STOCKCATEGORY', { NAME: c.name, ACTION: 'Create' });
      o.el('PARENT', c.parent_name ?? '');
      o.names(c.name, c.alias ? [c.alias] : []);
      o.close('STOCKCATEGORY');
    });
    counts.stockCategories++;
  }

  // Cost categories (not Tally's "Primary Cost Category") and cost centres.
  for (const c of db.all<{ name: string; allocate_revenue: number; allocate_non_revenue: number }>('SELECT name, allocate_revenue, allocate_non_revenue FROM cost_categories WHERE is_predefined = 0 ORDER BY id')) {
    message(o, () => {
      o.open('COSTCATEGORY', { NAME: c.name, ACTION: 'Create' });
      o.yesNo('ALLOCATEREVENUE', c.allocate_revenue === 1);
      o.yesNo('ALLOCATENONREVENUE', c.allocate_non_revenue === 1);
      o.close('COSTCATEGORY');
    });
    counts.costCategories++;
  }
  const centres = db.all<{ id: number; name: string; alias: string | null; parent_name: string | null; parent_id: number | null; category: string }>(
    `SELECT c.id, c.name, c.alias, p.name AS parent_name, c.parent_id, k.name AS category
       FROM cost_centres c JOIN cost_categories k ON k.id = c.category_id LEFT JOIN cost_centres p ON p.id = c.parent_id ORDER BY c.id`,
  );
  for (const c of parentsFirst(centres)) {
    message(o, () => {
      o.open('COSTCENTRE', { NAME: c.name, ACTION: 'Create' });
      o.el('PARENT', c.parent_name ?? '');
      o.el('CATEGORY', c.category);
      o.names(c.name, c.alias ? [c.alias] : []);
      o.close('COSTCENTRE');
    });
    counts.costCentres++;
  }

  // Ledgers.
  const ledgerAliases = extraAliasMap(db, 'ledger');
  const ledgers = db.all<Record<string, unknown> & { id: number; name: string; alias: string | null; group_name: string; reserved_code: string | null; opening_balance: number }>(
    'SELECT l.*, g.name AS group_name FROM ledgers l JOIN groups g ON g.id = l.group_id ORDER BY l.id',
  );
  for (const l of ledgers) {
    const opening = openings.ledgers ? (openings.ledgers.get(l.id) ?? 0) : l.opening_balance;
    if (l.reserved_code === 'PROFIT_LOSS' && opening === 0) continue; // Tally has its own
    const str = (k: string): string | null => (typeof l[k] === 'string' && (l[k] as string).trim() !== '' ? (l[k] as string) : null);
    const num = (k: string): number | null => (typeof l[k] === 'number' ? (l[k] as number) : null);
    message(o, () => {
      const reserved = l.reserved_code === 'CASH' ? 'Cash' : l.reserved_code === 'PROFIT_LOSS' ? 'Profit & Loss A/c' : null;
      o.open('LEDGER', { NAME: l.name, ...(reserved ? { RESERVEDNAME: reserved } : {}), ACTION: 'Create' });
      // Tally's own Profit & Loss A/c sits at the top of the chart (Primary), not under a group.
      if (l.reserved_code === 'PROFIT_LOSS') o.logical('PARENT', 'Primary');
      else o.el('PARENT', l.group_name);
      o.el('OPENINGBALANCE', xmlAmountText(opening));
      const billWise = num('maintain_bill_wise') === 1;
      o.yesNo('ISBILLWISEON', billWise);
      if (num('default_credit_days') !== null) o.el('BILLCREDITPERIOD', `${num('default_credit_days')} Days`);
      if (num('credit_limit')) o.el('CREDITLIMIT', xmlAmountText(num('credit_limit') as number));
      o.yesNo('ISCOSTCENTRESON', num('cost_centres_applicable') === 1);
      o.yesNo('AFFECTSSTOCK', num('inventory_values_affected') === 1);
      // Mailing and party details (classic tags, read by every Tally version).
      o.el('MAILINGNAME', str('mailing_name'));
      const address = (str('address') ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      o.list('ADDRESS.LIST', 'ADDRESS', address);
      const state = str('state_code') ? stateName(l.state_code as string) : null;
      o.el('LEDSTATENAME', state);
      o.el('COUNTRYNAME', str('country'));
      o.el('PINCODE', str('pincode'));
      o.el('LEDGERCONTACT', str('contact_person'));
      o.el('LEDGERPHONE', str('phone'));
      o.el('LEDGERMOBILE', str('mobile'));
      o.el('EMAIL', str('email'));
      o.el('INCOMETAXNUMBER', str('pan'));
      const reg = str('gst_registration_type');
      if (reg) o.el('GSTREGISTRATIONTYPE', REGISTRATION_XML[reg] ?? 'Unknown');
      o.el('PARTYGSTIN', str('gstin'));
      // TallyPrime keeps registration and mailing details effective-dated as well.
      if (reg || str('gstin')) {
        o.open('LEDGSTREGDETAILS.LIST');
        o.el('APPLICABLEFROM', xmlDateText(booksFrom));
        if (reg) o.el('GSTREGISTRATIONTYPE', REGISTRATION_XML[reg] ?? 'Unknown');
        o.el('STATE', state);
        o.el('GSTIN', str('gstin'));
        o.close('LEDGSTREGDETAILS.LIST');
      }
      // Bank details.
      o.el('BANKDETAILS', str('bank_account_no'));
      o.el('IFSCODE', str('bank_ifsc'));
      o.el('BANKINGCONFIGBANK', str('bank_name'));
      o.el('BRANCHNAME', str('bank_branch'));
      o.el('BANKACCHOLDERNAME', str('bank_account_holder'));
      // Duties & taxes.
      const taxType = str('tax_type');
      if (taxType) o.el('TAXTYPE', taxType === 'OTHER' ? 'Others' : taxType);
      const head = str('gst_duty_head');
      if (head) o.el('GSTDUTYHEAD', DUTY_HEAD_XML[head] ?? head);
      // A charge included in the goods' / services' assessable value (freight, packing): Tally's
      // "Include in assessable value calculation — Appropriate to — Method of appropriation"
      // (tag names as in Tally exports we have seen; not verified against a live TallyPrime).
      const assessable = str('include_in_assessable');
      if (assessable === 'goods' || assessable === 'services') {
        o.el('APPROPRIATEFOR', 'GST');
        o.el('GSTAPPROPRIATETO', assessable === 'goods' ? 'Goods' : 'Services');
        o.el('EXCISEALLOCTYPE', str('appropriate_by') === 'quantity' ? 'Based on Quantity' : 'Based on Value');
      }
      // GST rate details of sales / purchase / income / expense ledgers.
      if (str('gst_applicable') === 'applicable') {
        const hist = gstHistory(db, 'ledger', l.id);
        const taxability = str('gst_taxability') ?? 'taxable';
        const rows: GstHistoryRow[] =
          hist.length > 0
            ? hist
            : num('gst_rate') !== null || taxability !== 'taxable'
              ? [{ applicable_from: booksFrom, hsn_sac: str('hsn_sac'), taxability, rate: num('gst_rate') ?? 0, cess_rate: num('cess_rate') ?? 0 }]
              : [];
        // Without a rate of its own the ledger takes the items' rates: GSTAPPLICABLE is left out, as above.
        if (rows.length > 0) {
          o.logical('GSTAPPLICABLE', 'Applicable');
          const supply = str('gst_supply_type');
          if (supply) o.el('GSTTYPEOFSUPPLY', supply === 'services' ? 'Services' : 'Goods');
          writeGstDetails(o, rows);
        }
      }
      // Bill-wise opening balance.
      if (billWise) {
        const bills: OpeningBillRow[] = openings.bills
          ? (openings.bills.get(l.id) ?? [])
          : db
              .all<{ bill_name: string; bill_date: string; due_date: string | null; amount: number }>(
                'SELECT bill_name, bill_date, due_date, amount FROM opening_bills WHERE ledger_id = :id ORDER BY bill_date, id',
                { id: l.id },
              )
              .map((b) => ({ name: b.bill_name, date: b.bill_date, dueDate: b.due_date, amount: b.amount, advance: false }));
        for (const b of bills) {
          o.open('BILLALLOCATIONS.LIST');
          o.el('NAME', b.name);
          o.el('BILLDATE', xmlDateText(b.date));
          if (b.dueDate) o.el('BILLCREDITPERIOD', `${Math.max(0, daysBetween(b.date, b.dueDate))} Days`);
          o.yesNo('ISADVANCE', b.advance);
          o.el('OPENINGBALANCE', xmlAmountText(b.amount));
          o.close('BILLALLOCATIONS.LIST');
        }
      }
      o.names(l.name, allAliases(l.alias, ledgerAliases.get(l.id)));
      o.close('LEDGER');
    });
    counts.ledgers++;
  }

  // Stock items.
  const itemAliases = extraAliasMap(db, 'stock_item');
  const items = db.all<{
    id: number;
    name: string;
    alias: string | null;
    part_no: string | null;
    description: string | null;
    group_name: string | null;
    category_name: string | null;
    unit: string;
    alt_unit: string | null;
    alt_conversion: number | null;
    maintain_batches: number;
    costing_method: string;
    gst_applicable: string;
    hsn_sac: string | null;
    gst_taxability: string;
    gst_rate: number | null;
    cess_rate: number | null;
    is_service: number;
  }>(
    `SELECT i.id, i.name, i.alias, i.part_no, i.description, g.name AS group_name, c.name AS category_name, u.symbol AS unit, au.symbol AS alt_unit,
            i.alt_conversion, i.maintain_batches, i.costing_method, i.gst_applicable, i.hsn_sac, i.gst_taxability, i.gst_rate, i.cess_rate, i.is_service
       FROM stock_items i JOIN units u ON u.id = i.unit_id LEFT JOIN units au ON au.id = i.alt_unit_id
       LEFT JOIN stock_groups g ON g.id = i.group_id LEFT JOIN stock_categories c ON c.id = i.category_id ORDER BY i.id`,
  );
  for (const it of items) {
    const stockOpenings: OpeningStockRow[] = openings.stock
      ? (openings.stock.get(it.id) ?? [])
      : db
          .all<{ godown: string; is_predefined: number; batch_name: string | null; qty: number; value: number }>(
            'SELECT g.name AS godown, g.is_predefined, o.batch_name, o.qty, o.value FROM stock_openings o JOIN godowns g ON g.id = o.godown_id WHERE o.item_id = :id ORDER BY o.id',
            { id: it.id },
          )
          .map((r) => ({ godown: r.godown, isPredefined: r.is_predefined === 1, batch: r.batch_name, qty: r.qty, value: r.value }));
    message(o, () => {
      o.open('STOCKITEM', { NAME: it.name, ACTION: 'Create' });
      o.el('PARENT', it.group_name ?? '');
      if (it.category_name) o.el('CATEGORY', it.category_name);
      else o.logical('CATEGORY', 'Not Applicable');
      o.el('DESCRIPTION', it.description);
      if (it.part_no) o.list('MAILINGNAME.LIST', 'MAILINGNAME', [it.part_no]);
      o.el('BASEUNITS', it.unit);
      if (it.alt_unit && it.alt_conversion) {
        // "1 <alt unit> = <conversion> <base units>" (uncertain tag semantics — see README).
        o.el('ADDITIONALUNITS', it.alt_unit);
        o.el('DENOMINATOR', ' 1');
        o.el('CONVERSION', ` ${it.alt_conversion}`);
      }
      o.el('COSTINGMETHOD', COSTING_XML[it.costing_method] ?? 'Avg. Cost');
      o.yesNo('ISBATCHWISEON', it.maintain_batches === 1);
      const itemHist = it.gst_applicable === 'applicable' ? gstHistory(db, 'stock_item', it.id) : [];
      const itemRows: GstHistoryRow[] =
        itemHist.length > 0
          ? itemHist
          : it.gst_applicable === 'applicable' && (it.gst_rate !== null || it.gst_taxability !== 'taxable')
            ? [{ applicable_from: booksFrom, hsn_sac: it.hsn_sac, taxability: it.gst_taxability, rate: it.gst_rate ?? 0, cess_rate: it.cess_rate ?? 0 }]
            : [];
      // Own GST details only when the item has them; without a rate it follows its stock group /
      // the sales ledger — in Tally that is GSTAPPLICABLE left out ("Applicable" with no details).
      if (itemRows.length > 0) {
        o.logical('GSTAPPLICABLE', 'Applicable');
        o.el('GSTTYPEOFSUPPLY', it.is_service === 1 ? 'Services' : 'Goods');
        writeGstDetails(o, itemRows);
      } else if (it.gst_applicable !== 'applicable') {
        o.logical('GSTAPPLICABLE', 'Not Applicable');
      }
      const qty = stockOpenings.reduce((s, x) => s + x.qty, 0);
      const value = stockOpenings.reduce((s, x) => s + x.value, 0);
      if (stockOpenings.length > 0 && qty !== 0) {
        o.el('OPENINGBALANCE', openingQtyText(qty, it.unit));
        o.el('OPENINGVALUE', xmlAmountText(value));
        o.el('OPENINGRATE', xmlRateText(value / 100 / qty, it.unit));
        for (const op of stockOpenings) {
          o.open('BATCHALLOCATIONS.LIST');
          o.el('GODOWNNAME', op.isPredefined ? 'Main Location' : op.godown);
          o.el('BATCHNAME', op.batch ?? 'Primary Batch');
          o.el('OPENINGBALANCE', openingQtyText(op.qty, it.unit));
          o.el('OPENINGVALUE', xmlAmountText(op.value));
          o.el('OPENINGRATE', xmlRateText(op.qty !== 0 ? op.value / 100 / op.qty : 0, it.unit));
          o.close('BATCHALLOCATIONS.LIST');
        }
      }
      o.names(it.name, allAliases(it.alias, itemAliases.get(it.id)));
      o.close('STOCKITEM');
    });
    counts.stockItems++;
  }

  // Voucher types created by the user (Tally has the predefined ones under the same names).
  const vts = db.all<{ id: number; name: string; alias: string | null; abbreviation: string | null; base_type: VoucherBaseType; parent_name: string | null; parent_id: number | null; is_active: number; numbering_method: string }>(
    `SELECT t.id, t.name, t.alias, t.abbreviation, t.base_type, p.name AS parent_name, t.parent_id, t.is_active, t.numbering_method
       FROM voucher_types t LEFT JOIN voucher_types p ON p.id = t.parent_id WHERE t.is_predefined = 0 ORDER BY t.id`,
  );
  for (const t of parentsFirst(vts)) {
    if (!XML_TYPE_OF[t.base_type]) continue;
    message(o, () => {
      o.open('VOUCHERTYPE', { NAME: t.name, ACTION: 'Create' });
      o.el('PARENT', t.parent_name ?? XML_TYPE_OF[t.base_type]);
      o.el('NUMBERINGMETHOD', NUMBERING_XML[t.numbering_method] ?? 'Automatic');
      o.yesNo('ISACTIVE', t.is_active === 1);
      o.el('ABBR', t.abbreviation);
      o.names(t.name, t.alias ? [t.alias] : []);
      o.close('VOUCHERTYPE');
    });
    counts.voucherTypes++;
  }
  return counts;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000);
}

/** Records ordered so that a parent always comes before its children (Tally creates in file order). */
function parentsFirst<T extends { id: number; parent_id: number | null }>(rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  const done = new Set<number>();
  const visit = (r: T, depth: number): void => {
    if (done.has(r.id) || depth > 64) return;
    const p = r.parent_id !== null ? byId.get(r.parent_id) : undefined;
    if (p) visit(p, depth + 1);
    done.add(r.id);
    out.push(r);
  };
  for (const r of rows) visit(r, 0);
  return out;
}

// ───────────────────────────── Vouchers ─────────────────────────────

interface VoucherCounts {
  vouchers: number;
  /** Not written, by reason. */
  skipped: Array<{ reason: string; count: number }>;
}

interface VRow {
  id: number;
  guid: string;
  type_name: string;
  base_type: VoucherBaseType;
  number: string | null;
  date: string;
  effective_date: string | null;
  reference_no: string | null;
  reference_date: string | null;
  original_invoice_no: string | null;
  original_invoice_date: string | null;
  party_name: string | null;
  party_ledger: string | null;
  party_gstin: string | null;
  party_registration_type: string | null;
  place_of_supply: string | null;
  invoice_mode: string | null;
  is_optional: number;
  is_post_dated: number;
  is_cancelled: number;
  narration: string | null;
}

interface LeRow {
  id: number;
  ledger_id: number;
  ledger: string;
  amount: number;
  instrument_type: string | null;
  instrument_no: string | null;
  instrument_date: string | null;
  bank_name: string | null;
  favouring: string | null;
  bank_date: string | null;
}

interface IeRow {
  id: number;
  line_no: number;
  item: string;
  unit: string;
  godown: string;
  godown_predefined: number;
  batch_name: string | null;
  qty: number;
  billed_qty: number | null;
  rate: number;
  discount_pct: number;
  amount: number;
  ledger_id: number | null;
  ledger: string | null;
  tracking_ref: string | null;
  order_ref: string | null;
  is_consumption: number;
}

interface BillRow {
  ledger_entry_id: number;
  ref_type: string;
  bill_name: string | null;
  amount: number;
  credit_days: number | null;
}

/** A cost-centre allocation (ours, signed like its entry). */
interface CostSlice {
  centre: string;
  category: string;
  amount: number;
}

/** Group rows by a numeric key (one pass, order kept). */
function groupBy<T>(rows: readonly T[], keyOf: (r: T) => number): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * Take allocations worth `amount` (signed) from the front of `queue` (same sign only), splitting a
 * centre's allocation where needed — so the cost-centre split of a ledger whose posting is spread
 * over several inventory lines and its own entry adds up in each of them.
 */
function takeCosts(queue: CostSlice[], amount: number): CostSlice[] {
  const out: CostSlice[] = [];
  let need = amount;
  while (need !== 0 && queue.length > 0) {
    const s = queue[0];
    if (Math.sign(s.amount) !== Math.sign(need)) break;
    const t = Math.abs(s.amount) <= Math.abs(need) ? s.amount : need;
    out.push({ centre: s.centre, category: s.category, amount: t });
    s.amount -= t;
    need -= t;
    if (s.amount === 0) queue.shift();
  }
  return out;
}

/** CATEGORYALLOCATIONS.LIST › COSTCENTREALLOCATIONS.LIST, grouped by category. */
function writeCostAllocations(o: Out, costs: readonly CostSlice[], deemedPositive: boolean): void {
  const byCat = new Map<string, CostSlice[]>();
  for (const c of costs) {
    const list = byCat.get(c.category);
    if (list) list.push(c);
    else byCat.set(c.category, [c]);
  }
  for (const [category, list] of byCat) {
    o.open('CATEGORYALLOCATIONS.LIST');
    o.el('CATEGORY', category);
    o.yesNo('ISDEEMEDPOSITIVE', deemedPositive);
    for (const c of list) {
      o.open('COSTCENTREALLOCATIONS.LIST');
      o.el('NAME', c.centre);
      o.el('AMOUNT', xmlAmountText(c.amount));
      o.close('COSTCENTREALLOCATIONS.LIST');
    }
    o.close('CATEGORYALLOCATIONS.LIST');
  }
}

/**
 * Stock values of the lines of manufacturing / job work journals (stock journals with a costing basis,
 * mfg module) as the valuation engine applies them NOW — by inventory_entries id. The amounts stored on
 * such a journal are the estimate made when it was saved; a later back-dated purchase or alteration
 * re-values the production in every stock report (inventory/valuation.ts), so the file carries the
 * engine's figures: the Tally company (and our importer, which takes a stock journal's inward values as
 * written) then holds the same closing stock. One replay, only when the period has such journals.
 */
function journalCosts(db: Db, from: string, to: string, today: string): Map<number, number> {
  const items = db
    .all<{ item_id: number }>(
      `SELECT DISTINCT ie.item_id FROM inventory_entries ie
        WHERE ie.date BETWEEN :from AND :to AND ie.voucher_id IN (SELECT voucher_id FROM stock_journal_lines WHERE basis IS NOT NULL)`,
      { from, to },
    )
    .map((r) => r.item_id);
  if (items.length === 0) return new Map();
  const journals = new Set(
    db.all<{ id: number }>(`SELECT DISTINCT voucher_id AS id FROM stock_journal_lines WHERE basis IS NOT NULL`).map((r) => r.id),
  );
  const trace = traceStockMovements(db, { from, to, today, traceItemIds: items, traceFrom: from });
  const out = new Map<number, number>();
  for (const m of trace.movements) {
    const value = trace.values.get(m.id);
    if (value !== undefined && journals.has(m.voucherId)) out.set(m.id, value);
  }
  return out;
}

/** A stock-journal line at its engine value (rate = value ÷ quantity), else as recorded. */
function withCost(r: IeRow, costs: ReadonlyMap<number, number>): IeRow {
  const value = costs.get(r.id);
  if (value === undefined || value === r.amount) return r;
  const qty = Math.abs(r.qty);
  return { ...r, amount: value, rate: qty > 0 ? Math.round((value / 100 / qty) * 1e4) / 1e4 : r.rate, discount_pct: 0 };
}

/**
 * Writes the period's vouchers one message element (MESSAGE_TAG) at a time through `emit` (constant memory), in
 * batches of VOUCHER_BATCH vouchers whose entries, stock lines, bills and cost allocations are read
 * with one query each (no per-voucher queries), calling `pause` every EXPORT_YIELD_ROWS vouchers so a
 * long export does not block the worker.
 */
async function writeVouchers(db: Db, from: string, to: string, today: string, emit: (text: string) => void, pause: () => Promise<void>): Promise<VoucherCounts> {
  const costs = journalCosts(db, from, to, today);
  const skipped = new Map<string, number>();
  const skip = (reason: string): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };
  let count = 0;
  let sinceYield = 0;
  const ids = db.all<{ id: number }>('SELECT id FROM vouchers WHERE date BETWEEN :from AND :to ORDER BY date, id', { from, to }).map((r) => r.id);
  for (let at = 0; at < ids.length; at += VOUCHER_BATCH) {
    const batch = JSON.stringify(ids.slice(at, at + VOUCHER_BATCH));
    const vouchers = db.all<VRow>(
      `SELECT v.id, v.guid, t.name AS type_name, v.base_type, v.number, v.date, v.effective_date, v.reference_no, v.reference_date,
              v.original_invoice_no, v.original_invoice_date, v.party_name, pl.name AS party_ledger, v.party_gstin, v.party_registration_type, v.place_of_supply, v.invoice_mode,
              v.is_optional, v.is_post_dated, v.is_cancelled, v.narration
         FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
        WHERE v.id IN (SELECT value FROM json_each(:ids)) ORDER BY v.date, v.id`,
      { ids: batch },
    );
    const entriesOf = groupBy(
      db.all<LeRow & { voucher_id: number }>(
        `SELECT e.voucher_id, e.id, e.ledger_id, l.name AS ledger, e.amount, e.instrument_type, e.instrument_no, e.instrument_date, e.bank_name, e.favouring, e.bank_date
           FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id IN (SELECT value FROM json_each(:ids)) ORDER BY e.voucher_id, e.line_no, e.id`,
        { ids: batch },
      ),
      (r) => r.voucher_id,
    );
    const inventoryOf = groupBy(
      db.all<IeRow & { voucher_id: number }>(
        `SELECT ie.voucher_id, ie.id, ie.line_no, i.name AS item, u.symbol AS unit, g.name AS godown, g.is_predefined AS godown_predefined, ie.batch_name, ie.qty, ie.billed_qty,
                ie.rate, ie.discount_pct, ie.amount, ie.ledger_id, l.name AS ledger, ie.tracking_ref, ie.order_ref, ie.is_consumption
           FROM inventory_entries ie JOIN stock_items i ON i.id = ie.item_id JOIN units u ON u.id = i.unit_id
           LEFT JOIN godowns g ON g.id = ie.godown_id LEFT JOIN ledgers l ON l.id = ie.ledger_id
          WHERE ie.voucher_id IN (SELECT value FROM json_each(:ids)) ORDER BY ie.voucher_id, ie.line_no, ie.id`,
        { ids: batch },
      ),
      (r) => r.voucher_id,
    );
    const billsOf = groupBy(
      db.all<BillRow>(
        `SELECT ledger_entry_id, ref_type, bill_name, amount, credit_days FROM bill_allocations
          WHERE voucher_id IN (SELECT value FROM json_each(:ids)) AND ledger_entry_id IS NOT NULL ORDER BY ledger_entry_id, id`,
        { ids: batch },
      ),
      (r) => r.ledger_entry_id,
    );
    const costsOf = groupBy(
      db.all<CostSlice & { ledger_entry_id: number }>(
        `SELECT a.ledger_entry_id, c.name AS centre, k.name AS category, a.amount FROM cost_allocations a JOIN cost_centres c ON c.id = a.cost_centre_id
           JOIN cost_categories k ON k.id = c.category_id WHERE a.voucher_id IN (SELECT value FROM json_each(:ids)) AND a.ledger_entry_id IS NOT NULL
          ORDER BY a.ledger_entry_id, k.name, a.id`,
        { ids: batch },
      ),
      (r) => r.ledger_entry_id,
    );
    for (const v of vouchers) {
      const xmlBase = XML_TYPE_OF[v.base_type];
      if (!xmlBase) {
        skip(v.base_type === 'physical_stock' ? 'Physical stock vouchers (enter the counted stock in Tally)' : 'Quotations and proforma invoices (Tally has no such voucher type)');
        continue;
      }
      const entries: LeRow[] = v.is_cancelled ? [] : (entriesOf.get(v.id) ?? []);
      const inventory: IeRow[] = v.is_cancelled ? [] : (inventoryOf.get(v.id) ?? []).map((r) => withCost(r, costs));
      const o = new Out();
      const isInvoice = v.invoice_mode !== null || inventory.length > 0;
      const view = v.base_type === 'stock_journal' ? 'Consumption Voucher View' : inventory.length > 0 ? 'Invoice Voucher View' : 'Accounting Voucher View';
      message(o, () => {
        o.open('VOUCHER', { REMOTEID: v.guid, VCHTYPE: v.type_name, ACTION: 'Create', OBJVIEW: view });
        o.el('DATE', xmlDateText(v.date));
        if (v.effective_date && v.effective_date !== v.date) o.el('EFFECTIVEDATE', xmlDateText(v.effective_date));
        o.el('GUID', v.guid);
        o.el('VOUCHERTYPENAME', v.type_name);
        o.el('VOUCHERNUMBER', v.number);
        // A note's Reference No. / Date carry the original invoice (what the accountant enters there in Tally).
        const isNote = v.base_type === 'credit_note' || v.base_type === 'debit_note';
        const ref = isNote ? (v.original_invoice_no ?? v.reference_no) : v.reference_no;
        const refDate = isNote ? (v.original_invoice_date ?? v.reference_date) : v.reference_date;
        o.el('REFERENCE', ref);
        if (refDate) o.el('REFERENCEDATE', xmlDateText(refDate));
        o.el('PARTYLEDGERNAME', v.party_ledger);
        o.el('PARTYNAME', v.party_name ?? v.party_ledger);
        o.el('PARTYGSTIN', v.party_gstin);
        if (v.party_registration_type) o.el('GSTREGISTRATIONTYPE', REGISTRATION_XML[v.party_registration_type] ?? 'Unknown');
        if (v.place_of_supply && v.place_of_supply !== '96') o.el('PLACEOFSUPPLY', stateName(v.place_of_supply));
        o.el('NARRATION', v.narration);
        o.el('PERSISTEDVIEW', view);
        o.yesNo('ISINVOICE', isInvoice);
        o.yesNo('ISOPTIONAL', v.is_optional === 1);
        o.yesNo('ISCANCELLED', v.is_cancelled === 1);
        o.yesNo('ISPOSTDATED', v.is_post_dated === 1);

        // Inventory lines (grouped by line; one batch allocation per godown / batch row).
        const lines = [...groupBy(inventory, (r) => r.line_no).values()];
        const ledgerTotal = new Map<number, number>();
        for (const e of entries) ledgerTotal.set(e.ledger_id, (ledgerTotal.get(e.ledger_id) ?? 0) + e.amount);
        const carries = (rows: readonly IeRow[]): boolean => rows[0].ledger_id !== null && rows[0].ledger !== null && entries.length > 0 && (ledgerTotal.get(rows[0].ledger_id) ?? 0) !== 0;
        // Each line's share (unsigned) of its sales / purchase ledger posting — the ACCOUNTINGALLOCATIONS
        // and the item amount. Normally the line value. Charges absorbed into the goods' assessable
        // value (freight "included in assessable value") are in the line value but posted to their
        // own ledger: the ledger's posting is then spread over its lines by value, so the voucher
        // balances exactly as recorded.
        const share = new Map<IeRow[], number>();
        const lineValue = (rows: readonly IeRow[]): number => rows.reduce((s, r) => s + r.amount, 0);
        for (const [ledgerId, group] of groupBy(lines.filter(carries), (rows) => rows[0].ledger_id as number)) {
          const values = group.map(lineValue);
          const posted = Math.abs(ledgerTotal.get(ledgerId) ?? 0);
          const parts = values.reduce((a, b) => a + b, 0) <= posted ? values : allocate(posted, values);
          group.forEach((rows, i) => share.set(rows, parts[i]));
        }
        // Cost-centre allocations of the ledgers the inventory lines carry: handed out to the
        // ACCOUNTINGALLOCATIONS first, the rest to the ledger's own entry.
        const carried = new Set(lines.filter(carries).map((rows) => rows[0].ledger_id as number));
        const costQueue = new Map<number, CostSlice[]>();
        for (const e of entries) {
          if (!carried.has(e.ledger_id)) continue;
          const q = costQueue.get(e.ledger_id) ?? [];
          for (const c of costsOf.get(e.id) ?? []) q.push({ centre: c.centre, category: c.category, amount: c.amount });
          costQueue.set(e.ledger_id, q);
        }
        const allocated = new Map<number, number>();
        const stockJournal = v.base_type === 'stock_journal';
        for (const rows of lines) {
          const first = rows[0];
          const qty = rows.reduce((s, r) => s + r.qty, 0);
          const amount = lineValue(rows);
          const value = share.get(rows) ?? amount;
          const total = first.ledger_id !== null ? (ledgerTotal.get(first.ledger_id) ?? 0) : 0;
          const inward = stockJournal ? first.is_consumption !== 1 : qty > 0 || (qty === 0 && Math.sign(total) > 0);
          // Our signed value of this line's ledger posting (Dr + for inward / purchase-side lines).
          const sign = first.ledger_id !== null && total !== 0 ? Math.sign(total) : inward ? 1 : -1;
          const signed = sign * value;
          const rowValues = value === amount ? rows.map((r) => r.amount) : allocate(value, rows.map((r) => r.amount));
          const tag = stockJournal ? (inward ? 'INVENTORYENTRIESIN.LIST' : 'INVENTORYENTRIESOUT.LIST') : 'ALLINVENTORYENTRIES.LIST';
          o.open(tag);
          o.el('STOCKITEMNAME', first.item);
          o.yesNo('ISDEEMEDPOSITIVE', inward);
          if (first.rate) o.el('RATE', xmlRateText(first.rate, first.unit));
          if (first.discount_pct) o.el('DISCOUNT', ` ${first.discount_pct}`);
          o.el('AMOUNT', xmlAmountText(signed));
          o.el('ACTUALQTY', xmlQtyText(qty, first.unit));
          const billed = rows.reduce((s, r) => s + Math.abs(r.billed_qty ?? r.qty), 0);
          o.el('BILLEDQTY', xmlQtyText(billed, first.unit));
          rows.forEach((r, i) => {
            o.open('BATCHALLOCATIONS.LIST');
            o.el('GODOWNNAME', r.godown_predefined === 1 || !r.godown ? 'Main Location' : r.godown);
            o.el('BATCHNAME', r.batch_name ?? 'Primary Batch');
            o.el('TRACKINGNUMBER', r.tracking_ref);
            o.el('ORDERNO', r.order_ref);
            o.el('AMOUNT', xmlAmountText(sign * rowValues[i]));
            o.el('ACTUALQTY', xmlQtyText(r.qty, first.unit));
            o.el('BILLEDQTY', xmlQtyText(r.billed_qty ?? r.qty, first.unit));
            o.close('BATCHALLOCATIONS.LIST');
          });
          if (carries(rows)) {
            const ledgerId = first.ledger_id as number;
            o.open('ACCOUNTINGALLOCATIONS.LIST');
            o.el('LEDGERNAME', first.ledger);
            o.yesNo('ISDEEMEDPOSITIVE', signed > 0);
            o.el('AMOUNT', xmlAmountText(signed));
            writeCostAllocations(o, takeCosts(costQueue.get(ledgerId) ?? [], signed), signed > 0);
            o.close('ACCOUNTINGALLOCATIONS.LIST');
            allocated.set(ledgerId, (allocated.get(ledgerId) ?? 0) + signed);
          }
          o.close(tag);
        }

        // Ledger entries (what the inventory lines did not already carry).
        const entryTag = lines.length > 0 ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
        const remaining = new Map<number, number>(allocated);
        for (const e of entries) {
          let amount = e.amount;
          const left = remaining.get(e.ledger_id) ?? 0;
          if (left !== 0) {
            // Take the carried part out of this ledger's entries (in order, never past zero).
            const take = Math.sign(left) === Math.sign(amount) ? (Math.abs(left) >= Math.abs(amount) ? amount : left) : 0;
            amount -= take;
            remaining.set(e.ledger_id, left - take);
          }
          const bills = billsOf.get(e.id) ?? [];
          if (amount === 0 && bills.length === 0) continue;
          o.open(entryTag);
          o.el('LEDGERNAME', e.ledger);
          o.yesNo('ISDEEMEDPOSITIVE', amount > 0);
          o.yesNo('ISPARTYLEDGER', v.party_ledger !== null && e.ledger === v.party_ledger);
          o.el('AMOUNT', xmlAmountText(amount));
          for (const b of bills) {
            o.open('BILLALLOCATIONS.LIST');
            if (b.ref_type !== 'on_account') o.el('NAME', b.bill_name);
            o.el('BILLTYPE', BILL_TYPE_XML[b.ref_type] ?? 'On Account');
            if (b.credit_days !== null && b.ref_type === 'new') o.el('BILLCREDITPERIOD', `${b.credit_days} Days`);
            o.el('AMOUNT', xmlAmountText(b.amount));
            o.close('BILLALLOCATIONS.LIST');
          }
          const costs = carried.has(e.ledger_id) ? takeCosts(costQueue.get(e.ledger_id) ?? [], amount) : (costsOf.get(e.id) ?? []);
          writeCostAllocations(o, costs, amount > 0);
          if (e.instrument_type || e.instrument_no) {
            o.open('BANKALLOCATIONS.LIST');
            o.el('DATE', xmlDateText(v.date));
            if (e.instrument_date) o.el('INSTRUMENTDATE', xmlDateText(e.instrument_date));
            o.el('TRANSACTIONTYPE', INSTRUMENT_XML[e.instrument_type ?? 'other'] ?? 'Others');
            o.el('INSTRUMENTNUMBER', e.instrument_no);
            o.el('BANKNAME', e.bank_name);
            o.el('PAYMENTFAVOURING', e.favouring);
            if (e.bank_date) o.el('BANKERSDATE', xmlDateText(e.bank_date));
            o.el('AMOUNT', xmlAmountText(amount));
            o.close('BANKALLOCATIONS.LIST');
          }
          o.close(entryTag);
        }
        o.close('VOUCHER');
      });
      emit(o.text());
      count++;
      if (++sinceYield >= EXPORT_YIELD_ROWS) {
        sinceYield = 0;
        await pause();
      }
    }
  }
  return { vouchers: count, skipped: [...skipped].map(([reason, n]) => ({ reason, count: n })) };
}

/** Vouchers read per header query (ids bound as one JSON array). */
const VOUCHER_BATCH = 2000;


// ───────────────────────────── Envelope ─────────────────────────────

/** The ENVELOPE around the message elements (MESSAGE_TAG): [text before them, text after them]. */
function envelopeParts(company: string, report: 'All Masters' | 'Vouchers'): [string, string] {
  const head = new Out();
  head.open('ENVELOPE');
  head.open('HEADER');
  head.el(REQUEST_TAG, 'Import Data');
  head.close('HEADER');
  head.open('BODY');
  head.open('IMPORTDATA');
  head.open('REQUESTDESC');
  head.el('REPORTNAME', report);
  head.open('STATICVARIABLES');
  head.el('SVCURRENTCOMPANY', company);
  head.close('STATICVARIABLES');
  head.close('REQUESTDESC');
  head.open('REQUESTDATA');
  return [head.text(), '   </REQUESTDATA>\r\n  </IMPORTDATA>\r\n </BODY>\r\n</ENVELOPE>\r\n'];
}

/** UTF-16LE with a byte-order mark. */
export function utf16leWithBom(text: string): Uint8Array {
  return utf16le(`\uFEFF${text}`);
}

function utf16le(text: string): Uint8Array {
  const buf = Buffer.from(text, 'utf16le');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * The masters file as text (tests, and the masters part of the export). `openingsAsOf` (the start of
 * the exported period) after the books beginning writes the opening balances, bills and stock as on
 * that date (see openingsAt); otherwise the books-beginning openings as entered.
 */
export function buildXmlMasters(
  db: Db,
  opts: { openingsAsOf?: string; today?: string } = {},
): { xml: string; counts: MasterCounts; companyName: string; openingsAsOf: string } {
  const company = db.get<{ name: string; books_from: string }>('SELECT name, books_from FROM company WHERE id = 1');
  const name = company?.name ?? 'Company';
  const booksFrom = company?.books_from ?? '1970-01-01';
  const openings = openingsAt(db, opts.openingsAsOf ?? booksFrom, booksFrom, opts.today ?? opts.openingsAsOf ?? booksFrom);
  const o = new Out();
  const counts = writeMasters(db, booksFrom, o, openings);
  const [head, tail] = envelopeParts(name, 'All Masters');
  return { xml: head + o.text() + tail, counts, companyName: name, openingsAsOf: openings.asOf };
}

/**
 * 'data.xmlExport.create'. Masters only → one XML file. With vouchers → a ZIP (1-Masters.xml +
 * 2-Vouchers.xml, or Vouchers.xml alone): Tally XML runs to ~4.5 KB a voucher, so the vouchers are
 * streamed into the ZIP in the company folder (constant memory, one read snapshot, yielding between
 * batches) and the finished file — about a twentieth of the XML — is read back and deleted.
 */
export async function exportXml(ctx: CompanyCtx, input: XmlExportInput): Promise<XmlExportResult> {
  requirePermission(ctx, 'data.export');
  if (!input.masters && !input.vouchers) throw validation([{ path: 'masters', message: 'Choose masters, vouchers or both.' }]);
  if (input.vouchers && input.from > input.to) throw validation([{ path: 'from', message: 'The period starts after it ends. Check the From and To dates.' }]);
  const snap = openSnapshot(ctx);
  let zip: ZipFileWriter | null = null;
  let fileName: string;
  let bytes: Uint8Array;
  let mimeType: string;
  let masterCounts: MasterCounts | null = null;
  let masters: ReturnType<typeof buildXmlMasters> | null = null;
  let voucherCounts: VoucherCounts | null = null;
  let companyName: string;
  try {
    const db = snap.db;
    // With the vouchers of a later period, the masters carry the balances on the period's first day.
    masters = input.masters ? buildXmlMasters(db, { ...(input.vouchers ? { openingsAsOf: input.from } : {}), today: ctx.clock.today() }) : null;
    masterCounts = masters?.counts ?? null;
    companyName = masters?.companyName ?? db.value<string>('SELECT name FROM company WHERE id = 1') ?? 'Company';
    const slug = fileSlug(companyName);
    if (!input.vouchers) {
      fileName = `${slug}-Tally-Masters.xml`;
      bytes = utf16leWithBom(masters?.xml ?? '');
      mimeType = XML_DATA_MIME;
    } else {
      fs.mkdirSync(ctx.company.dir, { recursive: true });
      const tmp = path.join(ctx.company.dir, `.export-${randomToken(6)}.tmp`);
      const writer = new ZipFileWriter(tmp);
      zip = writer;
      if (masters) writer.addEntry('1-Masters.xml', utf16leWithBom(masters.xml));
      writer.beginEntry(masters ? '2-Vouchers.xml' : 'Vouchers.xml');
      const [head, tail] = envelopeParts(companyName, 'Vouchers');
      writer.write(utf16leWithBom(head));
      // Batch the per-voucher texts into ~64 K-character blocks before encoding.
      let pending: string[] = [];
      let pendingChars = 0;
      const flush = (): void => {
        if (pending.length === 0) return;
        writer.write(utf16le(pending.join('')));
        pending = [];
        pendingChars = 0;
      };
      voucherCounts = await writeVouchers(
        db,
        input.from,
        input.to,
        ctx.clock.today(),
        (text) => {
          pending.push(text);
          pendingChars += text.length;
          if (pendingChars >= 64 * 1024) flush();
        },
        async () => {
          if (!snap.canYield) return;
          await yieldToEventLoop();
          if (!ctx.db.isOpen) throw new AppError('CONFLICT', 'The company was closed during the export. Export again.');
        },
      );
      flush();
      writer.write(utf16le(tail));
      writer.endEntry();
      writer.finish();
      bytes = new Uint8Array(fs.readFileSync(tmp));
      const period = `${input.from.replace(/-/g, '')}-${input.to.replace(/-/g, '')}`;
      fileName = masters ? `${slug}-Tally-${period}.zip` : `${slug}-Tally-Vouchers-${period}.zip`;
      mimeType = ZIP_MIME;
    }
  } finally {
    snap.close();
    zip?.abort(); // closes if still open, and deletes the temporary file in every case
  }
  const result: XmlExportResult = {
    fileName,
    bytes,
    mimeType,
    masters: masterCounts,
    openingsAsOf: masters?.openingsAsOf ?? null,
    vouchers: voucherCounts?.vouchers ?? 0,
    skipped: voucherCounts?.skipped ?? [],
  };
  ctx.db.transaction(() =>
    ctx.audit({
      action: 'export',
      entityType: 'xml_data',
      entityLabel: input.vouchers ? `Tally XML ${formatDate(input.from)} to ${formatDate(input.to)}` : 'Tally XML (masters)',
      after: { masters: masterCounts, openingsAsOf: result.openingsAsOf, vouchers: result.vouchers, skipped: result.skipped, bytes: bytes.byteLength },
    }),
  );
  return result;
}

/**
 * 'data.tally.export' — the books as a Tally "Import Data" XML file, for the CA / auditor who works in
 * TallyPrime (Gateway of Tally › Import › Masters / Transactions), and for moving back.
 *
 * Shape: ENVELOPE › HEADER (TALLYREQUEST Import Data) › BODY › IMPORTDATA › REQUESTDESC (REPORTNAME
 * "All Masters" or "Vouchers", SVCURRENTCOMPANY) › REQUESTDATA › TALLYMESSAGE* — the shape TallyPrime
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
import { PREDEFINED_VOUCHER_TYPES, type VoucherBaseType } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { stateName, uqcDescription } from '../../../shared/gst/index.ts';
import type { TallyExportInput, TallyExportResult } from '../../../shared/types/data.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { allAliases, extraAliasMap } from '../../lib/masterAliases.ts';
import { escapeAttr, escapeXml } from '../../lib/xml.ts';
import { createZip } from '../../lib/zip.ts';
import { fileSlug, requirePermission } from './common.ts';
import { ZIP_MIME } from './exportTable.ts';

export const TALLY_XML_MIME = 'application/xml';

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
export function tallyAmountText(ourPaise: number): string {
  const t = -ourPaise;
  const neg = t < 0;
  const abs = Math.abs(t);
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg && abs !== 0 ? `-${body}` : body;
}

/** Paise (positive value) → '24000.00'. */
const rupees = (paise: number): string => tallyAmountText(-Math.abs(paise));

/** 'YYYY-MM-DD' → 'yyyymmdd'. */
export const tallyDateText = (iso: string): string => iso.replace(/-/g, '');

/** Quantity ' 10 Nos' (Tally pads a space); up to 4 decimals, trailing zeros dropped. */
export function tallyQtyText(qty: number, unit: string): string {
  const q = Math.abs(qty);
  const s = Number.isInteger(q) ? String(q) : String(Math.round(q * 10_000) / 10_000);
  return ` ${s} ${unit}`;
}

/** Rate '2950.50/Nos'. */
export function tallyRateText(rate: number, unit: string): string {
  const r = Math.round(rate * 10_000) / 10_000;
  const [i, f = ''] = String(r).split('.');
  return `${i}.${(f + '00').slice(0, Math.max(2, f.length))}/${unit}`;
}

const DUTY_HEAD_TALLY: Readonly<Record<string, string>> = { IGST: 'Integrated Tax', CGST: 'Central Tax', SGST: 'State Tax', CESS: 'Cess' };
const TAXABILITY_TALLY: Readonly<Record<string, string>> = { taxable: 'Taxable', exempt: 'Exempt', nil_rated: 'Nil Rated', non_gst: 'Non-GST' };
const REGISTRATION_TALLY: Readonly<Record<string, string>> = {
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
const COSTING_TALLY: Readonly<Record<string, string>> = { avg_cost: 'Avg. Cost', fifo: 'FIFO', lifo: 'LIFO', last_purchase: 'Last Purchase Cost', std_cost: 'Std. Cost' };
const NUMBERING_TALLY: Readonly<Record<string, string>> = { automatic: 'Automatic', automatic_override: 'Automatic (Manual Override)', manual: 'Manual', none: 'None' };
const INSTRUMENT_TALLY: Readonly<Record<string, string>> = { cheque: 'Cheque', dd: 'DD', neft: 'e-Fund Transfer', rtgs: 'e-Fund Transfer', imps: 'e-Fund Transfer', upi: 'e-Fund Transfer', card: 'Others', cash: 'Others', other: 'Others' };
const BILL_TYPE_TALLY: Readonly<Record<string, string>> = { new: 'New Ref', against: 'Agst Ref', advance: 'Advance', on_account: 'On Account' };
/** Our base types with a Tally voucher type (quotation / proforma have none; physical stock is not written). */
const TALLY_TYPE_OF: Partial<Record<VoucherBaseType, string>> = Object.fromEntries(
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
    o.el('APPLICABLEFROM', tallyDateText(r.applicable_from));
    o.el('HSNCODE', r.hsn_sac);
    o.el('TAXABILITY', TAXABILITY_TALLY[r.taxability] ?? 'Taxable');
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
  o.open('TALLYMESSAGE', { 'xmlns:UDF': 'TallyUDF' });
  write();
  o.close('TALLYMESSAGE');
}

interface MasterCounts {
  groups: number;
  ledgers: number;
  units: number;
  godowns: number;
  stockGroups: number;
  stockCategories: number;
  stockItems: number;
  costCategories: number;
  costCentres: number;
  voucherTypes: number;
}

function writeMasters(db: Db, booksFrom: string, o: Out): MasterCounts {
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
    if (l.reserved_code === 'PROFIT_LOSS' && l.opening_balance === 0) continue; // Tally has its own
    const str = (k: string): string | null => (typeof l[k] === 'string' && (l[k] as string).trim() !== '' ? (l[k] as string) : null);
    const num = (k: string): number | null => (typeof l[k] === 'number' ? (l[k] as number) : null);
    message(o, () => {
      const reserved = l.reserved_code === 'CASH' ? 'Cash' : l.reserved_code === 'PROFIT_LOSS' ? 'Profit & Loss A/c' : null;
      o.open('LEDGER', { NAME: l.name, ...(reserved ? { RESERVEDNAME: reserved } : {}), ACTION: 'Create' });
      o.el('PARENT', l.group_name);
      o.el('OPENINGBALANCE', tallyAmountText(l.opening_balance));
      const billWise = num('maintain_bill_wise') === 1;
      o.yesNo('ISBILLWISEON', billWise);
      if (num('default_credit_days') !== null) o.el('BILLCREDITPERIOD', `${num('default_credit_days')} Days`);
      if (num('credit_limit')) o.el('CREDITLIMIT', tallyAmountText(num('credit_limit') as number));
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
      if (reg) o.el('GSTREGISTRATIONTYPE', REGISTRATION_TALLY[reg] ?? 'Unknown');
      o.el('PARTYGSTIN', str('gstin'));
      // TallyPrime keeps registration and mailing details effective-dated as well.
      if (reg || str('gstin')) {
        o.open('LEDGSTREGDETAILS.LIST');
        o.el('APPLICABLEFROM', tallyDateText(booksFrom));
        if (reg) o.el('GSTREGISTRATIONTYPE', REGISTRATION_TALLY[reg] ?? 'Unknown');
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
      if (head) o.el('GSTDUTYHEAD', DUTY_HEAD_TALLY[head] ?? head);
      // GST rate details of sales / purchase / income / expense ledgers.
      if (str('gst_applicable') === 'applicable') {
        o.logical('GSTAPPLICABLE', 'Applicable');
        const supply = str('gst_supply_type');
        if (supply) o.el('GSTTYPEOFSUPPLY', supply === 'services' ? 'Services' : 'Goods');
        const hist = gstHistory(db, 'ledger', l.id);
        const rows =
          hist.length > 0
            ? hist
            : num('gst_rate') !== null || str('gst_taxability')
              ? [{ applicable_from: booksFrom, hsn_sac: str('hsn_sac'), taxability: str('gst_taxability') ?? 'taxable', rate: num('gst_rate') ?? 0, cess_rate: num('cess_rate') ?? 0 }]
              : [];
        writeGstDetails(o, rows);
      }
      // Bill-wise opening balance.
      if (billWise) {
        for (const b of db.all<{ bill_name: string; bill_date: string; due_date: string | null; amount: number }>(
          'SELECT bill_name, bill_date, due_date, amount FROM opening_bills WHERE ledger_id = :id ORDER BY bill_date, id',
          { id: l.id },
        )) {
          o.open('BILLALLOCATIONS.LIST');
          o.el('NAME', b.bill_name);
          o.el('BILLDATE', tallyDateText(b.bill_date));
          if (b.due_date) o.el('BILLCREDITPERIOD', `${Math.max(0, daysBetween(b.bill_date, b.due_date))} Days`);
          o.yesNo('ISADVANCE', false);
          o.el('OPENINGBALANCE', tallyAmountText(b.amount));
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
    const openings = db.all<{ godown: string; is_predefined: number; batch_name: string | null; qty: number; rate: number; value: number }>(
      'SELECT g.name AS godown, g.is_predefined, o.batch_name, o.qty, o.rate, o.value FROM stock_openings o JOIN godowns g ON g.id = o.godown_id WHERE o.item_id = :id ORDER BY o.id',
      { id: it.id },
    );
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
      o.el('COSTINGMETHOD', COSTING_TALLY[it.costing_method] ?? 'Avg. Cost');
      o.yesNo('ISBATCHWISEON', it.maintain_batches === 1);
      if (it.gst_applicable === 'applicable') {
        o.logical('GSTAPPLICABLE', 'Applicable');
        o.el('GSTTYPEOFSUPPLY', it.is_service === 1 ? 'Services' : 'Goods');
        const hist = gstHistory(db, 'stock_item', it.id);
        writeGstDetails(
          o,
          hist.length > 0
            ? hist
            : it.gst_rate !== null || it.hsn_sac
              ? [{ applicable_from: booksFrom, hsn_sac: it.hsn_sac, taxability: it.gst_taxability, rate: it.gst_rate ?? 0, cess_rate: it.cess_rate ?? 0 }]
              : [],
        );
      } else {
        o.logical('GSTAPPLICABLE', 'Not Applicable');
      }
      const qty = openings.reduce((s, x) => s + x.qty, 0);
      const value = openings.reduce((s, x) => s + x.value, 0);
      if (openings.length > 0 && qty !== 0) {
        o.el('OPENINGBALANCE', tallyQtyText(qty, it.unit));
        o.el('OPENINGVALUE', tallyAmountText(value));
        o.el('OPENINGRATE', tallyRateText(value / 100 / qty, it.unit));
        for (const op of openings) {
          o.open('BATCHALLOCATIONS.LIST');
          o.el('GODOWNNAME', op.is_predefined === 1 ? 'Main Location' : op.godown);
          o.el('BATCHNAME', op.batch_name ?? 'Primary Batch');
          o.el('OPENINGBALANCE', tallyQtyText(op.qty, it.unit));
          o.el('OPENINGVALUE', tallyAmountText(op.value));
          o.el('OPENINGRATE', tallyRateText(op.rate, it.unit));
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
    if (!TALLY_TYPE_OF[t.base_type]) continue;
    message(o, () => {
      o.open('VOUCHERTYPE', { NAME: t.name, ACTION: 'Create' });
      o.el('PARENT', t.parent_name ?? TALLY_TYPE_OF[t.base_type]);
      o.el('NUMBERINGMETHOD', NUMBERING_TALLY[t.numbering_method] ?? 'Automatic');
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

function writeVouchers(db: Db, from: string, to: string, o: Out): VoucherCounts {
  const skipped = new Map<string, number>();
  const skip = (reason: string): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };
  let count = 0;
  const vouchers = db.all<VRow>(
    `SELECT v.id, v.guid, t.name AS type_name, v.base_type, v.number, v.date, v.effective_date, v.reference_no, v.reference_date,
            v.party_name, pl.name AS party_ledger, v.party_gstin, v.party_registration_type, v.place_of_supply, v.invoice_mode,
            v.is_optional, v.is_post_dated, v.is_cancelled, v.narration
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
      WHERE v.date BETWEEN :from AND :to ORDER BY v.date, v.id`,
    { from, to },
  );
  for (const v of vouchers) {
    const tallyBase = TALLY_TYPE_OF[v.base_type];
    if (!tallyBase) {
      skip(v.base_type === 'physical_stock' ? 'Physical stock vouchers (enter the counted stock in Tally)' : 'Quotations and proforma invoices (Tally has no such voucher type)');
      continue;
    }
    const entries = v.is_cancelled
      ? []
      : db.all<LeRow>(
          `SELECT e.id, e.ledger_id, l.name AS ledger, e.amount, e.instrument_type, e.instrument_no, e.instrument_date, e.bank_name, e.favouring, e.bank_date
             FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = :id ORDER BY e.line_no, e.id`,
          { id: v.id },
        );
    const inventory = v.is_cancelled
      ? []
      : db.all<IeRow>(
          `SELECT ie.line_no, i.name AS item, u.symbol AS unit, g.name AS godown, g.is_predefined AS godown_predefined, ie.batch_name, ie.qty, ie.billed_qty,
                  ie.rate, ie.discount_pct, ie.amount, ie.ledger_id, l.name AS ledger, ie.tracking_ref, ie.order_ref, ie.is_consumption
             FROM inventory_entries ie JOIN stock_items i ON i.id = ie.item_id JOIN units u ON u.id = i.unit_id
             LEFT JOIN godowns g ON g.id = ie.godown_id LEFT JOIN ledgers l ON l.id = ie.ledger_id
            WHERE ie.voucher_id = :id ORDER BY ie.line_no, ie.id`,
          { id: v.id },
        );
    const isInvoice = v.invoice_mode !== null || inventory.length > 0;
    const view = v.base_type === 'stock_journal' ? 'Consumption Voucher View' : inventory.length > 0 ? 'Invoice Voucher View' : 'Accounting Voucher View';
    message(o, () => {
      o.open('VOUCHER', { REMOTEID: v.guid, VCHTYPE: v.type_name, ACTION: 'Create', OBJVIEW: view });
      o.el('DATE', tallyDateText(v.date));
      if (v.effective_date && v.effective_date !== v.date) o.el('EFFECTIVEDATE', tallyDateText(v.effective_date));
      o.el('GUID', v.guid);
      o.el('VOUCHERTYPENAME', v.type_name);
      o.el('VOUCHERNUMBER', v.number);
      o.el('REFERENCE', v.reference_no);
      if (v.reference_date) o.el('REFERENCEDATE', tallyDateText(v.reference_date));
      o.el('PARTYLEDGERNAME', v.party_ledger);
      o.el('PARTYNAME', v.party_name ?? v.party_ledger);
      o.el('PARTYGSTIN', v.party_gstin);
      if (v.party_registration_type) o.el('GSTREGISTRATIONTYPE', REGISTRATION_TALLY[v.party_registration_type] ?? 'Unknown');
      if (v.place_of_supply && v.place_of_supply !== '96') o.el('PLACEOFSUPPLY', stateName(v.place_of_supply));
      o.el('NARRATION', v.narration);
      o.el('PERSISTEDVIEW', view);
      o.yesNo('ISINVOICE', isInvoice);
      o.yesNo('ISOPTIONAL', v.is_optional === 1);
      o.yesNo('ISCANCELLED', v.is_cancelled === 1);
      o.yesNo('ISPOSTDATED', v.is_post_dated === 1);

      // Inventory lines (grouped by line; one batch allocation per godown / batch row).
      const lines = new Map<number, IeRow[]>();
      for (const r of inventory) {
        const list = lines.get(r.line_no);
        if (list) list.push(r);
        else lines.set(r.line_no, [r]);
      }
      // The part of each ledger's posting that the inventory lines carry (ACCOUNTINGALLOCATIONS).
      const allocated = new Map<number, number>();
      const ledgerTotal = new Map<number, number>();
      for (const e of entries) ledgerTotal.set(e.ledger_id, (ledgerTotal.get(e.ledger_id) ?? 0) + e.amount);
      const stockJournal = v.base_type === 'stock_journal';
      for (const rows of lines.values()) {
        const first = rows[0];
        const qty = rows.reduce((s, r) => s + r.qty, 0);
        const amount = rows.reduce((s, r) => s + r.amount, 0);
        const inward = stockJournal ? first.is_consumption !== 1 : qty > 0 || (qty === 0 && ledgerSign(ledgerTotal, first.ledger_id) > 0);
        // Our signed value of this line's ledger posting (Dr + for inward / purchase-side lines).
        const total = first.ledger_id !== null ? (ledgerTotal.get(first.ledger_id) ?? 0) : 0;
        const signed = first.ledger_id !== null && total !== 0 ? Math.sign(total) * amount : inward ? amount : -amount;
        const tag = stockJournal ? (inward ? 'INVENTORYENTRIESIN.LIST' : 'INVENTORYENTRIESOUT.LIST') : 'ALLINVENTORYENTRIES.LIST';
        o.open(tag);
        o.el('STOCKITEMNAME', first.item);
        o.yesNo('ISDEEMEDPOSITIVE', inward);
        if (first.rate) o.el('RATE', tallyRateText(first.rate, first.unit));
        if (first.discount_pct) o.el('DISCOUNT', ` ${first.discount_pct}`);
        o.el('AMOUNT', tallyAmountText(signed));
        o.el('ACTUALQTY', tallyQtyText(qty, first.unit));
        const billed = rows.reduce((s, r) => s + Math.abs(r.billed_qty ?? r.qty), 0);
        o.el('BILLEDQTY', tallyQtyText(billed, first.unit));
        for (const r of rows) {
          o.open('BATCHALLOCATIONS.LIST');
          o.el('GODOWNNAME', r.godown_predefined === 1 || !r.godown ? 'Main Location' : r.godown);
          o.el('BATCHNAME', r.batch_name ?? 'Primary Batch');
          o.el('TRACKINGNUMBER', r.tracking_ref);
          o.el('ORDERNO', r.order_ref);
          o.el('AMOUNT', tallyAmountText(first.ledger_id !== null && total !== 0 ? Math.sign(total) * r.amount : inward ? r.amount : -r.amount));
          o.el('ACTUALQTY', tallyQtyText(r.qty, first.unit));
          o.el('BILLEDQTY', tallyQtyText(r.billed_qty ?? r.qty, first.unit));
          o.close('BATCHALLOCATIONS.LIST');
        }
        if (first.ledger_id !== null && first.ledger && entries.length > 0 && ledgerTotal.has(first.ledger_id)) {
          o.open('ACCOUNTINGALLOCATIONS.LIST');
          o.el('LEDGERNAME', first.ledger);
          o.yesNo('ISDEEMEDPOSITIVE', signed > 0);
          o.el('AMOUNT', tallyAmountText(signed));
          o.close('ACCOUNTINGALLOCATIONS.LIST');
          allocated.set(first.ledger_id, (allocated.get(first.ledger_id) ?? 0) + signed);
        }
        o.close(tag);
      }

      // Ledger entries (what the inventory lines did not already carry).
      const entryTag = lines.size > 0 ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
      const remaining = new Map<number, number>(allocated);
      for (const e of entries) {
        let amount = e.amount;
        const carried = remaining.get(e.ledger_id) ?? 0;
        if (carried !== 0) {
          // Take the carried part out of this ledger's entries (in order, never past zero).
          const take = Math.sign(carried) === Math.sign(amount) ? (Math.abs(carried) >= Math.abs(amount) ? amount : carried) : 0;
          amount -= take;
          remaining.set(e.ledger_id, carried - take);
        }
        const bills = db.all<{ ref_type: string; bill_name: string | null; amount: number; credit_days: number | null }>(
          'SELECT ref_type, bill_name, amount, credit_days FROM bill_allocations WHERE ledger_entry_id = :id ORDER BY id',
          { id: e.id },
        );
        if (amount === 0 && bills.length === 0) continue;
        o.open(entryTag);
        o.el('LEDGERNAME', e.ledger);
        o.yesNo('ISDEEMEDPOSITIVE', amount > 0);
        o.yesNo('ISPARTYLEDGER', v.party_ledger !== null && e.ledger === v.party_ledger);
        o.el('AMOUNT', tallyAmountText(amount));
        for (const b of bills) {
          o.open('BILLALLOCATIONS.LIST');
          if (b.ref_type !== 'on_account') o.el('NAME', b.bill_name);
          o.el('BILLTYPE', BILL_TYPE_TALLY[b.ref_type] ?? 'On Account');
          if (b.credit_days !== null && b.ref_type === 'new') o.el('BILLCREDITPERIOD', `${b.credit_days} Days`);
          o.el('AMOUNT', tallyAmountText(b.amount));
          o.close('BILLALLOCATIONS.LIST');
        }
        const costs = db.all<{ centre: string; category: string; amount: number }>(
          `SELECT c.name AS centre, k.name AS category, a.amount FROM cost_allocations a JOIN cost_centres c ON c.id = a.cost_centre_id
             JOIN cost_categories k ON k.id = c.category_id WHERE a.ledger_entry_id = :id ORDER BY k.name, a.id`,
          { id: e.id },
        );
        const byCat = new Map<string, Array<{ centre: string; amount: number }>>();
        for (const c of costs) {
          const list = byCat.get(c.category);
          if (list) list.push(c);
          else byCat.set(c.category, [c]);
        }
        for (const [category, list] of byCat) {
          o.open('CATEGORYALLOCATIONS.LIST');
          o.el('CATEGORY', category);
          o.yesNo('ISDEEMEDPOSITIVE', amount > 0);
          for (const c of list) {
            o.open('COSTCENTREALLOCATIONS.LIST');
            o.el('NAME', c.centre);
            o.el('AMOUNT', tallyAmountText(c.amount));
            o.close('COSTCENTREALLOCATIONS.LIST');
          }
          o.close('CATEGORYALLOCATIONS.LIST');
        }
        if (e.instrument_type || e.instrument_no) {
          o.open('BANKALLOCATIONS.LIST');
          o.el('DATE', tallyDateText(v.date));
          if (e.instrument_date) o.el('INSTRUMENTDATE', tallyDateText(e.instrument_date));
          o.el('TRANSACTIONTYPE', INSTRUMENT_TALLY[e.instrument_type ?? 'other'] ?? 'Others');
          o.el('INSTRUMENTNUMBER', e.instrument_no);
          o.el('BANKNAME', e.bank_name);
          o.el('PAYMENTFAVOURING', e.favouring);
          if (e.bank_date) o.el('BANKERSDATE', tallyDateText(e.bank_date));
          o.el('AMOUNT', tallyAmountText(amount));
          o.close('BANKALLOCATIONS.LIST');
        }
        o.close(entryTag);
      }
      o.close('VOUCHER');
    });
    count++;
  }
  return { vouchers: count, skipped: [...skipped].map(([reason, n]) => ({ reason, count: n })) };
}

function ledgerSign(totals: ReadonlyMap<number, number>, ledgerId: number | null): number {
  return ledgerId === null ? 0 : Math.sign(totals.get(ledgerId) ?? 0);
}

// ───────────────────────────── Envelope ─────────────────────────────

function envelope(company: string, report: 'All Masters' | 'Vouchers', body: string): string {
  const head = new Out();
  head.open('ENVELOPE');
  head.open('HEADER');
  head.el('TALLYREQUEST', 'Import Data');
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
  return `${head.text()}${body}   </REQUESTDATA>\r\n  </IMPORTDATA>\r\n </BODY>\r\n</ENVELOPE>\r\n`;
}

/** UTF-16LE with a byte-order mark. */
export function utf16leWithBom(text: string): Uint8Array {
  const buf = Buffer.from(`﻿${text}`, 'utf16le');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** The XML texts (for tests and the route). */
export function buildTallyExport(db: Db, input: TallyExportInput): { masters: string | null; vouchers: string | null; masterCounts: MasterCounts | null; voucherCounts: VoucherCounts | null; companyName: string } {
  const company = db.get<{ name: string; books_from: string }>('SELECT name, books_from FROM company WHERE id = 1');
  const name = company?.name ?? 'Company';
  let masters: string | null = null;
  let vouchers: string | null = null;
  let masterCounts: MasterCounts | null = null;
  let voucherCounts: VoucherCounts | null = null;
  if (input.masters) {
    const o = new Out();
    masterCounts = writeMasters(db, company?.books_from ?? input.from, o);
    masters = envelope(name, 'All Masters', o.text());
  }
  if (input.vouchers) {
    const o = new Out();
    voucherCounts = writeVouchers(db, input.from, input.to, o);
    vouchers = envelope(name, 'Vouchers', o.text());
  }
  return { masters, vouchers, masterCounts, voucherCounts, companyName: name };
}

export function exportTally(ctx: CompanyCtx, input: TallyExportInput): TallyExportResult {
  requirePermission(ctx, 'data.export');
  if (!input.masters && !input.vouchers) throw validation([{ path: 'masters', message: 'Choose masters, vouchers or both.' }]);
  if (input.vouchers && input.from > input.to) throw validation([{ path: 'from', message: 'The period starts after it ends. Check the From and To dates.' }]);
  // One consistent read (sync: nothing else runs in between on this worker).
  const built = buildTallyExport(ctx.db, input);
  const slug = fileSlug(built.companyName);
  const period = `${input.from.replace(/-/g, '')}-${input.to.replace(/-/g, '')}`;
  let fileName: string;
  let bytes: Uint8Array;
  let mimeType: string;
  if (built.masters !== null && built.vouchers !== null) {
    fileName = `${slug}-Tally-${period}.zip`;
    bytes = createZip([
      { name: '1-Masters.xml', data: utf16leWithBom(built.masters) },
      { name: '2-Vouchers.xml', data: utf16leWithBom(built.vouchers) },
    ]);
    mimeType = ZIP_MIME;
  } else if (built.masters !== null) {
    fileName = `${slug}-Tally-Masters.xml`;
    bytes = utf16leWithBom(built.masters);
    mimeType = TALLY_XML_MIME;
  } else {
    fileName = `${slug}-Tally-Vouchers-${period}.xml`;
    bytes = utf16leWithBom(built.vouchers ?? '');
    mimeType = TALLY_XML_MIME;
  }
  const result: TallyExportResult = {
    fileName,
    bytes,
    mimeType,
    masters: built.masterCounts,
    vouchers: built.voucherCounts?.vouchers ?? 0,
    skipped: built.voucherCounts?.skipped ?? [],
  };
  ctx.db.transaction(() =>
    ctx.audit({
      action: 'export',
      entityType: 'tally_xml',
      entityLabel: input.vouchers ? `Tally XML ${formatDate(input.from)} to ${formatDate(input.to)}` : 'Tally XML (masters)',
      after: { masters: built.masterCounts, vouchers: result.vouchers, skipped: result.skipped, bytes: bytes.byteLength },
    }),
  );
  return result;
}

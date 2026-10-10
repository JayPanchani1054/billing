/**
 * Tally XML reader: bytes → a typed, database-independent model of the masters and vouchers in a
 * Tally "Export → XML" file (Gateway of Tally › Export › Masters / Transactions, Tally.ERP 9 and
 * TallyPrime). Nothing here touches the database; tallyImport.ts maps the model onto the company.
 *
 * File shape: ENVELOPE › BODY › IMPORTDATA (or DATA) › REQUESTDATA › TALLYMESSAGE* › <object>.
 * Tally writes UTF-16LE (often without a BOM); decodeText() detects it. The document is read with the
 * streaming parser and only one object's subtree is built at a time, so a 100 MB export does not turn
 * into a 100 MB element tree.
 *
 * Tally conventions handled here:
 *  - AMOUNT / OPENINGBALANCE / OPENINGVALUE: negative = Debit. The model uses this app's convention
 *    (Dr +, Cr −) in integer paise, so every Tally amount is negated once, here.
 *  - Quantities '10 Nos', ' 2.500 Kg', '60 Nos = 5 Box' (the part before '=' is the base unit);
 *    rates '100.00/Nos'; dates 'yyyymmdd'; credit periods '30 Days'.
 *  - '&#4;' (U+0004) markers such as '&#4; Primary' / '&#4; Applicable' are removed.
 *  - Names come from the NAME attribute, else NAME, else LANGUAGENAME.LIST › NAME.LIST › NAME (the
 *    other NAME entries are aliases).
 */
import { parseAmount, parseDecimal } from '../../../shared/money.ts';
import { isValidDate } from '../../../shared/dates.ts';
import type { TallyIssue, TallyObjectType } from '../../../shared/types/data.ts';
import { saxParse } from '../../lib/xml.ts';
import { decodeText, FileFormatError } from '../../lib/text.ts';

// ───────────────────────────── Light element tree ─────────────────────────────

export interface TNode {
  name: string;
  attrs: Record<string, string>;
  kids: TNode[];
  text: string;
}

/** Remove Tally's control markers and collapse whitespace. */
export function clean(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .replace(/&#(?:x0*4|0*4);/gi, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function kid(n: TNode | undefined, name: string): TNode | undefined {
  if (!n) return undefined;
  for (const k of n.kids) if (k.name === name) return k;
  return undefined;
}

export function kidsOf(n: TNode | undefined, ...names: string[]): TNode[] {
  if (!n) return [];
  return n.kids.filter((k) => names.includes(k.name));
}

/** Cleaned text of the first child `name` ('' when missing). */
export function val(n: TNode | undefined, name: string): string {
  const k = kid(n, name);
  return k ? clean(k.text) : '';
}

/** First non-empty value among several tags. */
function valAny(n: TNode | undefined, ...names: string[]): string {
  for (const name of names) {
    const v = val(n, name);
    if (v) return v;
  }
  return '';
}

const yes = (s: string): boolean => /^yes$/i.test(s);
const yesNo = (s: string): boolean | null => (/^yes$/i.test(s) ? true : /^no$/i.test(s) ? false : null);
const orNull = (s: string): string | null => (s === '' ? null : s);

/** Name of a master: NAME attribute, NAME tag, or the first LANGUAGENAME.LIST › NAME.LIST › NAME. */
export function objectName(n: TNode): string {
  const attr = clean(n.attrs.NAME);
  if (attr) return attr;
  const direct = val(n, 'NAME');
  if (direct) return direct;
  return names(n)[0] ?? '';
}

function names(n: TNode): string[] {
  const out: string[] = [];
  for (const lang of kidsOf(n, 'LANGUAGENAME.LIST')) {
    for (const list of kidsOf(lang, 'NAME.LIST')) for (const nm of kidsOf(list, 'NAME')) if (clean(nm.text)) out.push(clean(nm.text));
  }
  return out;
}

function aliasesOf(n: TNode, name: string): string[] {
  return names(n).filter((a) => a.toLowerCase() !== name.toLowerCase());
}

function listValues(n: TNode, listName: string, itemName: string): string[] {
  const out: string[] = [];
  for (const list of kidsOf(n, listName)) for (const it of kidsOf(list, itemName)) if (clean(it.text)) out.push(clean(it.text));
  return out;
}

// ───────────────────────────── Value parsers ─────────────────────────────

/** Tally amount text → paise in Tally's sign (negative = Dr). Forex '… = -₹ 800.00' uses the rupee part. */
export function tallyAmount(raw: string): number | null {
  let s = clean(raw);
  if (s === '') return null;
  const eq = s.lastIndexOf('=');
  if (eq >= 0) s = s.slice(eq + 1).trim();
  let sign = 1;
  const drcr = /\s*(dr|cr)\.?$/i.exec(s);
  if (drcr) {
    sign = drcr[1].toLowerCase() === 'dr' ? -1 : 1;
    s = s.slice(0, drcr.index);
  }
  s = s.replace(/₹|rs\.?|inr|\$|€|£/gi, '').replace(/\s+/g, '');
  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  }
  const p = parseAmount(s);
  if (p === null || p < 0) return null;
  return p === 0 ? 0 : sign * p;
}

/** Tally amount → this app's signed paise (Dr +, Cr −). */
export function ourAmount(raw: string): number | null {
  const t = tallyAmount(raw);
  return t === null ? null : t === 0 ? 0 : -t;
}

/** '10 Nos', ' 2.500 Kg', '60 Nos = 5 Box' → { qty, unit } in the first (base) unit. */
export function tallyQty(raw: string): { qty: number; unit: string | null } | null {
  let s = clean(raw);
  if (s === '') return null;
  const eq = s.indexOf('=');
  if (eq >= 0) s = s.slice(0, eq).trim();
  const m = /^(-?[\d,]*\.?\d+)\s*(.*)$/.exec(s);
  if (!m) return null;
  const n = parseDecimal(m[1].replace(/,/g, ''));
  if (n === null) return null;
  const unit = m[2].trim().split(/\s+/)[0] ?? '';
  return { qty: n, unit: unit === '' ? null : unit };
}

/** '100.00/Nos' (or '$ 1.20 = ₹ 100.00/Nos') → rupees per unit. */
export function tallyRate(raw: string): { rate: number; per: string | null } | null {
  let s = clean(raw);
  if (s === '') return null;
  const slash = s.lastIndexOf('/');
  const per = slash >= 0 ? s.slice(slash + 1).trim() || null : null;
  if (slash >= 0) s = s.slice(0, slash);
  const eq = s.lastIndexOf('=');
  if (eq >= 0) s = s.slice(eq + 1);
  s = s.replace(/₹|rs\.?|inr|\$|€|£|,|\s/gi, '');
  const n = parseDecimal(s.replace(/^-/, ''));
  if (n === null) return null;
  return { rate: n, per };
}

/** 'yyyymmdd' → 'YYYY-MM-DD' (also accepts an ISO date); null when missing or invalid. */
export function tallyDate(raw: string): string | null {
  const s = clean(raw);
  let iso: string | null = null;
  if (/^\d{8}$/.test(s)) iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s;
  return iso && isValidDate(iso) ? iso : null;
}

/** '30 Days' → 30; a plain number → that many days. */
export function creditDays(raw: string): number | null {
  const s = clean(raw);
  const m = /^(\d{1,4})\s*(days?)?$/i.exec(s);
  return m ? Number(m[1]) : null;
}

function percent(raw: string): number | null {
  const s = clean(raw).replace(/%$/, '').trim();
  if (s === '') return null;
  return parseDecimal(s);
}

// ───────────────────────────── Model ─────────────────────────────

export type TallyDutyHead = 'IGST' | 'CGST' | 'SGST' | 'CESS';

export interface TGstInfo {
  /** null when the master does not say. */
  applicable: boolean | null;
  hsn: string | null;
  /** Integrated rate (CGST + SGST when only those are given). */
  rate: number | null;
  cessRate: number | null;
  taxability: 'taxable' | 'exempt' | 'nil_rated' | 'non_gst' | null;
  supplyType: 'goods' | 'services' | null;
}

export interface TGroup {
  name: string;
  /** null = primary group. */
  parent: string | null;
  reservedName: string | null;
  aliases: string[];
  isRevenue: boolean | null;
  isDeemedPositive: boolean | null;
  affectsGrossProfit: boolean | null;
}

export interface TOpeningBill {
  name: string;
  date: string | null;
  /** Dr +, Cr −. */
  amount: number;
  creditDays: number | null;
}

export interface TLedger {
  name: string;
  parent: string;
  reservedName: string | null;
  aliases: string[];
  /** Dr +, Cr −, paise. */
  opening: number;
  billWise: boolean;
  costCentres: boolean;
  creditDays: number | null;
  creditLimit: number | null;
  gstin: string | null;
  registrationType: string | null;
  stateName: string | null;
  /** COUNTRYNAME (Tally's mailing details); an overseas party has a country other than India. */
  country: string | null;
  address: string | null;
  pincode: string | null;
  pan: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  contact: string | null;
  mailingName: string | null;
  bank: { accountNo: string | null; ifsc: string | null; bankName: string | null; branch: string | null; holder: string | null };
  taxType: string | null;
  dutyHead: TallyDutyHead | null;
  gst: TGstInfo;
  openingBills: TOpeningBill[];
  /** A charge included in the assessable value (APPROPRIATEFOR GST › GSTAPPROPRIATETO / EXCISEALLOCTYPE), else null. */
  assessable: { to: 'goods' | 'services'; by: 'value' | 'quantity' } | null;
}

export interface TUnit {
  name: string;
  formalName: string | null;
  isSimple: boolean;
  decimals: number;
  uqc: string | null;
  baseUnit: string | null;
  additionalUnit: string | null;
  conversion: number | null;
}

export interface TNamed {
  name: string;
  parent: string | null;
  aliases: string[];
}

export interface TGodown extends TNamed {
  address: string | null;
}

export interface TStockGroup extends TNamed {
  gst: TGstInfo;
}

export interface TCostCentre extends TNamed {
  category: string | null;
}

export interface TItemOpening {
  godown: string | null;
  batch: string | null;
  qty: number;
  rate: number | null;
  /** Paise, positive. */
  value: number | null;
}

export interface TStockItem extends TNamed {
  category: string | null;
  unit: string | null;
  description: string | null;
  partNo: string | null;
  costingMethod: string | null;
  maintainBatches: boolean;
  gst: TGstInfo;
  openings: TItemOpening[];
}

export interface TVoucherType extends TNamed {
  numberingMethod: string | null;
  isActive: boolean;
  abbreviation: string | null;
}

export interface TBill {
  type: 'new' | 'against' | 'advance' | 'on_account';
  name: string | null;
  /** Dr +, Cr −. */
  amount: number;
  creditDays: number | null;
}

export interface TCostAlloc {
  category: string | null;
  centre: string;
  /** Dr +, Cr −. */
  amount: number;
}

export interface TBank {
  type: string | null;
  number: string | null;
  date: string | null;
  bankName: string | null;
  favouring: string | null;
  bankDate: string | null;
}

export interface TEntry {
  ledger: string;
  /** Dr +, Cr −, paise. */
  amount: number;
  bills: TBill[];
  costs: TCostAlloc[];
  bank: TBank | null;
  /** From an inventory line's accounting allocation (the sales/purchase ledger of items). */
  fromInventory: boolean;
}

export interface TInvAlloc {
  godown: string | null;
  batch: string | null;
  qty: number | null;
  billedQty: number | null;
  /** Paise, positive. */
  amount: number | null;
  trackingNo: string | null;
  orderNo: string | null;
}

export interface TInventoryLine {
  item: string;
  /** Unsigned base-unit quantity. */
  qty: number;
  billedQty: number | null;
  rate: number | null;
  rateUnit: string | null;
  qtyUnit: string | null;
  discountPct: number;
  /** Unsigned line value, paise. */
  amount: number;
  /** Tally's own direction when the list says it (stock journal IN/OUT lists), else from ISDEEMEDPOSITIVE. */
  direction: 'in' | 'out' | null;
  isDeemedPositive: boolean | null;
  /** Sales/purchase ledger (first accounting allocation, or the enclosing ledger entry). */
  ledger: string | null;
  allocations: TInvAlloc[];
}

export interface TVoucher {
  vchType: string;
  date: string | null;
  rawDate: string;
  number: string | null;
  reference: string | null;
  referenceDate: string | null;
  narration: string | null;
  party: string | null;
  partyGstin: string | null;
  placeOfSupply: string | null;
  isOptional: boolean;
  isCancelled: boolean;
  isInvoice: boolean;
  isPostDated: boolean;
  guid: string | null;
  remoteId: string | null;
  entries: TEntry[];
  inventory: TInventoryLine[];
}

export interface TallyFile {
  encoding: string;
  companyName: string | null;
  groups: TGroup[];
  ledgers: TLedger[];
  costCategories: TNamed[];
  costCentres: TCostCentre[];
  currencies: TNamed[];
  units: TUnit[];
  godowns: TGodown[];
  stockGroups: TStockGroup[];
  stockCategories: TNamed[];
  stockItems: TStockItem[];
  voucherTypes: TVoucherType[];
  vouchers: TVoucher[];
  counts: Record<TallyObjectType, number>;
  unsupported: Array<{ type: string; count: number }>;
  issues: TallyIssue[];
}

// ───────────────────────────── Reading the document ─────────────────────────────

const SUPPORTED = new Set<string>([
  'GROUP',
  'LEDGER',
  'COSTCATEGORY',
  'COSTCENTRE',
  'CURRENCY',
  'UNIT',
  'GODOWN',
  'STOCKGROUP',
  'STOCKCATEGORY',
  'STOCKITEM',
  'VOUCHERTYPE',
  'VOUCHER',
]);

/** Objects below TALLYMESSAGE as light trees, plus SVCURRENTCOMPANY. */
export function readTallyObjects(text: string): { company: string | null; objects: TNode[]; root: string | null } {
  const objects: TNode[] = [];
  const stack: TNode[] = [];
  const names: string[] = [];
  let msgDepth = -1;
  let company: string | null = null;
  let root: string | null = null;
  let inCompanyVar = false;
  saxParse(
    text,
    {
      open(name, attrs) {
        if (root === null) root = name;
        const depth = names.length;
        names.push(name);
        if (name === 'TALLYMESSAGE' && msgDepth < 0) {
          msgDepth = depth;
          return;
        }
        if (name === 'SVCURRENTCOMPANY') inCompanyVar = true;
        if (msgDepth >= 0 && depth > msgDepth) {
          const node: TNode = { name, attrs, kids: [], text: '' };
          if (depth === msgDepth + 1) objects.push(node);
          else stack[stack.length - 1]?.kids.push(node);
          stack.push(node);
        }
      },
      close(name) {
        const depth = names.length - 1;
        names.pop();
        if (name === 'SVCURRENTCOMPANY') inCompanyVar = false;
        if (msgDepth >= 0 && depth > msgDepth) stack.pop();
        if (depth === msgDepth) msgDepth = -1;
      },
      text(t) {
        if (inCompanyVar && company === null && clean(t)) company = clean(t);
        const top = stack[stack.length - 1];
        if (top) top.text += t;
      },
    },
    { maxDepth: 512 },
  );
  return { company, objects, root };
}

// ───────────────────────────── Object parsers ─────────────────────────────

const DUTY_HEADS: Record<string, TallyDutyHead> = {
  'integrated tax': 'IGST',
  igst: 'IGST',
  'central tax': 'CGST',
  cgst: 'CGST',
  'state tax': 'SGST',
  'ut tax': 'SGST',
  sgst: 'SGST',
  utgst: 'SGST',
  'sgst/utgst': 'SGST',
  cess: 'CESS',
};

export function dutyHeadOf(raw: string): TallyDutyHead | null {
  return DUTY_HEADS[clean(raw).toLowerCase()] ?? null;
}

function taxabilityOf(raw: string): TGstInfo['taxability'] {
  const s = clean(raw).toLowerCase();
  if (s === 'taxable') return 'taxable';
  if (s === 'exempt') return 'exempt';
  if (s === 'nil rated' || s === 'nil-rated' || s === 'nil') return 'nil_rated';
  if (s === 'non-gst' || s === 'non gst' || s === 'nongst') return 'non_gst';
  return null;
}

/** GST details of a ledger / stock group / stock item (the latest GSTDETAILS.LIST wins). */
function gstInfo(n: TNode): TGstInfo {
  const lists = kidsOf(n, 'GSTDETAILS.LIST');
  let g: TNode | undefined;
  let best = '';
  for (const l of lists) {
    const from = val(l, 'APPLICABLEFROM');
    if (!g || from >= best) {
      g = l;
      best = from;
    }
  }
  const applicableText = clean(valAny(n, 'GSTAPPLICABLE')).toLowerCase();
  const applicable = applicableText.includes('not applicable') ? false : applicableText.includes('applicable') ? true : null;
  let hsn = valAny(g, 'HSNCODE', 'HSN') || valAny(n, 'HSNCODE');
  if (!hsn) {
    for (const h of kidsOf(n, 'HSNDETAILS.LIST')) hsn = val(h, 'HSNCODE') || hsn;
  }
  let igst: number | null = null;
  let cgst: number | null = null;
  let sgst: number | null = null;
  let cess: number | null = null;
  const states = g ? kidsOf(g, 'STATEWISEDETAILS.LIST') : [];
  for (const st of states) {
    for (const rd of kidsOf(st, 'RATEDETAILS.LIST')) {
      const head = dutyHeadOf(val(rd, 'GSTRATEDUTYHEAD'));
      const r = percent(val(rd, 'GSTRATE'));
      if (r === null || head === null) continue;
      if (head === 'IGST') igst = r;
      else if (head === 'CGST') cgst = r;
      else if (head === 'SGST') sgst = r;
      else cess = r;
    }
  }
  if (igst === null) {
    const direct = percent(valAny(g, 'IGSTRATE', 'GSTRATE', 'RATE') || valAny(n, 'IGSTRATE', 'GSTRATE'));
    if (direct !== null) igst = direct;
  }
  const rate = igst ?? (cgst !== null || sgst !== null ? (cgst ?? 0) + (sgst ?? 0) : null);
  const supply = clean(valAny(n, 'GSTTYPEOFSUPPLY', 'TYPEOFSUPPLY')).toLowerCase();
  return {
    applicable,
    hsn: orNull(hsn),
    rate,
    cessRate: cess,
    taxability: taxabilityOf(valAny(g, 'TAXABILITY') || valAny(n, 'TAXABILITY')),
    supplyType: supply === 'goods' ? 'goods' : supply === 'services' ? 'services' : null,
  };
}

function parentOf(n: TNode): string | null {
  const p = val(n, 'PARENT');
  return p === '' || /^primary$/i.test(p) ? null : p;
}

function parseGroup(n: TNode): TGroup {
  const name = objectName(n);
  return {
    name,
    parent: parentOf(n),
    reservedName: orNull(clean(n.attrs.RESERVEDNAME)),
    aliases: aliasesOf(n, name),
    isRevenue: yesNo(val(n, 'ISREVENUE')),
    isDeemedPositive: yesNo(val(n, 'ISDEEMEDPOSITIVE')),
    affectsGrossProfit: yesNo(val(n, 'AFFECTSGROSSPROFIT')),
  };
}

function parseLedger(n: TNode): TLedger {
  const name = objectName(n);
  // TallyPrime keeps mailing details and GST registration effective-dated in lists (latest wins).
  const mailing = kidsOf(n, 'LEDMAILINGDETAILS.LIST').sort((a, b) => val(a, 'APPLICABLEFROM').localeCompare(val(b, 'APPLICABLEFROM'))).pop();
  const reg = kidsOf(n, 'LEDGSTREGDETAILS.LIST').sort((a, b) => val(a, 'APPLICABLEFROM').localeCompare(val(b, 'APPLICABLEFROM'))).pop();
  const addressLines = mailing ? listValues(mailing, 'ADDRESS.LIST', 'ADDRESS') : [];
  const address = addressLines.length ? addressLines : listValues(n, 'ADDRESS.LIST', 'ADDRESS');
  const bills: TOpeningBill[] = [];
  for (const b of kidsOf(n, 'BILLALLOCATIONS.LIST')) {
    const amt = ourAmount(valAny(b, 'OPENINGBALANCE', 'AMOUNT'));
    const billName = val(b, 'NAME');
    if (!billName || amt === null || amt === 0) continue;
    bills.push({ name: billName, date: tallyDate(val(b, 'BILLDATE')), amount: amt, creditDays: creditDays(val(b, 'BILLCREDITPERIOD')) });
  }
  const taxTypeRaw = clean(val(n, 'TAXTYPE'));
  const limit = ourAmount(val(n, 'CREDITLIMIT'));
  return {
    name,
    parent: val(n, 'PARENT'),
    reservedName: orNull(clean(n.attrs.RESERVEDNAME)),
    aliases: aliasesOf(n, name),
    opening: ourAmount(val(n, 'OPENINGBALANCE')) ?? 0,
    billWise: yes(val(n, 'ISBILLWISEON')),
    costCentres: yes(val(n, 'ISCOSTCENTRESON')),
    creditDays: creditDays(val(n, 'BILLCREDITPERIOD')),
    creditLimit: limit === null || limit === 0 ? null : Math.abs(limit),
    gstin: orNull((valAny(reg, 'GSTIN') || valAny(n, 'PARTYGSTIN', 'GSTIN')).toUpperCase().replace(/\s+/g, '')),
    registrationType: orNull(valAny(reg, 'GSTREGISTRATIONTYPE') || val(n, 'GSTREGISTRATIONTYPE')),
    stateName: orNull(valAny(mailing, 'STATE') || valAny(reg, 'STATE', 'PLACEOFSUPPLY') || valAny(n, 'LEDSTATENAME', 'STATENAME')),
    country: orNull(valAny(mailing, 'COUNTRY', 'COUNTRYNAME') || valAny(n, 'COUNTRYNAME', 'COUNTRYOFRESIDENCE')),
    address: address.length ? address.join(', ') : null,
    pincode: orNull(valAny(mailing, 'PINCODE') || val(n, 'PINCODE')),
    pan: orNull(val(n, 'INCOMETAXNUMBER').toUpperCase()),
    phone: orNull(valAny(n, 'LEDGERPHONE', 'PHONENUMBER')),
    mobile: orNull(valAny(n, 'LEDGERMOBILE', 'MOBILENUMBER')),
    email: orNull(valAny(n, 'EMAIL', 'LEDGEREMAIL')),
    contact: orNull(valAny(n, 'LEDGERCONTACT', 'CONTACTPERSON')),
    mailingName: orNull(valAny(mailing, 'MAILINGNAME') || val(n, 'MAILINGNAME')),
    bank: {
      accountNo: orNull(valAny(n, 'BANKACCOUNTNUMBER', 'ACCOUNTNUMBER', 'BANKDETAILS')),
      ifsc: orNull(valAny(n, 'IFSCODE', 'IFSCCODE', 'IFSC').toUpperCase()),
      bankName: orNull(valAny(n, 'BANKINGCONFIGBANK', 'BANKNAME')),
      branch: orNull(valAny(n, 'BRANCHNAME', 'BANKBRANCHNAME')),
      holder: orNull(valAny(n, 'BANKACCHOLDERNAME')),
    },
    taxType: orNull(taxTypeRaw),
    dutyHead: dutyHeadOf(val(n, 'GSTDUTYHEAD')),
    gst: gstInfo(n),
    openingBills: bills,
    assessable: assessableOf(n),
  };
}

/** "Include in assessable value calculation: GST, appropriate to Goods / Services, based on value / quantity". */
function assessableOf(n: TNode): TLedger['assessable'] {
  if (!/^gst$/i.test(clean(val(n, 'APPROPRIATEFOR')))) return null;
  const to = clean(val(n, 'GSTAPPROPRIATETO')).toLowerCase();
  const kind = to.startsWith('service') ? 'services' : to.startsWith('goods') ? 'goods' : null;
  if (!kind) return null;
  return { to: kind, by: /quantity/i.test(val(n, 'EXCISEALLOCTYPE')) ? 'quantity' : 'value' };
}

function parseUnit(n: TNode): TUnit {
  const uqcText = val(n, 'GSTREPUOM');
  const decimals = Number.parseInt(val(n, 'DECIMALPLACES'), 10);
  const conv = parseDecimal(val(n, 'CONVERSION'));
  const isSimple = yesNo(val(n, 'ISSIMPLEUNIT'));
  return {
    name: objectName(n),
    formalName: orNull(val(n, 'ORIGINALNAME')),
    isSimple: isSimple ?? !val(n, 'ADDITIONALUNITS'),
    decimals: Number.isFinite(decimals) ? Math.max(0, Math.min(4, decimals)) : 0,
    uqc: orNull(uqcText.split('-')[0].trim().toUpperCase()),
    baseUnit: orNull(val(n, 'BASEUNITS')),
    additionalUnit: orNull(val(n, 'ADDITIONALUNITS')),
    conversion: conv,
  };
}

function parseNamed(n: TNode): TNamed {
  const name = objectName(n);
  return { name, parent: parentOf(n), aliases: aliasesOf(n, name) };
}

function parseStockItem(n: TNode): TStockItem {
  const base = parseNamed(n);
  const unit = orNull(val(n, 'BASEUNITS'));
  const openings: TItemOpening[] = [];
  for (const b of kidsOf(n, 'BATCHALLOCATIONS.LIST')) {
    const q = tallyQty(val(b, 'OPENINGBALANCE'));
    if (!q || q.qty === 0) continue;
    const v = ourAmount(val(b, 'OPENINGVALUE'));
    const r = tallyRate(val(b, 'OPENINGRATE'));
    const batch = val(b, 'BATCHNAME');
    openings.push({
      godown: orNull(val(b, 'GODOWNNAME')),
      batch: batch === '' || /^primary batch$/i.test(batch) ? null : batch,
      qty: q.qty,
      rate: r?.rate ?? null,
      value: v === null ? null : Math.abs(v),
    });
  }
  if (openings.length === 0) {
    const q = tallyQty(val(n, 'OPENINGBALANCE'));
    if (q && q.qty !== 0) {
      const v = ourAmount(val(n, 'OPENINGVALUE'));
      const r = tallyRate(val(n, 'OPENINGRATE'));
      openings.push({ godown: null, batch: null, qty: q.qty, rate: r?.rate ?? null, value: v === null ? null : Math.abs(v) });
    }
  }
  return {
    ...base,
    category: orNull(val(n, 'CATEGORY')),
    unit,
    description: orNull(val(n, 'DESCRIPTION') || listValues(n, 'DESCRIPTION.LIST', 'DESCRIPTION').join(' ')),
    partNo: orNull(val(n, 'PARTNO') || listValues(n, 'MAILINGNAME.LIST', 'MAILINGNAME')[0] || ''),
    costingMethod: orNull(val(n, 'COSTINGMETHOD')),
    maintainBatches: yes(val(n, 'ISBATCHWISEON')),
    gst: gstInfo(n),
    openings,
  };
}

const BILL_TYPES: Record<string, TBill['type']> = {
  'new ref': 'new',
  'agst ref': 'against',
  'against ref': 'against',
  advance: 'advance',
  'on account': 'on_account',
};

function parseCosts(n: TNode): TCostAlloc[] {
  const out: TCostAlloc[] = [];
  for (const cat of kidsOf(n, 'CATEGORYALLOCATIONS.LIST')) {
    const category = orNull(val(cat, 'CATEGORY'));
    for (const cc of kidsOf(cat, 'COSTCENTREALLOCATIONS.LIST')) {
      const amt = ourAmount(val(cc, 'AMOUNT'));
      if (val(cc, 'NAME') && amt) out.push({ category, centre: val(cc, 'NAME'), amount: amt });
    }
  }
  for (const cc of kidsOf(n, 'COSTCENTREALLOCATIONS.LIST')) {
    const amt = ourAmount(val(cc, 'AMOUNT'));
    if (val(cc, 'NAME') && amt) out.push({ category: null, centre: val(cc, 'NAME'), amount: amt });
  }
  return out;
}

function parseEntry(n: TNode, fromInventory: boolean): TEntry | null {
  const ledger = val(n, 'LEDGERNAME');
  if (!ledger) return null;
  const amount = ourAmount(val(n, 'AMOUNT')) ?? 0;
  const bills: TBill[] = [];
  for (const b of kidsOf(n, 'BILLALLOCATIONS.LIST')) {
    const amt = ourAmount(val(b, 'AMOUNT'));
    if (amt === null || amt === 0) continue;
    const type = BILL_TYPES[clean(val(b, 'BILLTYPE')).toLowerCase()] ?? (val(b, 'NAME') ? 'against' : 'on_account');
    bills.push({ type, name: orNull(val(b, 'NAME')), amount: amt, creditDays: creditDays(val(b, 'BILLCREDITPERIOD')) });
  }
  const bankNode = kidsOf(n, 'BANKALLOCATIONS.LIST')[0];
  const bank: TBank | null = bankNode
    ? {
        type: orNull(val(bankNode, 'TRANSACTIONTYPE')),
        number: orNull(val(bankNode, 'INSTRUMENTNUMBER')),
        date: tallyDate(val(bankNode, 'INSTRUMENTDATE')),
        bankName: orNull(val(bankNode, 'BANKNAME')),
        favouring: orNull(val(bankNode, 'PAYMENTFAVOURING')),
        bankDate: tallyDate(val(bankNode, 'BANKERSDATE')),
      }
    : null;
  return { ledger, amount, bills, costs: parseCosts(n), bank, fromInventory };
}

function parseInventory(n: TNode, direction: 'in' | 'out' | null, enclosingLedger: string | null, entries: TEntry[]): TInventoryLine | null {
  const item = val(n, 'STOCKITEMNAME');
  if (!item) return null;
  const actual = tallyQty(val(n, 'ACTUALQTY'));
  const billed = tallyQty(val(n, 'BILLEDQTY'));
  const amt = ourAmount(val(n, 'AMOUNT'));
  const rate = tallyRate(val(n, 'RATE'));
  const allocations: TInvAlloc[] = [];
  for (const b of kidsOf(n, 'BATCHALLOCATIONS.LIST')) {
    const q = tallyQty(val(b, 'ACTUALQTY'));
    const bq = tallyQty(val(b, 'BILLEDQTY'));
    const a = ourAmount(val(b, 'AMOUNT'));
    const batch = val(b, 'BATCHNAME');
    const track = val(b, 'TRACKINGNUMBER');
    allocations.push({
      godown: orNull(val(b, 'GODOWNNAME')),
      batch: batch === '' || /^primary batch$/i.test(batch) ? null : batch,
      qty: q ? Math.abs(q.qty) : null,
      billedQty: bq ? Math.abs(bq.qty) : null,
      amount: a === null ? null : Math.abs(a),
      trackingNo: track === '' || /^not applicable$/i.test(track) ? null : track,
      orderNo: orNull(val(b, 'ORDERNO').replace(/^not applicable$/i, '')),
    });
  }
  let ledger = enclosingLedger;
  for (const a of kidsOf(n, 'ACCOUNTINGALLOCATIONS.LIST')) {
    const e = parseEntry(a, true);
    if (!e) continue;
    entries.push(e);
    ledger ??= e.ledger;
  }
  const qty = Math.abs(actual?.qty ?? billed?.qty ?? 0);
  return {
    item,
    qty,
    billedQty: billed ? Math.abs(billed.qty) : null,
    rate: rate?.rate ?? null,
    rateUnit: rate?.per ?? null,
    qtyUnit: actual?.unit ?? billed?.unit ?? null,
    discountPct: percent(val(n, 'DISCOUNT')) ?? 0,
    amount: Math.abs(amt ?? 0),
    direction,
    isDeemedPositive: yesNo(val(n, 'ISDEEMEDPOSITIVE')),
    ledger,
    allocations,
  };
}

function parseVoucher(n: TNode): TVoucher {
  const entries: TEntry[] = [];
  const inventory: TInventoryLine[] = [];
  for (const e of kidsOf(n, 'ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST')) {
    const entry = parseEntry(e, false);
    if (!entry) continue;
    entries.push(entry);
    // Accounting voucher view: items nested under their sales/purchase ledger entry.
    for (const inv of kidsOf(e, 'INVENTORYALLOCATIONS.LIST')) {
      const line = parseInventory(inv, null, entry.ledger, []);
      if (line) inventory.push(line);
    }
  }
  for (const inv of kidsOf(n, 'ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST')) {
    const line = parseInventory(inv, null, null, entries);
    if (line) inventory.push(line);
  }
  for (const inv of kidsOf(n, 'INVENTORYENTRIESIN.LIST')) {
    const line = parseInventory(inv, 'in', null, entries);
    if (line) inventory.push(line);
  }
  for (const inv of kidsOf(n, 'INVENTORYENTRIESOUT.LIST')) {
    const line = parseInventory(inv, 'out', null, entries);
    if (line) inventory.push(line);
  }
  const rawDate = val(n, 'DATE');
  return {
    vchType: clean(n.attrs.VCHTYPE) || val(n, 'VOUCHERTYPENAME'),
    date: tallyDate(rawDate),
    rawDate,
    number: orNull(val(n, 'VOUCHERNUMBER')),
    reference: orNull(val(n, 'REFERENCE')),
    referenceDate: tallyDate(val(n, 'REFERENCEDATE')),
    narration: orNull(val(n, 'NARRATION')),
    party: orNull(valAny(n, 'PARTYLEDGERNAME', 'PARTYNAME')),
    partyGstin: orNull(val(n, 'PARTYGSTIN').toUpperCase()),
    placeOfSupply: orNull(val(n, 'PLACEOFSUPPLY')),
    isOptional: yes(val(n, 'ISOPTIONAL')),
    isCancelled: yes(val(n, 'ISCANCELLED')),
    isInvoice: yes(val(n, 'ISINVOICE')),
    isPostDated: yes(val(n, 'ISPOSTDATED')),
    guid: orNull(val(n, 'GUID')),
    remoteId: orNull(clean(n.attrs.REMOTEID)),
    entries,
    inventory,
  };
}

/** Short label of a voucher for messages: 'Sales 12 (05-04-2026)'. */
export function voucherLabel(v: Pick<TVoucher, 'vchType' | 'number' | 'date' | 'rawDate'>): string {
  const d = v.date ? `${v.date.slice(8, 10)}-${v.date.slice(5, 7)}-${v.date.slice(0, 4)}` : v.rawDate || 'no date';
  return `${v.vchType || 'Voucher'}${v.number ? ` ${v.number}` : ''} (${d})`;
}

const emptyCounts = (): Record<TallyObjectType, number> => ({
  GROUP: 0,
  LEDGER: 0,
  COSTCATEGORY: 0,
  COSTCENTRE: 0,
  CURRENCY: 0,
  UNIT: 0,
  GODOWN: 0,
  STOCKGROUP: 0,
  STOCKCATEGORY: 0,
  STOCKITEM: 0,
  VOUCHERTYPE: 0,
  VOUCHER: 0,
});

/** Decode and parse a Tally XML export. Throws FileFormatError when it is not one. */
export function parseTallyFile(bytes: Uint8Array): TallyFile {
  if (bytes.length === 0) throw new FileFormatError('xml', 'The file is empty.');
  const { text, encoding } = decodeText(bytes);
  const { company, objects, root } = readTallyObjects(text);
  if (root !== 'ENVELOPE' && objects.length === 0) {
    throw new FileFormatError('xml', 'This is not a Tally XML export (it has no ENVELOPE). In Tally use Gateway › Export › Masters or Transactions with the XML format.');
  }
  const file: TallyFile = {
    encoding,
    companyName: company,
    groups: [],
    ledgers: [],
    costCategories: [],
    costCentres: [],
    currencies: [],
    units: [],
    godowns: [],
    stockGroups: [],
    stockCategories: [],
    stockItems: [],
    voucherTypes: [],
    vouchers: [],
    counts: emptyCounts(),
    unsupported: [],
    issues: [],
  };
  const unsupported = new Map<string, number>();
  for (const o of objects) {
    if (!SUPPORTED.has(o.name)) {
      unsupported.set(o.name, (unsupported.get(o.name) ?? 0) + 1);
      continue;
    }
    // ACTION="Delete" objects are removals in a sync file — nothing to import.
    if (/^delete$/i.test(clean(o.attrs.ACTION))) {
      unsupported.set(`${o.name} (delete)`, (unsupported.get(`${o.name} (delete)`) ?? 0) + 1);
      continue;
    }
    const type = o.name as TallyObjectType;
    file.counts[type]++;
    switch (type) {
      case 'GROUP':
        file.groups.push(parseGroup(o));
        break;
      case 'LEDGER':
        file.ledgers.push(parseLedger(o));
        break;
      case 'COSTCATEGORY':
        file.costCategories.push(parseNamed(o));
        break;
      case 'COSTCENTRE':
        file.costCentres.push({ ...parseNamed(o), category: orNull(val(o, 'CATEGORY')) });
        break;
      case 'CURRENCY':
        file.currencies.push({ name: objectName(o) || val(o, 'MAILINGNAME'), parent: null, aliases: [] });
        break;
      case 'UNIT':
        file.units.push(parseUnit(o));
        break;
      case 'GODOWN':
        file.godowns.push({ ...parseNamed(o), address: orNull(listValues(o, 'ADDRESS.LIST', 'ADDRESS').join(', ')) });
        break;
      case 'STOCKGROUP':
        file.stockGroups.push({ ...parseNamed(o), gst: gstInfo(o) });
        break;
      case 'STOCKCATEGORY':
        file.stockCategories.push(parseNamed(o));
        break;
      case 'STOCKITEM':
        file.stockItems.push(parseStockItem(o));
        break;
      case 'VOUCHERTYPE':
        file.voucherTypes.push({
          ...parseNamed(o),
          numberingMethod: orNull(val(o, 'NUMBERINGMETHOD')),
          isActive: !/^no$/i.test(val(o, 'ISACTIVE')),
          abbreviation: orNull(val(o, 'ABBR')),
        });
        break;
      case 'VOUCHER':
        file.vouchers.push(parseVoucher(o));
        break;
    }
  }
  for (const [type, count] of unsupported) file.unsupported.push({ type, count });
  file.unsupported.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  // Masters without a name cannot be imported.
  const nameless = (list: Array<{ name: string }>, type: string): void => {
    const n = list.filter((x) => !x.name).length;
    if (n > 0) file.issues.push({ severity: 'warning', code: 'missing_name', message: `${n} ${type.toLowerCase()} record(s) without a name will be skipped.` });
  };
  nameless(file.groups, 'GROUP');
  nameless(file.ledgers, 'LEDGER');
  nameless(file.stockItems, 'STOCKITEM');
  nameless(file.units, 'UNIT');
  for (const v of file.vouchers) {
    if (!v.date) file.issues.push({ severity: 'error', code: 'bad_date', message: `The voucher date "${v.rawDate}" is not a valid date.`, object: `VOUCHER ${voucherLabel(v)}` });
  }
  return file;
}

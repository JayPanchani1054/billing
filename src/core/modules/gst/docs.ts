/**
 * GST document loader — the one place that reads vouchers + gst_lines for GST reports.
 *
 * gst_lines is the single source of truth for values and tax: nothing here recomputes tax from items.
 * Each voucher becomes a GstDoc with:
 *   direction  outward (sales, credit notes, debit notes to customers) | inward (purchases, purchase returns)
 *   sign       +1 adds to the period's supplies / ITC, −1 reduces them:
 *                sales +1 · credit_note −1 · outward debit_note +1 · purchase +1 · inward debit_note −1 ·
 *                inward credit_note −1
 *   nature     vouchers.gst_nature (set by the posting engine); derived with classifySupply when NULL
 * gst_lines amounts are "as on the document" (unsigned except negative discount lines); multiply by
 * `sign` to get the period contribution.
 *
 * Books filter: affects_books = 1 AND (is_post_dated = 0 OR date <= today) — optional and cancelled
 * vouchers never count. `includeCancelled` additionally returns cancelled (non-optional) vouchers for
 * the documents-issued table; they carry inBooks = false.
 */
import { formatDate } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type { CompanyConfig, CompanyFeatures } from '../../../shared/settings.ts';
import {
  classifySupply,
  gstinStateCode,
  isOutwardNature,
  isRegisteredParty,
  normalizeGstin,
  normalizeStateCode,
  POS_OTHER_COUNTRIES,
  REGISTRATION_TYPES,
  stateName,
  validateGstin,
} from '../../../shared/gst/index.ts';
import type { CompanyRegistrationType, GstNature, RegistrationType, SupplyKind, Taxability } from '../../../shared/types/gst.ts';
import type { GstRateSplit, ItcEligibility, TaxAmounts, TaxValue } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { getCompanyProfile, getConfig, getFeatures } from '../company/service.ts';

export type GstBaseType = 'sales' | 'purchase' | 'credit_note' | 'debit_note';
export const GST_DOC_BASE_TYPES: readonly GstBaseType[] = ['sales', 'purchase', 'credit_note', 'debit_note'];
export type DocDirection = 'outward' | 'inward';

export interface GstDocLine {
  id: number;
  lineNo: number;
  source: 'item' | 'ledger';
  itemId: number | null;
  ledgerId: number | null;
  description: string;
  /** Trimmed HSN/SAC as recorded ('' when missing). */
  hsn: string;
  uqc: string;
  qty: number;
  supplyType: SupplyKind;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  reverseCharge: boolean;
  itcEligibility: ItcEligibility | null;
}

export interface GstParty {
  ledgerName: string | null;
  name: string | null;
  address: string | null;
  stateCode: string;
  gstin: string | null;
  registration: RegistrationType;
  pincode: string | null;
  phone: string | null;
  email: string | null;
}

export interface ConsigneeInfo {
  name: string | null;
  address: string | null;
  stateCode: string;
  gstin: string | null;
  pincode: string | null;
}

export interface DispatchInfo {
  docNo: string | null;
  through: string | null;
  destination: string | null;
  vehicleNo: string | null;
  transporterId: string | null;
  transporterName: string | null;
  mode: string | null;
  distanceKm: number | null;
  lrNo: string | null;
  lrDate: string | null;
}

export interface ExportInfo {
  shippingBillNo: string | null;
  shippingBillDate: string | null;
  portCode: string | null;
  withPayment: boolean | null;
  currency: string | null;
  exchangeRate: number | null;
}

export interface GstDoc {
  id: number;
  voucherTypeId: number;
  voucherTypeName: string;
  baseType: GstBaseType;
  number: string | null;
  numberSeq: number | null;
  date: string;
  referenceNo: string | null;
  referenceDate: string | null;
  partyLedgerId: number | null;
  party: GstParty;
  /** Normalised place of supply ('' when missing/invalid; '96' for exports). */
  pos: string;
  reverseCharge: boolean;
  isCancelled: boolean;
  isOptional: boolean;
  /** Counts in the books (false only for cancelled vouchers returned with includeCancelled). */
  inBooks: boolean;
  totalAmount: Paise;
  taxableAmount: Paise;
  taxAmount: Paise;
  roundOff: Paise;
  nature: GstNature;
  /** vouchers.gst_nature was set (false → derived here). */
  natureStored: boolean;
  direction: DocDirection;
  sign: 1 | -1;
  isNote: boolean;
  /** Outward: C credit note / D debit note. Inward: C supplier credit note / D purchase return. */
  noteType: 'C' | 'D' | null;
  /** Inter-state supply (outward: POS ≠ company state; inward: supplier state ≠ company state). */
  interState: boolean;
  /** Supplier's state (company state for outward). */
  supplierState: string;
  originalInvoiceNo: string | null;
  originalInvoiceDate: string | null;
  noteReason: string | null;
  irn: string | null;
  irnAckNo: string | null;
  irnAckDate: string | null;
  irnSignedQr: string | null;
  irnStatus: string | null;
  ewayBillNo: string | null;
  ewayBillDate: string | null;
  ewayValidUpto: string | null;
  consignee: ConsigneeInfo | null;
  dispatch: DispatchInfo | null;
  exportDetails: ExportInfo | null;
  lines: GstDocLine[];
}

export interface GstCompany {
  name: string;
  /** Mailing name (trade name), else the name. */
  tradeName: string;
  gstin: string | null;
  stateCode: string;
  registration: CompanyRegistrationType;
  address: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  config: CompanyConfig;
  features: CompanyFeatures;
}

export function loadCompany(db: Db): GstCompany {
  const p = getCompanyProfile(db);
  return {
    name: p.name,
    tradeName: p.mailingName || p.name,
    gstin: p.gstin ? normalizeGstin(p.gstin) : null,
    stateCode: normalizeStateCode(p.stateCode),
    registration: p.gstRegistrationType,
    address: p.address,
    pincode: p.pincode,
    phone: p.phone || p.mobile,
    email: p.email,
    config: getConfig(db),
    features: getFeatures(db),
  };
}

// ───────────────────────────── Tax arithmetic ─────────────────────────────

export const zeroTax = (): TaxAmounts => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
export const zeroTV = (): TaxValue => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

export function addTax(target: TaxAmounts, src: TaxAmounts, sign = 1): void {
  target.igst += sign * src.igst;
  target.cgst += sign * src.cgst;
  target.sgst += sign * src.sgst;
  target.cess += sign * src.cess;
}

export function addTV(target: TaxValue, src: TaxValue, sign = 1): void {
  target.taxable += sign * src.taxable;
  addTax(target, src, sign);
}

export function lineTV(l: GstDocLine): TaxValue {
  return { taxable: l.taxable, igst: l.igst, cgst: l.cgst, sgst: l.sgst, cess: l.cess };
}

export const taxTotal = (t: TaxAmounts): Paise => t.igst + t.cgst + t.sgst + t.cess;

export const isZeroTV = (t: TaxValue): boolean => t.taxable === 0 && t.igst === 0 && t.cgst === 0 && t.sgst === 0 && t.cess === 0;

/** Normalise -0 and keep integer paise. */
export function cleanTax<T extends TaxAmounts>(t: T): T {
  for (const k of Object.keys(t) as Array<keyof T>) if (t[k] === 0) (t as Record<keyof T, unknown>)[k] = 0;
  return t;
}

/** Per-rate split of lines (sorted by rate then cess rate), amounts multiplied by `sign`. */
export function rateSplit(lines: readonly GstDocLine[], sign = 1): GstRateSplit[] {
  const by = new Map<string, GstRateSplit>();
  for (const l of lines) {
    const key = `${l.rate}|${l.cessRate}`;
    let r = by.get(key);
    if (!r) {
      r = { rate: l.rate, cessRate: l.cessRate, ...zeroTV() };
      by.set(key, r);
    }
    addTV(r, lineTV(l), sign);
  }
  return [...by.values()].sort((a, b) => a.rate - b.rate || a.cessRate - b.cessRate);
}

// ───────────────────────────── JSON blobs on vouchers ─────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseConsignee(raw: string | null): ConsigneeInfo | null {
  const o = parseObject(raw);
  if (!o) return null;
  const c: ConsigneeInfo = {
    name: str(o.name),
    address: str(o.address),
    stateCode: normalizeStateCode(str(o.stateCode)),
    gstin: str(o.gstin) ? normalizeGstin(str(o.gstin)) : null,
    pincode: str(o.pincode),
  };
  return c.name || c.address || c.stateCode || c.gstin || c.pincode ? c : null;
}

export function parseDispatch(raw: string | null): DispatchInfo | null {
  const o = parseObject(raw);
  if (!o) return null;
  return {
    docNo: str(o.docNo),
    through: str(o.through),
    destination: str(o.destination),
    vehicleNo: str(o.vehicleNo),
    transporterId: str(o.transporterId),
    transporterName: str(o.transporterName),
    mode: str(o.mode),
    distanceKm: num(o.distanceKm),
    lrNo: str(o.lrNo),
    lrDate: str(o.lrDate),
  };
}

export function parseExport(raw: string | null): ExportInfo | null {
  const o = parseObject(raw);
  if (!o) return null;
  const withPayment = typeof o.withPayment === 'boolean' ? o.withPayment : typeof o.lut === 'boolean' ? !o.lut : null;
  return {
    shippingBillNo: str(o.shippingBillNo),
    shippingBillDate: str(o.shippingBillDate),
    portCode: str(o.portCode),
    withPayment,
    currency: str(o.currency),
    exchangeRate: num(o.exchangeRate),
  };
}

// ───────────────────────────── Loading ─────────────────────────────

interface VoucherRow {
  id: number;
  voucher_type_id: number;
  vt_name: string;
  base_type: GstBaseType;
  number: string | null;
  number_seq: number | null;
  date: string;
  reference_no: string | null;
  reference_date: string | null;
  party_ledger_id: number | null;
  party_name: string | null;
  party_address: string | null;
  party_state_code: string | null;
  party_gstin: string | null;
  party_registration_type: string | null;
  party_pincode: string | null;
  place_of_supply: string | null;
  is_optional: number;
  is_cancelled: number;
  in_books: number;
  is_reverse_charge: number;
  total_amount: number;
  taxable_amount: number;
  tax_amount: number;
  round_off: number;
  gst_nature: string | null;
  original_invoice_no: string | null;
  original_invoice_date: string | null;
  note_reason: string | null;
  irn: string | null;
  irn_ack_no: string | null;
  irn_ack_date: string | null;
  irn_signed_qr: string | null;
  irn_status: string | null;
  eway_bill_no: string | null;
  eway_bill_date: string | null;
  eway_valid_upto: string | null;
  consignee: string | null;
  dispatch: string | null;
  export_details: string | null;
  l_name: string | null;
  l_mailing_name: string | null;
  l_address: string | null;
  l_state_code: string | null;
  l_pincode: string | null;
  l_gstin: string | null;
  l_reg: string | null;
  l_phone: string | null;
  l_mobile: string | null;
  l_email: string | null;
}

interface LineRow {
  id: number;
  voucher_id: number;
  line_no: number;
  source: string;
  item_id: number | null;
  ledger_id: number | null;
  description: string | null;
  hsn_sac: string | null;
  uqc: string | null;
  qty: number | null;
  supply_type: string;
  taxability: string;
  rate: number;
  cess_rate: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  is_reverse_charge: number;
  itc_eligibility: string | null;
  item_name: string | null;
  ledger_name: string | null;
}

export interface LoadDocsOptions {
  from: string;
  to: string;
  /** Working date (books filter for post-dated vouchers). */
  today: string;
  baseTypes?: readonly GstBaseType[];
  /** Also return cancelled, non-optional vouchers (inBooks = false). */
  includeCancelled?: boolean;
  /** Restrict to these voucher ids (from/to still apply unless `anyDate`). */
  ids?: readonly number[];
  anyDate?: boolean;
  /**
   * Classification only (for the GSTR-3B credit chain, which walks the whole history): the voucher's
   * nature / direction / sign / inter-state flag / party registration and its lines' amounts, rate, supply
   * type, taxability, reverse charge and ITC eligibility are exact; display fields (names, addresses,
   * numbers, e-invoice / e-way bill data, HSN, descriptions, quantities) are left empty. Reading only the
   * columns the classification needs makes a long history ≈3× cheaper to load.
   */
  lean?: boolean;
}

const TAXABILITY_SET = new Set<string>(['taxable', 'exempt', 'nil_rated', 'non_gst']);
const ITC_SET = new Set<string>(['inputs', 'capital_goods', 'input_services', 'ineligible']);
const NATURE_SET = new Set<string>([
  'b2b', 'b2cl', 'b2cs', 'export_wpay', 'export_lut', 'sez_wpay', 'sez_lut', 'deemed_export', 'nil_exempt',
  'composition_outward', 'no_gst', 'inward_b2b', 'inward_rcm', 'inward_unregistered', 'inward_composition',
  'import_goods', 'import_services', 'inward_sez', 'inward_nil_exempt',
]);

/** Columns `loadDocs({ lean: true })` reads; the rest of a VoucherRow / LineRow is left empty. */
type LeanVoucherRow = Pick<
  VoucherRow,
  | 'id' | 'voucher_type_id' | 'base_type' | 'date' | 'party_state_code' | 'party_gstin' | 'party_registration_type' | 'place_of_supply'
  | 'is_optional' | 'is_cancelled' | 'in_books' | 'is_reverse_charge' | 'total_amount' | 'gst_nature' | 'export_details'
  | 'l_state_code' | 'l_gstin' | 'l_reg'
>;
type LeanLineRow = Pick<
  LineRow,
  'voucher_id' | 'supply_type' | 'taxability' | 'rate' | 'cess_rate' | 'taxable_value' | 'igst' | 'cgst' | 'sgst' | 'cess' | 'is_reverse_charge' | 'itc_eligibility'
>;

function fromLeanRow(r: LeanVoucherRow): VoucherRow {
  return {
    id: r.id,
    voucher_type_id: r.voucher_type_id,
    vt_name: '',
    base_type: r.base_type,
    number: null,
    number_seq: null,
    date: r.date,
    reference_no: null,
    reference_date: null,
    party_ledger_id: null,
    party_name: null,
    party_address: null,
    party_state_code: r.party_state_code,
    party_gstin: r.party_gstin,
    party_registration_type: r.party_registration_type,
    party_pincode: null,
    place_of_supply: r.place_of_supply,
    is_optional: r.is_optional,
    is_cancelled: r.is_cancelled,
    in_books: r.in_books,
    is_reverse_charge: r.is_reverse_charge,
    total_amount: r.total_amount,
    taxable_amount: 0,
    tax_amount: 0,
    round_off: 0,
    gst_nature: r.gst_nature,
    original_invoice_no: null,
    original_invoice_date: null,
    note_reason: null,
    irn: null,
    irn_ack_no: null,
    irn_ack_date: null,
    irn_signed_qr: null,
    irn_status: null,
    eway_bill_no: null,
    eway_bill_date: null,
    eway_valid_upto: null,
    consignee: null,
    dispatch: null,
    export_details: r.export_details,
    l_name: null,
    l_mailing_name: null,
    l_address: null,
    l_state_code: r.l_state_code,
    l_pincode: null,
    l_gstin: r.l_gstin,
    l_reg: r.l_reg,
    l_phone: null,
    l_mobile: null,
    l_email: null,
  };
}

function fromLeanLine(r: LeanLineRow): LineRow {
  return {
    id: 0,
    voucher_id: r.voucher_id,
    line_no: 0,
    source: 'item',
    item_id: null,
    ledger_id: null,
    description: null,
    hsn_sac: null,
    uqc: null,
    qty: null,
    supply_type: r.supply_type,
    taxability: r.taxability,
    rate: r.rate,
    cess_rate: r.cess_rate,
    taxable_value: r.taxable_value,
    igst: r.igst,
    cgst: r.cgst,
    sgst: r.sgst,
    cess: r.cess,
    is_reverse_charge: r.is_reverse_charge,
    itc_eligibility: r.itc_eligibility,
    item_name: null,
    ledger_name: null,
  };
}

function toRegistration(...candidates: Array<string | null>): RegistrationType | null {
  for (const c of candidates) if (c && (REGISTRATION_TYPES as readonly string[]).includes(c)) return c as RegistrationType;
  return null;
}

/** Load GST documents (sales, purchases, credit and debit notes) with their gst_lines. */
export function loadDocs(db: Db, company: GstCompany, opts: LoadDocsOptions): GstDoc[] {
  const baseTypes = opts.baseTypes ?? GST_DOC_BASE_TYPES;
  const where: string[] = [`v.base_type IN (SELECT value FROM json_each(:bt))`];
  const params: Record<string, string | number> = { bt: JSON.stringify(baseTypes), today: opts.today };
  if (!opts.anyDate) {
    where.push('v.date >= :from AND v.date <= :to');
    params.from = opts.from;
    params.to = opts.to;
  }
  if (opts.ids) {
    where.push('v.id IN (SELECT value FROM json_each(:ids))');
    params.ids = JSON.stringify(opts.ids);
  }
  const books = BOOKS_FILTER('v');
  where.push(opts.includeCancelled ? `((${books}) OR (v.is_cancelled = 1 AND v.is_optional = 0))` : `(${books})`);

  const from = `FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.date, v.number_seq, v.number, v.id`;
  const rows = opts.lean
    ? db
        .all<LeanVoucherRow>(
          `SELECT v.id, v.voucher_type_id, v.base_type, v.date, v.party_state_code, v.party_gstin, v.party_registration_type, v.place_of_supply,
                  v.is_optional, v.is_cancelled, (${books}) AS in_books, v.is_reverse_charge, v.total_amount, v.gst_nature, v.export_details,
                  l.state_code AS l_state_code, l.gstin AS l_gstin, l.gst_registration_type AS l_reg
             ${from}`,
          params,
        )
        .map(fromLeanRow)
    : db.all<VoucherRow>(
        `SELECT v.id, v.voucher_type_id, vt.name AS vt_name, v.base_type, v.number, v.number_seq, v.date, v.reference_no, v.reference_date,
                v.party_ledger_id, v.party_name, v.party_address, v.party_state_code, v.party_gstin, v.party_registration_type, v.party_pincode,
                v.place_of_supply, v.is_optional, v.is_cancelled, (${books}) AS in_books, v.is_reverse_charge,
                v.total_amount, v.taxable_amount, v.tax_amount, v.round_off, v.gst_nature, v.original_invoice_no, v.original_invoice_date,
                v.note_reason, v.irn, v.irn_ack_no, v.irn_ack_date, v.irn_signed_qr, v.irn_status, v.eway_bill_no, v.eway_bill_date,
                v.eway_valid_upto, v.consignee, v.dispatch, v.export_details,
                l.name AS l_name, l.mailing_name AS l_mailing_name, l.address AS l_address, l.state_code AS l_state_code, l.pincode AS l_pincode,
                l.gstin AS l_gstin, l.gst_registration_type AS l_reg, l.phone AS l_phone, l.mobile AS l_mobile, l.email AS l_email
           ${from}`,
        params,
      );
  if (rows.length === 0) return [];

  const ids = { ids: JSON.stringify(rows.map((r) => r.id)) };
  const lineRows = opts.lean
    ? db
        .all<LeanLineRow>(
          `SELECT g.voucher_id, g.supply_type, g.taxability, g.rate, g.cess_rate, g.taxable_value, g.igst, g.cgst, g.sgst, g.cess,
                  g.is_reverse_charge, g.itc_eligibility
             FROM gst_lines g
            WHERE g.voucher_id IN (SELECT value FROM json_each(:ids))
            ORDER BY g.voucher_id, g.line_no, g.id`,
          ids,
        )
        .map(fromLeanLine)
    : db.all<LineRow>(
        `SELECT g.id, g.voucher_id, g.line_no, g.source, g.item_id, g.ledger_id, g.description, g.hsn_sac, g.uqc, g.qty, g.supply_type,
                g.taxability, g.rate, g.cess_rate, g.taxable_value, g.igst, g.cgst, g.sgst, g.cess, g.is_reverse_charge, g.itc_eligibility,
                si.name AS item_name, ld.name AS ledger_name
           FROM gst_lines g
           LEFT JOIN stock_items si ON si.id = g.item_id
           LEFT JOIN ledgers ld ON ld.id = g.ledger_id
          WHERE g.voucher_id IN (SELECT value FROM json_each(:ids))
          ORDER BY g.voucher_id, g.line_no, g.id`,
        ids,
      );
  const linesBy = new Map<number, GstDocLine[]>();
  for (const r of lineRows) {
    const list = linesBy.get(r.voucher_id) ?? [];
    list.push({
      id: r.id,
      lineNo: r.line_no,
      source: r.source === 'ledger' ? 'ledger' : 'item',
      itemId: r.item_id,
      ledgerId: r.ledger_id,
      description: (r.description ?? r.item_name ?? r.ledger_name ?? '').trim(),
      hsn: (r.hsn_sac ?? '').replace(/\s+/g, ''),
      uqc: (r.uqc ?? '').trim().toUpperCase(),
      qty: r.qty ?? 0,
      supplyType: r.supply_type === 'services' ? 'services' : 'goods',
      taxability: (TAXABILITY_SET.has(r.taxability) ? r.taxability : 'taxable') as Taxability,
      rate: r.rate ?? 0,
      cessRate: r.cess_rate ?? 0,
      taxable: r.taxable_value,
      igst: r.igst,
      cgst: r.cgst,
      sgst: r.sgst,
      cess: r.cess,
      reverseCharge: r.is_reverse_charge === 1,
      itcEligibility: r.itc_eligibility && ITC_SET.has(r.itc_eligibility) ? (r.itc_eligibility as ItcEligibility) : null,
    });
    linesBy.set(r.voucher_id, list);
  }

  return rows.map((r) => buildDoc(r, linesBy.get(r.id) ?? [], company));
}

function buildDoc(r: VoucherRow, lines: GstDocLine[], company: GstCompany): GstDoc {
  const gstin = r.party_gstin ? normalizeGstin(r.party_gstin) : r.l_gstin ? normalizeGstin(r.l_gstin) : null;
  const registration = toRegistration(r.party_registration_type, r.l_reg) ?? (gstin ? 'regular' : 'unregistered');
  const party: GstParty = {
    ledgerName: r.l_name,
    name: r.party_name ?? r.l_mailing_name ?? r.l_name,
    address: r.party_address ?? r.l_address,
    stateCode: normalizeStateCode(r.party_state_code ?? r.l_state_code) || (gstin ? gstinStateCode(gstin) : ''),
    gstin: gstin || null,
    registration,
    pincode: r.party_pincode ?? r.l_pincode,
    phone: r.l_phone ?? r.l_mobile,
    email: r.l_email,
  };
  const exportDetails = parseExport(r.export_details);
  const reverseCharge = r.is_reverse_charge === 1 || lines.some((l) => l.reverseCharge);
  const stored = r.gst_nature && NATURE_SET.has(r.gst_nature) ? (r.gst_nature as GstNature) : null;
  const defaultDirection: DocDirection = r.base_type === 'sales' || r.base_type === 'credit_note' ? 'outward' : 'inward';

  // Supplier state and inter-state flag.
  const anyIgst = lines.some((l) => l.igst !== 0);
  let pos = normalizeStateCode(r.place_of_supply);

  const deriveNature = (direction: DocDirection, interState: boolean): GstNature => {
    let goods = 0;
    let services = 0;
    let anyTaxable = false;
    for (const l of lines) {
      if (l.taxable === 0) continue;
      if (l.supplyType === 'services') services += l.taxable;
      else goods += l.taxable;
      if (l.taxability === 'taxable') anyTaxable = true;
    }
    return classifySupply(
      {
        direction,
        companyRegistration: company.registration,
        partyRegistration: registration,
        interState,
        reverseCharge,
        exportWithPayment: exportDetails?.withPayment ?? false,
        b2clThresholdPaise: company.config.gst.b2clThresholdPaise,
      },
      { invoiceValue: r.total_amount, allNonTaxable: lines.length > 0 && !anyTaxable, goodsValue: goods, servicesValue: services },
    );
  };

  let direction: DocDirection = stored ? (isOutwardNature(stored) ? 'outward' : 'inward') : defaultDirection;
  // A purchase can never be outward nor a sale inward, whatever the stored nature says.
  if (r.base_type === 'sales') direction = 'outward';
  if (r.base_type === 'purchase') direction = 'inward';

  const supplierState = direction === 'outward' ? company.stateCode : party.stateCode;
  let interState: boolean;
  if (direction === 'outward') {
    if (stored && (stored.startsWith('export') || stored.startsWith('sez'))) interState = true;
    else if (pos && company.stateCode) interState = pos !== company.stateCode;
    else interState = anyIgst;
  } else if (registration === 'overseas' || (stored !== null && stored.startsWith('import'))) {
    interState = true;
  } else if (supplierState && company.stateCode) {
    interState = supplierState !== company.stateCode;
  } else {
    interState = anyIgst;
  }

  let nature = stored ?? deriveNature(direction, interState);
  if (stored && (isOutwardNature(stored) ? 'outward' : 'inward') !== direction) nature = deriveNature(direction, interState);
  if (direction === 'outward' && (nature === 'export_wpay' || nature === 'export_lut')) pos = POS_OTHER_COUNTRIES;
  if (direction === 'inward' && !pos) pos = company.stateCode;

  const isNote = r.base_type === 'credit_note' || r.base_type === 'debit_note';
  let sign: 1 | -1 = 1;
  if (r.base_type === 'credit_note') sign = -1;
  else if (r.base_type === 'debit_note') sign = direction === 'outward' ? 1 : -1;
  const noteType = r.base_type === 'credit_note' ? 'C' : r.base_type === 'debit_note' ? 'D' : null;

  return {
    id: r.id,
    voucherTypeId: r.voucher_type_id,
    voucherTypeName: r.vt_name,
    baseType: r.base_type,
    number: r.number,
    numberSeq: r.number_seq,
    date: r.date,
    referenceNo: r.reference_no,
    referenceDate: r.reference_date,
    partyLedgerId: r.party_ledger_id,
    party,
    pos,
    reverseCharge,
    isCancelled: r.is_cancelled === 1,
    isOptional: r.is_optional === 1,
    inBooks: r.in_books === 1,
    totalAmount: r.total_amount,
    taxableAmount: r.taxable_amount,
    taxAmount: r.tax_amount,
    roundOff: r.round_off,
    nature,
    natureStored: stored !== null,
    direction,
    sign,
    isNote,
    noteType,
    interState,
    supplierState,
    originalInvoiceNo: r.original_invoice_no,
    originalInvoiceDate: r.original_invoice_date,
    noteReason: r.note_reason,
    irn: r.irn,
    irnAckNo: r.irn_ack_no,
    irnAckDate: r.irn_ack_date,
    irnSignedQr: r.irn_signed_qr,
    irnStatus: r.irn_status,
    ewayBillNo: r.eway_bill_no,
    ewayBillDate: r.eway_bill_date,
    ewayValidUpto: r.eway_valid_upto,
    consignee: parseConsignee(r.consignee),
    dispatch: parseDispatch(r.dispatch),
    exportDetails,
    lines,
  };
}

// ───────────────────────────── Helpers for reports ─────────────────────────────

/** 'Sales 12 dated 05-Apr-2026' — for messages. */
export function docLabel(d: Pick<GstDoc, 'voucherTypeName' | 'number' | 'date'>): string {
  return `${d.voucherTypeName} ${d.number ?? '(no number)'} dated ${formatDate(d.date)}`;
}

/** Party holds a GSTIN/UIN (B2B side of tables 8 and 12). */
export function isRegisteredDoc(d: GstDoc): boolean {
  if (d.party.registration === 'overseas') return false;
  return isRegisteredParty(d.party.registration) || (d.party.gstin !== null && validateGstin(d.party.gstin).valid);
}

export function posName(code: string): string {
  return code ? stateName(code) || code : '';
}

/** HSN/SAC as reported: digits only, truncated to `digits` when longer. */
export function reportHsn(hsn: string, digits: number): string {
  const h = hsn.replace(/\D/g, '');
  return h.length > digits ? h.slice(0, digits) : h;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Paise → rupees number for JSON files (exact two-decimal value). */
export const rupees = (p: Paise): number => (p === 0 ? 0 : p / 100);

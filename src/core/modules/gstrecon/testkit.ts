/**
 * Test helpers for gstrecon (used by *.test.ts only): portal-file builders (2B / 2A / GSTR-1 JSON,
 * 2B-style Excel) and a direct writer of purchase/sales vouchers with gst_lines, so matching tests
 * control every paisa. Integration tests post through the real voucher engine instead.
 */
import { randomUUID } from 'node:crypto';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { ReconSource } from '../../../shared/types/gstrecon.ts';
import type { RouteMap } from '../../api/route.ts';
import { writeXlsx, type XlsxCell } from '../../lib/xlsx.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import type { BooksRec, PortalRec } from './matcher.ts';
import { gstreconRoutes } from './routes.ts';

export const routes: RouteMap = gstreconRoutes;

export const S1 = makeGstin('27', testPan(11));
export const S2 = makeGstin('29', testPan(12));
export const S3 = makeGstin('27', testPan(13));

/** Rupees → paise for readable fixtures. */
export const P = (rupees: number): number => Math.round(rupees * 100);

export const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

// ───────────────────────────── Portal JSON builders (amounts in rupees) ─────────────────────────────

export type Item = [rt: number, txval: number, igst: number, cgst: number, sgst: number, cess?: number];

export interface Inv2b {
  inum: string;
  dt: string;
  val?: number;
  pos?: string;
  rev?: 'Y' | 'N';
  itcavl?: 'Y' | 'N' | 'T';
  rsn?: string;
  typ?: string;
  items: Item[];
  oinum?: string;
  oidt?: string;
}

const items2b = (items: Item[]): Array<Record<string, number>> =>
  items.map(([rt, txval, igst, cgst, sgst, cess = 0], i) => ({ num: i + 1, rt, txval, igst, cgst, sgst, cess }));

const total = (items: Item[]): number => Math.round(items.reduce((a, [, tx, i, c, s, cs = 0]) => a + tx + i + c + s + cs, 0) * 100) / 100;

export function inv2b(i: Inv2b): Record<string, unknown> {
  return {
    inum: i.inum,
    typ: i.typ ?? 'R',
    dt: i.dt,
    val: i.val ?? total(i.items),
    pos: i.pos ?? '27',
    rev: i.rev ?? 'N',
    itcavl: i.itcavl ?? 'Y',
    rsn: i.rsn ?? '',
    diffprcnt: 1,
    srctyp: 'e-Invoice',
    irn: 'a'.repeat(64),
    irngendate: i.dt,
    ...(i.oinum ? { oinum: i.oinum, oidt: i.oidt } : {}),
    items: items2b(i.items),
  };
}

export interface Nt2b {
  ntnum: string;
  typ: 'C' | 'D';
  dt: string;
  pos?: string;
  items: Item[];
  itcavl?: 'Y' | 'N';
}

export function nt2b(n: Nt2b): Record<string, unknown> {
  return {
    ntnum: n.ntnum,
    typ: n.typ,
    suptyp: 'R',
    dt: n.dt,
    val: total(n.items),
    pos: n.pos ?? '27',
    rev: 'N',
    itcavl: n.itcavl ?? 'Y',
    rsn: '',
    diffprcnt: 1,
    srctyp: '',
    items: items2b(n.items),
  };
}

export interface Supplier2b {
  ctin: string;
  trdnm?: string;
  supprd?: string;
  supfildt?: string;
  inv?: Inv2b[];
  nt?: Nt2b[];
}

/** A GSTR-2B JSON as downloaded from the portal ({ chksum, data: { …, docdata } }). */
export function gstr2bJson(opts: {
  gstin: string;
  rtnprd: string;
  b2b?: Supplier2b[];
  b2ba?: Supplier2b[];
  cdnr?: Supplier2b[];
  extra?: Record<string, unknown>;
  wrap?: boolean;
}): Record<string, unknown> {
  const party = (s: Supplier2b, key: 'inv' | 'nt'): Record<string, unknown> => ({
    ctin: s.ctin,
    trdnm: s.trdnm ?? `Supplier ${s.ctin.slice(2, 7)}`,
    supfildt: s.supfildt ?? '11-05-2026',
    supprd: s.supprd ?? opts.rtnprd,
    [key]: key === 'inv' ? (s.inv ?? []).map(inv2b) : (s.nt ?? []).map(nt2b),
  });
  const docdata: Record<string, unknown> = { ...(opts.extra ?? {}) };
  if (opts.b2b) docdata.b2b = opts.b2b.map((s) => party(s, 'inv'));
  if (opts.b2ba) docdata.b2ba = opts.b2ba.map((s) => party(s, 'inv'));
  if (opts.cdnr) docdata.cdnr = opts.cdnr.map((s) => party(s, 'nt'));
  const data = { gstin: opts.gstin, rtnprd: opts.rtnprd, version: '1.0', gendt: '14-05-2026', itcsumm: {}, docdata };
  return opts.wrap === false ? data : { chksum: 'x', data };
}

const itms2a = (items: Item[]): Array<Record<string, unknown>> =>
  items.map(([rt, txval, iamt, camt, samt, csamt = 0], i) => ({ num: i + 1, itm_det: { rt, txval, iamt, camt, samt, csamt } }));

/** GSTR-2A / GSTR-1 style document ({ inum, idt, val, pos, rchrg, inv_typ, itms }). */
export function inv2a(i: { inum: string; idt: string; pos?: string; rchrg?: 'Y' | 'N'; items: Item[]; val?: number; oinum?: string; oidt?: string }): Record<string, unknown> {
  return {
    inum: i.inum,
    idt: i.idt,
    val: i.val ?? total(i.items),
    pos: i.pos ?? '27',
    rchrg: i.rchrg ?? 'N',
    inv_typ: 'R',
    ...(i.oinum ? { oinum: i.oinum, oidt: i.oidt } : {}),
    itms: itms2a(i.items),
  };
}

export function nt2a(n: { nt_num: string; nt_dt: string; ntty: 'C' | 'D'; pos?: string; items: Item[] }): Record<string, unknown> {
  return { ntty: n.ntty, nt_num: n.nt_num, nt_dt: n.nt_dt, val: total(n.items), pos: n.pos ?? '27', rchrg: 'N', inv_typ: 'R', itms: itms2a(n.items) };
}

// ───────────────────────────── 2B-style Excel ─────────────────────────────

/** Header block of the portal's B2B sheet: two rows with merged group cells (merged cells are empty). */
export const B2B_HEAD_1: XlsxCell[] = [
  'GSTIN of supplier', 'Trade/Legal name', 'Invoice Details', null, null, null, 'Place of supply', 'Supply Attract Reverse Charge',
  'Taxable Value (₹)', 'Tax Amount', null, null, null, 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability',
  'Reason', 'Applicable % of Tax Rate', 'Source', 'IRN', 'IRN Date',
];
export const B2B_HEAD_2: XlsxCell[] = [
  null, null, 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', null, null, null, 'Integrated Tax(₹)', 'Central Tax(₹)',
  'State/UT Tax(₹)', 'Cess(₹)', null, null, null, null, null, null, null, null,
];
export const CDNR_HEAD_1: XlsxCell[] = [
  'GSTIN of supplier', 'Trade/Legal name', 'Credit note/Debit note details', null, null, null, null, 'Place of supply',
  'Supply Attract Reverse Charge', 'Taxable Value (₹)', 'Tax Amount', null, null, null, 'GSTR-1/IFF/GSTR-5 Period',
  'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason', 'Applicable % of Tax Rate', 'Source', 'IRN', 'IRN Date',
];
export const CDNR_HEAD_2: XlsxCell[] = [
  null, null, 'Note number', 'Note type', 'Note Supply type', 'Note date', 'Note Value (₹)', null, null, null, 'Integrated Tax(₹)',
  'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)', null, null, null, null, null, null, null, null,
];

export function excel2b(opts: { readme?: XlsxCell[][]; b2b?: XlsxCell[][]; cdnr?: XlsxCell[][]; extraSheets?: Array<{ name: string; rows: XlsxCell[][] }> }): Uint8Array {
  const title = (t: string): XlsxCell[][] => [['Goods and Services Tax - GSTR-2B'], [], [t], []];
  const sheets = [
    { name: 'Read me', rows: opts.readme ?? [['Goods and Services Tax - GSTR 2B'], [], ['Financial Year', '2026-27'], ['Tax Period', 'April'], ['GSTIN', '']] },
    { name: 'ITC Available', rows: [['Summary'], ['Part A', 'B2B', 1, 2]] },
  ];
  if (opts.b2b) sheets.push({ name: 'B2B', rows: [...title('Taxable inward supplies received from registered persons'), B2B_HEAD_1, B2B_HEAD_2, ...opts.b2b] });
  if (opts.cdnr) sheets.push({ name: 'B2B-CDNR', rows: [...title('Debit/Credit notes (Original)'), CDNR_HEAD_1, CDNR_HEAD_2, ...opts.cdnr] });
  for (const s of opts.extraSheets ?? []) sheets.push(s);
  return writeXlsx({ sheets });
}

// ───────────────────────────── Company & books ─────────────────────────────

export interface ReconKit {
  t: TestCompany;
  gstin: string;
  /** Supplier ledgers by GSTIN. */
  party: Record<string, number>;
}

/** GST company in Maharashtra (27) dated 20-May-2026 with three supplier ledgers (S1, S2, S3) and two customers. */
export function setupRecon(opts: { today?: string; security?: boolean } = {}): ReconKit {
  const t = createTestCompany({ today: opts.today ?? '2026-05-20', stateCode: '27', security: opts.security });
  const gstin = makeGstin('27');
  const party: Record<string, number> = {
    [S1]: t.addLedger({ name: 'Supreme Suppliers', group: 'SUNDRY_CREDITORS', gstin: S1 }),
    [S2]: t.addLedger({ name: 'Bangalore Components', group: 'SUNDRY_CREDITORS', gstin: S2 }),
    [S3]: t.addLedger({ name: 'Local Traders', group: 'SUNDRY_CREDITORS', gstin: S3 }),
  };
  return { t, gstin, party };
}

export interface BookLine {
  rate: number;
  taxable: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
  taxability?: 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';
  itc?: 'inputs' | 'capital_goods' | 'input_services' | 'ineligible';
}

export interface BookDoc {
  baseType?: VoucherBaseType;
  gstin: string | null;
  partyLedgerId?: number | null;
  number?: string;
  date: string;
  referenceNo?: string | null;
  referenceDate?: string | null;
  pos?: string | null;
  rcm?: boolean;
  nature?: string | null;
  optional?: boolean;
  cancelled?: boolean;
  lines: BookLine[];
}

let seq = 0;

/** Insert a voucher with gst_lines directly (amounts in paise). Returns the voucher id. */
export function addBooksDoc(k: ReconKit, d: BookDoc): number {
  const t = k.t;
  const base = d.baseType ?? 'purchase';
  const taxable = d.lines.reduce((a, l) => a + l.taxable, 0);
  const tax = d.lines.reduce((a, l) => a + (l.igst ?? 0) + (l.cgst ?? 0) + (l.sgst ?? 0) + (l.cess ?? 0), 0);
  const now = t.clock.now().toISOString();
  const affects = d.optional || d.cancelled ? 0 : 1;
  const partyId = d.partyLedgerId !== undefined ? d.partyLedgerId : d.gstin ? (k.party[d.gstin] ?? null) : null;
  const nature = d.nature !== undefined ? d.nature : base === 'sales' || (base === 'credit_note' && d.nature === undefined) ? 'b2b' : 'inward_b2b';
  const id = t.db.run(
    `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, date, reference_no, reference_date, party_ledger_id, party_name,
       party_gstin, place_of_supply, invoice_mode, is_optional, is_cancelled, affects_books, is_reverse_charge, total_amount, taxable_amount,
       tax_amount, gst_nature, created_at, updated_at)
     VALUES (:guid, :vt, :base, :number, :date, :ref, :refDate, :party, :pname, :gstin, :pos, 'accounting', :opt, :canc, :affects, :rcm,
       :total, :taxable, :tax, :nature, :now, :now)`,
    {
      guid: randomUUID(),
      vt: t.ids.voucherTypes[base],
      base,
      number: d.number ?? `${base.slice(0, 1).toUpperCase()}${++seq}`,
      date: d.date,
      ref: d.referenceNo === undefined ? null : d.referenceNo,
      refDate: d.referenceDate === undefined ? d.date : d.referenceDate,
      party: partyId,
      pname: partyId ? null : 'Party',
      gstin: d.gstin,
      pos: d.pos === undefined ? '27' : d.pos,
      opt: d.optional ?? false,
      canc: d.cancelled ?? false,
      affects,
      rcm: d.rcm ?? false,
      total: taxable + tax,
      taxable,
      tax,
      nature,
      now,
    },
  ).lastInsertRowid;
  d.lines.forEach((l, i) => {
    t.db.run(
      `INSERT INTO gst_lines (voucher_id, line_no, source, taxability, rate, taxable_value, igst, cgst, sgst, cess, is_reverse_charge,
         itc_eligibility, date, affects_books)
       VALUES (:vid, :line, 'ledger', :tx, :rate, :taxable, :igst, :cgst, :sgst, :cess, :rcm, :itc, :date, :affects)`,
      {
        vid: id,
        line: i + 1,
        tx: l.taxability ?? 'taxable',
        rate: l.rate,
        taxable: l.taxable,
        igst: l.igst ?? 0,
        cgst: l.cgst ?? 0,
        sgst: l.sgst ?? 0,
        cess: l.cess ?? 0,
        rcm: d.rcm ?? false,
        itc: l.itc ?? (base === 'sales' ? null : 'inputs'),
        date: d.date,
        affects,
      },
    );
  });
  return id;
}

/** Import a file through the route and return the result data (throws on error). */
export async function importFile(k: ReconKit, source: ReconSource, bytes: Uint8Array, extra: { period?: string; replace?: boolean; fileName?: string } = {}): Promise<{ batchId: number; docCount: number; period: string; warnings: string[] }> {
  return k.t.callOk(routes, 'gstrecon.import', { source, bytes, fileName: extra.fileName ?? `${source}.json`, period: extra.period, replace: extra.replace });
}

// ───────────────────────────── Pure matcher fixtures ─────────────────────────────

let pid = 0;
export function prec(over: Partial<PortalRec> & Pick<PortalRec, 'gstin' | 'docNo' | 'docDate'>): PortalRec {
  return {
    id: over.id ?? ++pid,
    docType: 'invoice',
    pos: '27',
    reverseCharge: false,
    taxable: 1_000_00,
    igst: 0,
    cgst: 90_00,
    sgst: 90_00,
    cess: 0,
    invoiceValue: 0,
    rates: [18],
    itcAvailable: true,
    ...over,
  };
}

let vid = 1000;
export function brec(over: Partial<BooksRec> & Pick<BooksRec, 'gstin' | 'docNo' | 'docDate'>): BooksRec {
  const id = over.voucherId ?? ++vid;
  const b: BooksRec = {
    voucherId: id,
    baseType: 'purchase',
    voucherTypeName: 'Purchase',
    number: String(id),
    voucherDate: over.docDate,
    docNoBasis: 'reference_no',
    dateBasis: 'reference_date',
    gstinFromLedger: false,
    partyLedgerId: null,
    partyName: 'Supplier',
    pos: '27',
    reverseCharge: false,
    cls: 'inc',
    docType: 'invoice',
    nature: 'inward_b2b',
    taxable: 1_000_00,
    igst: 0,
    cgst: 90_00,
    sgst: 90_00,
    cess: 0,
    eligible: { igst: 0, cgst: 90_00, sgst: 90_00, cess: 0 },
    invoiceValue: 0,
    rates: [18],
    period: `${over.docDate.slice(5, 7)}${over.docDate.slice(0, 4)}`,
    updatedAt: '',
    inRange: true,
    ...over,
  };
  if (!over.eligible) b.eligible = { igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess };
  return b;
}

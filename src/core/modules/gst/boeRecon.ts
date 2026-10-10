/**
 * Bills of entry: register (from the books) and reconciliation with the import sections of GSTR-2B
 * (IMPG — imports from overseas; IMPGSEZ — goods from SEZ units). GSTR-2B shows the bills of entry
 * received from ICEGATE; ITC on them is claimed in GSTR-3B 4(A)(1).
 *
 * GSTR-2B JSON (as downloaded from the portal; keys read leniently, amounts in rupees):
 *   data.docdata.impg:    [{ refdt, portcode, boenum, boedt, isamd, txval, igst, cess }]
 *   data.docdata.impgsez: [{ ctin, trdnm, boe: [{ refdt, portcode, boenum, boedt, isamd, txval, igst, cess }] }]
 * Matching: port code + BOE number (digits only, leading zeros ignored), then the date; amounts within ₹1.
 * The reconciliation is read-only (nothing is stored): re-run it after each 2B download.
 */
import type { Paise } from '../../../shared/money.ts';
import type { BoeReconResult, BoeReconRow, BoeRow, PortalBoe } from '../../../shared/types/gst-plus.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { decodeText, stripBom } from '../../lib/text.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { parsePortalAmount, parsePortalDate } from '../gstrecon/values.ts';

export function listBillsOfEntry(db: Db, from: string, to: string, today: string): BoeRow[] {
  return db
    .all<{
      voucher_id: number;
      number: string | null;
      date: string;
      party: string | null;
      boe_no: string;
      boe_date: string;
      port_code: string | null;
      assessable_value: number;
      customs_duty: number;
      igst: number;
      cess: number;
      itc_claimed: number;
    }>(
      `SELECT b.voucher_id, v.number, b.date, COALESCE(v.party_name, l.name) AS party, b.boe_no, b.boe_date, b.port_code, b.assessable_value,
              b.customs_duty, b.igst, b.cess, b.itc_claimed
         FROM gst_bill_of_entry b JOIN vouchers v ON v.id = b.voucher_id LEFT JOIN ledgers l ON l.id = v.party_ledger_id
        WHERE b.date >= :from AND b.date <= :to AND ${BOOKS_FILTER('b')}
        ORDER BY b.boe_date, b.boe_no`,
      { from, to, today },
    )
    .map((r) => ({
      voucherId: r.voucher_id,
      voucherNumber: r.number,
      date: r.date,
      supplier: r.party,
      boeNo: r.boe_no,
      boeDate: r.boe_date,
      portCode: r.port_code,
      assessableValue: r.assessable_value,
      customsDuty: r.customs_duty,
      igst: r.igst,
      cess: r.cess,
      itcClaimed: r.itc_claimed === 1,
    }));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Parse the import sections of a GSTR-2B JSON file. */
export function parse2bImports(bytes: Uint8Array): { period: string | null; docs: PortalBoe[]; warnings: string[] } {
  let root: unknown;
  try {
    root = JSON.parse(stripBom(decodeText(bytes).text));
  } catch {
    throw validation([{ path: 'bytes', message: 'This file is not valid JSON. Download GSTR-2B as JSON from the portal and choose that file.' }]);
  }
  if (!isObj(root)) throw validation([{ path: 'bytes', message: 'This is not a GSTR-2B JSON file.' }]);
  const data = isObj(root.data) ? root.data : root;
  const docdata = isObj(data.docdata) ? data.docdata : data;
  const warnings: string[] = [];
  const docs: PortalBoe[] = [];
  const amount = (v: unknown, where: string): Paise => {
    const p = parsePortalAmount(v);
    if (p === null) {
      warnings.push(`${where}: amount "${String(v)}" could not be read (taken as 0).`);
      return 0;
    }
    return p;
  };
  const one = (section: 'impg' | 'impgsez', d: Obj, ctin: string | null): void => {
    const boeNo = str(d.boenum ?? d.boeNum ?? d.boe_num);
    if (!boeNo) return;
    docs.push({
      section,
      supplierGstin: ctin,
      boeNo,
      boeDate: parsePortalDate(d.boedt ?? d.boeDt),
      portCode: str(d.portcode ?? d.portCode).toUpperCase() || null,
      taxable: amount(d.txval, `BOE ${boeNo}`),
      igst: amount(d.igst ?? d.iamt, `BOE ${boeNo}`),
      cess: amount(d.cess ?? d.csamt, `BOE ${boeNo}`),
      amended: str(d.isamd).toUpperCase() === 'Y',
    });
  };
  for (const d of arr(docdata.impg)) if (isObj(d)) one('impg', d, null);
  for (const s of arr(docdata.impgsez)) {
    if (!isObj(s)) continue;
    const ctin = str(s.ctin) || null;
    const list = arr(s.boe).length > 0 ? arr(s.boe) : [s];
    for (const d of list) if (isObj(d)) one('impgsez', d, ctin);
  }
  if (docs.length === 0) warnings.push('The file has no bills of entry (IMPG / IMPGSEZ sections are empty or missing).');
  const period = str(data.rtnprd ?? root.rtnprd) || null;
  return { period, docs, warnings };
}

const normNo = (s: string): string => s.replace(/\D/g, '').replace(/^0+/, '') || s.trim().toUpperCase();
const TOLERANCE = 100;

export function reconcileBoe(db: Db, bytes: Uint8Array, from: string, to: string, today: string): BoeReconResult {
  const parsed = parse2bImports(bytes);
  const books = listBillsOfEntry(db, from, to, today);
  const used = new Set<number>();
  const rows: BoeReconRow[] = [];
  for (const p of parsed.docs) {
    const candidates = books.filter((b, i) => !used.has(i) && normNo(b.boeNo) === normNo(p.boeNo) && (!p.portCode || !b.portCode || p.portCode === b.portCode));
    const exact = candidates.find((b) => b.boeDate === p.boeDate) ?? candidates[0];
    if (!exact) {
      rows.push({ status: 'missing_in_books', boeNo: p.boeNo, boeDate: p.boeDate, portCode: p.portCode, books: null, portal: p, igstDiff: -p.igst, cessDiff: -p.cess, note: 'Record the purchase with this bill of entry (GST details, Alt+J).' });
      continue;
    }
    used.add(books.indexOf(exact));
    const igstDiff = exact.igst - p.igst;
    const cessDiff = exact.cess - p.cess;
    const ok = Math.abs(igstDiff) <= TOLERANCE && Math.abs(cessDiff) <= TOLERANCE && exact.boeDate === p.boeDate;
    rows.push({
      status: ok ? 'matched' : 'mismatch',
      boeNo: p.boeNo,
      boeDate: p.boeDate,
      portCode: p.portCode,
      books: exact,
      portal: p,
      igstDiff,
      cessDiff,
      note: ok ? null : exact.boeDate !== p.boeDate ? 'The bill of entry date differs.' : 'IGST / cess differ: correct the purchase\'s bill of entry details.',
    });
  }
  books.forEach((b, i) => {
    if (used.has(i)) return;
    rows.push({ status: 'missing_in_portal', boeNo: b.boeNo, boeDate: b.boeDate, portCode: b.portCode, books: b, portal: null, igstDiff: b.igst, cessDiff: b.cess, note: 'Not in this GSTR-2B: it may appear in a later month (ICEGATE delay), or the number / port code differs.' });
  });
  const counts = { matched: 0, mismatch: 0, missing_in_books: 0, missing_in_portal: 0 };
  for (const r of rows) counts[r.status] += 1;
  return { period: parsed.period, rows, counts, warnings: parsed.warnings };
}

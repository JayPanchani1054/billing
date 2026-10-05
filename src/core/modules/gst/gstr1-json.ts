/**
 * GSTR-1 JSON in the GSTN offline-tool / portal upload format. Built from the same computation as the
 * summary (gstr1.ts), so the file always agrees with the screen.
 *
 * Conventions: amounts in rupees as JSON numbers with at most 2 decimals (paise / 100, exact);
 * dates 'dd-mm-yyyy'; items grouped per rate within each invoice/note (num = 1, 2, …); empty sections
 * are omitted; deterministic ordering (GSTIN / POS, then date, then number) so the file is stable.
 * Inter-state documents carry iamt, intra-state ones camt + samt (keys present only when relevant).
 */
import { formatDate } from '../../../shared/dates.ts';
import type { GstJsonFile } from '../../../shared/types/gst-returns.ts';
import type { GstDoc, GstDocLine } from './docs.ts';
import { round2, rupees } from './docs.ts';
import type { Gstr1Computation, Placement } from './gstr1.ts';

/** Schema version written into the file (GSTN offline tool). Verify against the portal's latest JSON spec. */
export const GSTR1_JSON_VERSION = 'GST3.2.1';

type Json = Record<string, unknown>;

const idt = (iso: string | null): string => formatDate(iso, 'DD-MM-YYYY');

const byDocOrder = (a: Placement, b: Placement): number =>
  a.doc.date.localeCompare(b.doc.date) ||
  (a.doc.number ?? '').localeCompare(b.doc.number ?? '', 'en', { numeric: true }) ||
  a.doc.id - b.doc.id;

/** Rate-wise item details of a document (unsigned, as on the document). */
function rateItems(d: GstDoc, lines: readonly GstDocLine[], heads: 'all' | 'igst_only'): Json[] {
  const by = new Map<number, { txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  for (const l of lines) {
    const r = by.get(l.rate) ?? { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    r.txval += l.taxable;
    r.iamt += l.igst;
    r.camt += l.cgst;
    r.samt += l.sgst;
    r.csamt += l.cess;
    by.set(l.rate, r);
  }
  const anyIgst = lines.some((l) => l.igst !== 0);
  const anyCgst = lines.some((l) => l.cgst !== 0 || l.sgst !== 0);
  const useIgst = heads === 'igst_only' || d.interState || anyIgst;
  const useCgst = heads === 'all' && (!d.interState || anyCgst);
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rt, r]) => {
      const det: Json = { txval: rupees(r.txval), rt };
      if (useIgst) det.iamt = rupees(r.iamt);
      if (useCgst) {
        det.camt = rupees(r.camt);
        det.samt = rupees(r.samt);
      }
      det.csamt = rupees(r.csamt);
      return det;
    });
}

const numbered = (items: Json[]): Json[] => items.map((itm_det, i) => ({ num: i + 1, itm_det }));

export function buildGstr1Json(c: Gstr1Computation): GstJsonFile {
  const warnings: string[] = [];
  const company = c.company;
  if (!company.gstin) throw new Error('GSTR-1 JSON needs the company GSTIN');
  const fp = c.period.fp as string;
  const out: Json = { gstin: company.gstin, fp, version: GSTR1_JSON_VERSION, hash: 'hash' };
  const pl = [...c.placements].sort(byDocOrder);
  const pos = (d: GstDoc): string => d.pos || company.stateCode;

  // ── b2b (4A, 4B, 6B, 6C) ──
  const b2b = new Map<string, Json[]>();
  for (const p of pl) {
    if (p.section !== 'b2b' && p.section !== 'b2b_rcm' && p.section !== 'sez_wp' && p.section !== 'sez_wop' && p.section !== 'de') continue;
    const d = p.doc;
    if (!d.party.gstin) {
      warnings.push(`${d.voucherTypeName} ${d.number ?? ''} was left out of B2B: the party has no GSTIN.`);
      continue;
    }
    const list = b2b.get(d.party.gstin) ?? [];
    list.push({
      inum: (d.number ?? '').trim(),
      idt: idt(d.date),
      val: rupees(d.totalAmount),
      pos: pos(d),
      rchrg: p.rcm ? 'Y' : 'N',
      inv_typ: p.invoiceType ?? 'R',
      itms: numbered(rateItems(d, p.taxable, 'all')),
    });
    b2b.set(d.party.gstin, list);
  }
  if (b2b.size > 0) out.b2b = [...b2b.keys()].sort().map((ctin) => ({ ctin, inv: b2b.get(ctin) }));

  // ── b2cl (5) ──
  const b2cl = new Map<string, Json[]>();
  for (const p of pl) {
    if (p.section !== 'b2cl') continue;
    const d = p.doc;
    const list = b2cl.get(pos(d)) ?? [];
    list.push({ inum: (d.number ?? '').trim(), idt: idt(d.date), val: rupees(d.totalAmount), itms: numbered(rateItems(d, p.taxable, 'igst_only')) });
    b2cl.set(pos(d), list);
  }
  if (b2cl.size > 0) out.b2cl = [...b2cl.keys()].sort().map((k) => ({ pos: k, inv: b2cl.get(k) }));

  // ── b2cs (7) ──
  if (c.b2cs.length > 0) {
    out.b2cs = c.b2cs.map((r) => {
      const row: Json = { sply_ty: r.supplyType, pos: r.pos, typ: r.type, rt: r.rate, txval: rupees(r.taxable) };
      if (r.supplyType === 'INTER' || r.igst !== 0) row.iamt = rupees(r.igst);
      if (r.supplyType === 'INTRA' || r.cgst !== 0 || r.sgst !== 0) {
        row.camt = rupees(r.cgst);
        row.samt = rupees(r.sgst);
      }
      row.csamt = rupees(r.cess);
      return row;
    });
  }

  // ── exp (6A) ──
  const exp: Json[] = [];
  for (const typ of ['WPAY', 'WOPAY'] as const) {
    const inv = pl
      .filter((p) => p.exportType === typ && (p.section === 'exp_wp' || p.section === 'exp_wop'))
      .map((p) => {
        const d = p.doc;
        const e = d.exportDetails;
        const row: Json = { inum: (d.number ?? '').trim(), idt: idt(d.date), val: rupees(d.totalAmount) };
        if (e?.portCode) row.sbpcode = e.portCode.toUpperCase();
        if (e?.shippingBillNo) row.sbnum = e.shippingBillNo;
        if (e?.shippingBillDate) row.sbdt = idt(e.shippingBillDate);
        row.itms = rateItems(d, p.taxable, 'igst_only').map((x) => ({ txval: x.txval, rt: x.rt, iamt: x.iamt, csamt: x.csamt }));
        return row;
      });
    if (inv.length > 0) exp.push({ exp_typ: typ, inv });
  }
  if (exp.length > 0) out.exp = exp;

  // ── cdnr (9B registered) ──
  const cdnr = new Map<string, Json[]>();
  for (const p of pl) {
    if (p.section !== 'cdnr') continue;
    const d = p.doc;
    if (!d.party.gstin) {
      warnings.push(`${d.voucherTypeName} ${d.number ?? ''} was left out of CDNR: the party has no GSTIN.`);
      continue;
    }
    const list = cdnr.get(d.party.gstin) ?? [];
    list.push({
      ntty: d.noteType ?? 'C',
      nt_num: (d.number ?? '').trim(),
      nt_dt: idt(d.date),
      val: rupees(d.totalAmount),
      pos: pos(d),
      rchrg: p.rcm ? 'Y' : 'N',
      inv_typ: p.invoiceType ?? 'R',
      itms: numbered(rateItems(d, p.taxable, 'all')),
    });
    cdnr.set(d.party.gstin, list);
  }
  if (cdnr.size > 0) out.cdnr = [...cdnr.keys()].sort().map((ctin) => ({ ctin, nt: cdnr.get(ctin) }));

  // ── cdnur (9B unregistered: B2CL and exports) ──
  const cdnur: Json[] = [];
  for (const p of pl) {
    if (p.section !== 'cdnur') continue;
    const d = p.doc;
    const row: Json = { typ: p.cdnurType ?? 'B2CL', ntty: d.noteType ?? 'C', nt_num: (d.number ?? '').trim(), nt_dt: idt(d.date), val: rupees(d.totalAmount) };
    if (p.cdnurType === 'B2CL') row.pos = pos(d);
    row.itms = numbered(rateItems(d, p.taxable, 'igst_only'));
    cdnur.push(row);
  }
  if (cdnur.length > 0) out.cdnur = cdnur;

  // ── nil (8) ──
  const nil = c.nil
    .filter((r) => r.exempt !== 0 || r.nil !== 0 || r.nonGst !== 0)
    .map((r) => ({ sply_ty: r.supplyType, expt_amt: rupees(r.exempt), nil_amt: rupees(r.nil), ngsup_amt: rupees(r.nonGst) }));
  if (nil.length > 0) out.nil = { inv: nil };

  // ── hsn (12) ──
  const hsnRows = (rows: Gstr1Computation['hsnB2b']): Json[] =>
    rows.map((r, i) => {
      const row: Json = { num: i + 1, hsn_sc: r.hsn };
      if (r.description) row.desc = r.description.slice(0, 30);
      Object.assign(row, {
        uqc: r.uqc,
        qty: round2(r.qty),
        rt: r.rate,
        txval: rupees(r.taxable),
        iamt: rupees(r.igst),
        camt: rupees(r.cgst),
        samt: rupees(r.sgst),
        csamt: rupees(r.cess),
      });
      return row;
    });
  const hsn: Json = {};
  if (c.hsnB2b.length > 0) hsn.hsn_b2b = hsnRows(c.hsnB2b);
  if (c.hsnB2c.length > 0) hsn.hsn_b2c = hsnRows(c.hsnB2c);
  if (Object.keys(hsn).length > 0) out.hsn = hsn;
  if (c.hsnB2b.some((r) => !r.hsn) || c.hsnB2c.some((r) => !r.hsn)) warnings.push('Some HSN summary rows have no HSN/SAC; the portal will reject them. Fix the items listed under uncertain transactions.');

  // ── doc_issue (13) ──
  const docNums = [...new Set(c.docSeries.map((s) => s.docNum))].sort((a, b) => a - b);
  if (docNums.length > 0) {
    out.doc_issue = {
      doc_det: docNums.map((n) => ({
        doc_num: n,
        docs: c.docSeries
          .filter((s) => s.docNum === n)
          .map((s, i) => ({ num: i + 1, from: s.from, to: s.to, totnum: s.total, cancel: s.cancelled, net_issue: s.net })),
      })),
    };
  }

  const errors = c.issues.filter((i) => i.severity === 'error').length;
  if (errors > 0) warnings.push(`${errors} uncertain transaction${errors === 1 ? '' : 's'} with errors: the portal may reject the file until they are fixed.`);
  return { fileName: `GSTR1_${company.gstin}_${fp}.json`, json: JSON.stringify(out), warnings };
}

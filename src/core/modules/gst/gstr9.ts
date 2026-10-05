/**
 * GSTR-9 (annual return) summary prepared from the books — always to be verified before filing.
 *
 *   Table 4  outward supplies + inward RCM on which tax is payable:
 *            4A B2C (B2CL + B2CS invoices, B2C notes netted) · 4B B2B (4A of GSTR-1, excl. reverse charge) ·
 *            4C exports with payment · 4D SEZ with payment · 4E deemed exports · 4F advances (0) ·
 *            4G inward supplies on reverse charge (net of purchase returns) · 4I credit notes and
 *            4J debit notes on B–E · 4N total.
 *   Table 5  outward supplies on which tax is not payable: 5A exports under LUT · 5B SEZ without payment ·
 *            5C supplies on which the recipient pays tax · 5D exempt · 5E nil rated · 5F non-GST ·
 *            5H credit notes / 5I debit notes on A–C · 5M sub-total · 5N turnover = 4N + 5M − 4G.
 *   Table 6  ITC: 6A = Σ GSTR-3B 4(A) of the months · 6B inputs / capital goods / input services ·
 *            6C RCM from unregistered · 6D RCM from registered · 6E import of goods · 6F import of services ·
 *            6G ISD · 6I sub-total · 6J difference (6I − 6A) · 7E blocked under s.17(5) (shown for reference).
 *   Table 9  tax payable and paid (cash / ITC by credit head) = Σ of the monthly GSTR-3B computations.
 *   Tables 17 / 18  HSN summaries of outward / inward supplies for the year.
 */
import { addMonths } from '../../../shared/dates.ts';
import type { Gstr9MonthRow, Gstr9PaidRow, Gstr9Row, Gstr9Summary, TaxValue } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import type { GstCompany } from './docs.ts';
import { addTax, addTV, lineTV, loadDocs, zeroTax, zeroTV } from './docs.ts';
import { computeGstr1 } from './gstr1.ts';
import { computeGstr3b } from './gstr3b.ts';
import { fyRange, monthsOf } from './period.ts';
import { hsnSummary } from './reports.ts';

export const GSTR9_CAPTION = 'Prepared from books — verify before filing';

const row = (key: string, label: string, t: TaxValue = zeroTV()): Gstr9Row => ({ key, label, ...t });

export function computeGstr9(db: Db, company: GstCompany, fy: string, today: string): Gstr9Summary {
  const range = fyRange(fy);
  if (!range) throw validation([{ path: 'fy', message: `"${fy}" is not a financial year — use the form 2026-27` }]);
  const { from, to } = range;

  // ── Monthly GSTR-3B computations (table 9 and the month list) ──
  const months: Gstr9MonthRow[] = [];
  const t9: Record<string, Gstr9PaidRow> = {};
  const headLabels = { igst: 'Integrated tax', cgst: 'Central tax', sgst: 'State/UT tax', cess: 'Cess' } as const;
  for (const h of TAX_HEADS) t9[h] = { head: h, label: headLabels[h], payable: 0, paidCash: 0, paidItc: { igst: 0, cgst: 0, sgst: 0, cess: 0 } };
  const itc3bA = zeroTax();
  const isd = zeroTax();
  for (const m of monthsOf({ from, to })) {
    const s = computeGstr3b(db, company, m, today);
    const outTax = zeroTax();
    let outTaxable = 0;
    for (const r of s.supplies) {
      if (r.key === 'osup_det' || r.key === 'osup_zero') {
        addTax(outTax, r);
        outTaxable += r.taxable;
      }
    }
    const cash = zeroTax();
    for (const p of s.payment.rows) {
      cash[p.head] = p.cash + p.rcmLiability;
      const t = t9[p.head];
      t.payable += p.liability + p.rcmLiability;
      t.paidCash += p.cash + p.rcmLiability;
      t.paidItc.igst += p.paidIgst;
      t.paidItc.cgst += p.paidCgst;
      t.paidItc.sgst += p.paidSgst;
      t.paidItc.cess += p.paidCess;
    }
    for (const r of s.itc.available) addTax(itc3bA, r);
    addTax(isd, s.adjustments.itcIsd);
    months.push({ period: m.key, label: m.label, outwardTaxable: outTaxable, outwardTax: outTax, itc: { ...s.itc.net }, cash });
  }

  // ── Tables 4 and 5 from the year's GSTR-1 placement ──
  const g1 = computeGstr1(db, company, { key: null, kind: 'range', label: fy, from, to, fp: null }, today);
  const t = {
    a4: zeroTV(),
    b4: zeroTV(),
    c4: zeroTV(),
    d4: zeroTV(),
    e4: zeroTV(),
    g4: zeroTV(),
    i4: zeroTV(),
    j4: zeroTV(),
    a5: zeroTV(),
    b5: zeroTV(),
    c5: zeroTV(),
    d5: zeroTV(),
    e5: zeroTV(),
    f5: zeroTV(),
    h5: zeroTV(),
    i5: zeroTV(),
  };
  for (const p of g1.placements) {
    const d = p.doc;
    for (const l of p.nil) {
      const target = l.taxability === 'exempt' ? t.d5 : l.taxability === 'nil_rated' ? t.e5 : t.f5;
      target.taxable += d.sign * l.taxable;
    }
    if (p.section === null) continue;
    let target: TaxValue | null = null;
    if (p.rcm) target = d.isNote ? (d.noteType === 'C' ? t.h5 : t.i5) : t.c5;
    else if (p.section === 'b2cl' || p.section === 'b2cs') target = t.a4;
    else if (p.section === 'cdnur' && p.cdnurType === 'B2CL') target = t.a4;
    else if (p.section === 'b2b') target = t.b4;
    else if (p.section === 'exp_wp') target = t.c4;
    else if (p.section === 'sez_wp') target = t.d4;
    else if (p.section === 'de') target = t.e4;
    else if (p.section === 'exp_wop') target = t.a5;
    else if (p.section === 'sez_wop') target = t.b5;
    else if (p.section === 'cdnr' || p.section === 'cdnur') {
      const noPay = p.invoiceType === 'SEWOP' || p.cdnurType === 'EXPWOP';
      if (noPay) target = d.noteType === 'C' ? t.h5 : t.i5;
      else target = d.noteType === 'C' ? t.i4 : t.j4;
    }
    if (!target) continue;
    // B2C notes are netted in 4A (signed); other notes go to their own rows (4I/4J, 5H/5I) as positive values.
    const sign = target === t.a4 ? d.sign : 1;
    for (const l of p.taxable) addTV(target, lineTV(l), sign);
  }

  // Inward RCM (4G) and ITC split (table 6).
  const inward = loadDocs(db, company, { from, to, today }).filter((d) => d.direction === 'inward');
  const t6 = { inputs: zeroTV(), capital: zeroTV(), services: zeroTV(), rcmUnreg: zeroTV(), rcmReg: zeroTV(), impg: zeroTV(), imps: zeroTV(), blocked: zeroTV() };
  for (const d of inward) {
    for (const l of d.lines) {
      if (l.taxability !== 'taxable' || d.nature === 'inward_composition') continue;
      const rcm = l.reverseCharge || d.nature === 'inward_rcm' || d.nature === 'import_services';
      if (rcm) addTV(t.g4, lineTV(l), d.sign);
      let target: TaxValue;
      if (d.nature === 'import_goods' || (d.nature === 'inward_sez' && l.supplyType === 'goods')) target = t6.impg;
      else if (d.nature === 'import_services') target = t6.imps;
      else if (rcm) target = d.party.gstin ? t6.rcmReg : t6.rcmUnreg;
      else if (l.itcEligibility === 'capital_goods') target = t6.capital;
      else if (l.itcEligibility === 'input_services' || (l.itcEligibility !== 'inputs' && l.supplyType === 'services')) target = t6.services;
      else target = t6.inputs;
      addTV(target, lineTV(l), d.sign);
      if (l.itcEligibility === 'ineligible') addTV(t6.blocked, lineTV(l), d.sign);
    }
  }

  const sum = (...xs: TaxValue[]): TaxValue => {
    const o = zeroTV();
    for (const x of xs) addTV(o, x);
    return o;
  };
  const minus = (a: TaxValue, b: TaxValue): TaxValue => {
    const o = { ...a };
    addTV(o, b, -1);
    return o;
  };
  const h4 = sum(t.a4, t.b4, t.c4, t.d4, t.e4, t.g4);
  const n4 = minus(sum(h4, t.j4), t.i4);
  const g5 = sum(t.a5, t.b5, t.c5, t.d5, t.e5, t.f5);
  const m5 = minus(sum(g5, t.i5), t.h5);
  const n5 = minus(sum(n4, m5), t.g4);

  const table4: Gstr9Row[] = [
    row('4A', 'Supplies made to unregistered persons (B2C)', t.a4),
    row('4B', 'Supplies made to registered persons (B2B)', t.b4),
    row('4C', 'Zero rated supply (export) on payment of tax (except supplies to SEZs)', t.c4),
    row('4D', 'Supply to SEZs on payment of tax', t.d4),
    row('4E', 'Deemed exports', t.e4),
    row('4F', 'Advances on which tax has been paid but invoice has not been issued', zeroTV()),
    row('4G', 'Inward supplies on which tax is to be paid on reverse charge basis', t.g4),
    row('4H', 'Sub-total (A to G above)', h4),
    row('4I', 'Credit notes issued in respect of transactions specified in (B) to (E) above (−)', t.i4),
    row('4J', 'Debit notes issued in respect of transactions specified in (B) to (E) above (+)', t.j4),
    row('4N', 'Supplies and advances on which tax is to be paid (H + J − I)', n4),
  ];
  const table5: Gstr9Row[] = [
    row('5A', 'Zero rated supply (export) without payment of tax', t.a5),
    row('5B', 'Supply to SEZs without payment of tax', t.b5),
    row('5C', 'Supplies on which tax is to be paid by the recipient on reverse charge basis', t.c5),
    row('5D', 'Exempted', t.d5),
    row('5E', 'Nil rated', t.e5),
    row('5F', 'Non-GST supply', t.f5),
    row('5G', 'Sub-total (A to F above)', g5),
    row('5H', 'Credit notes issued in respect of transactions specified in A to F above (−)', t.h5),
    row('5I', 'Debit notes issued in respect of transactions specified in A to F above (+)', t.i5),
    row('5M', 'Sub-total (G + I − H)', m5),
    row('5N', 'Total turnover (including advances) (4N + 5M − 4G)', n5),
  ];
  const isdTV: TaxValue = { taxable: 0, ...isd };
  const i6 = sum(t6.inputs, t6.capital, t6.services, t6.rcmUnreg, t6.rcmReg, t6.impg, t6.imps, isdTV);
  const a6: TaxValue = { taxable: 0, ...itc3bA };
  const i6tax: TaxValue = { ...i6, taxable: 0 };
  const table6: Gstr9Row[] = [
    row('6A', 'Total ITC availed through GSTR-3B (sum of 4(A) of the months)', a6),
    row('6B1', 'Inward supplies (other than imports and RCM) — inputs', t6.inputs),
    row('6B2', 'Inward supplies (other than imports and RCM) — capital goods', t6.capital),
    row('6B3', 'Inward supplies (other than imports and RCM) — input services', t6.services),
    row('6C', 'Inward supplies from unregistered persons liable to reverse charge', t6.rcmUnreg),
    row('6D', 'Inward supplies from registered persons liable to reverse charge', t6.rcmReg),
    row('6E', 'Import of goods (including supplies from SEZs)', t6.impg),
    row('6F', 'Import of services (excluding inward supplies from SEZs)', t6.imps),
    row('6G', 'Input tax credit received from ISD', isdTV),
    row('6I', 'Sub-total (B to H above)', i6),
    row('6J', 'Difference (I − A above)', minus(i6tax, a6)),
    row('7E', 'For reference: ITC blocked under section 17(5) (reversed in 7E)', t6.blocked),
  ];

  const notes = [
    'Advances (4F), amendments (4K/4L, 5J/5K) and Part V (next-year transactions, tables 10–14) are not derived — complete them on the portal.',
    'Table 9 adds up the monthly GSTR-3B computations of this app (with the manual entries saved for each month); compare with your electronic ledgers.',
    'Table 8 (ITC as per GSTR-2B) needs the GSTR-2B data: use the GST reconciliation module.',
  ];
  const fyStart = from;
  if (company.config.gst.filingFrequency === 'quarterly') notes.push('You file quarterly: monthly figures here are for analysis; the returns were filed per quarter.');

  return {
    fy,
    from,
    to,
    gstin: company.gstin,
    companyName: company.name,
    caption: GSTR9_CAPTION,
    table4,
    table5,
    table6,
    table9: TAX_HEADS.map((h) => t9[h]),
    hsnOutward: hsnSummary(db, company, from, to, 'outward', today).rows,
    hsnInward: hsnSummary(db, company, from, to, 'inward', today).rows,
    months,
    notes: addMonths(fyStart, 12) > today ? [...notes, 'The financial year has not ended yet: figures cover the months so far.'] : notes,
  };
}

/**
 * GST registers and analysis reports (all from gst_lines):
 *   hsnSummary   HSN/SAC-wise outward or inward summary (signed: credit notes / purchase returns subtract)
 *   register     invoice-wise sales or purchase GST register with rate breakup and totals
 *   itc          input tax credit by supplier and by eligibility
 *   exceptions   uncertain transactions: GSTR-1 checks + purchase-side checks
 */
import { GST_NATURE_LABELS, stateName } from '../../../shared/gst/index.ts';
import type {
  GstExceptionsResult,
  GstHsnSummaryResult,
  GstIssue,
  GstItcResult,
  GstItcSupplierRow,
  GstRateSplit,
  GstRegisterResult,
  GstRegisterRow,
  ItcEligibility,
  ReturnPeriodRef,
  TaxAmounts,
} from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { inwardIssues, sortIssues, vouchersWithRcmLiability } from './checks.ts';
import type { GstCompany, GstDoc, GstDocLine } from './docs.ts';
import { addTax, addTV, lineTV, loadDocs, rateSplit, zeroTax, zeroTV } from './docs.ts';
import { computeGstr1, hsnAccumulator } from './gstr1.ts';

export function rangeRef(from: string, to: string): ReturnPeriodRef {
  return { key: null, kind: 'range', label: `${from} to ${to}`, from, to, fp: null };
}

export function hsnSummary(
  db: Db,
  company: GstCompany,
  from: string,
  to: string,
  direction: 'outward' | 'inward',
  today: string,
  preloaded?: readonly GstDoc[],
): GstHsnSummaryResult {
  const docs = (preloaded ?? loadDocs(db, company, { from, to, today })).filter(
    (d) => d.inBooks && d.direction === direction && d.nature !== 'composition_outward' && d.nature !== 'no_gst',
  );
  const acc = hsnAccumulator(company.config.gst.hsnDigits);
  for (const d of docs) for (const l of d.lines) acc.add(l, d.sign);
  const rows = acc.rows();
  const totals = { ...zeroTV(), total: 0 };
  for (const r of rows) {
    addTV(totals, r);
    totals.total += r.total;
  }
  return { from, to, direction, rows, totals };
}

function registerRow(d: GstDoc): GstRegisterRow {
  const taxable = d.lines.filter((l) => l.taxability === 'taxable');
  const t = zeroTV();
  for (const l of taxable) addTV(t, lineTV(l), d.sign);
  const nonTaxable = d.lines.filter((l) => l.taxability !== 'taxable').reduce((s, l) => s + d.sign * l.taxable, 0);
  const stateCode = d.direction === 'outward' ? d.pos : d.supplierState;
  return {
    voucherId: d.id,
    date: d.date,
    number: d.number,
    voucherTypeName: d.voucherTypeName,
    baseType: d.baseType,
    partyName: d.party.name,
    gstin: d.party.gstin,
    stateCode,
    stateName: stateCode ? stateName(stateCode) || stateCode : '',
    nature: d.nature,
    natureLabel: GST_NATURE_LABELS[d.nature] ?? d.nature,
    reverseCharge: d.reverseCharge,
    supplierInvoiceNo: d.direction === 'inward' ? d.referenceNo : null,
    supplierInvoiceDate: d.direction === 'inward' ? d.referenceDate : null,
    invoiceValue: d.sign * d.totalAmount,
    sign: d.sign,
    rates: rateSplit(taxable, d.sign),
    nonTaxable,
    ...t,
  };
}

export function gstRegister(db: Db, company: GstCompany, from: string, to: string, kind: 'sales' | 'purchase', today: string): GstRegisterResult {
  const direction = kind === 'sales' ? 'outward' : 'inward';
  const rows = loadDocs(db, company, { from, to, today })
    .filter((d) => d.direction === direction)
    .map(registerRow);
  const totals = { ...zeroTV(), invoiceValue: 0, nonTaxable: 0 };
  const rates = new Map<string, GstRateSplit>();
  for (const r of rows) {
    addTV(totals, r);
    totals.invoiceValue += r.invoiceValue;
    totals.nonTaxable += r.nonTaxable;
    for (const x of r.rates) {
      const k = `${x.rate}|${x.cessRate}`;
      const acc = rates.get(k) ?? { rate: x.rate, cessRate: x.cessRate, ...zeroTV() };
      addTV(acc, x);
      rates.set(k, acc);
    }
  }
  return {
    from,
    to,
    kind,
    rows,
    totals,
    rateTotals: [...rates.values()].sort((a, b) => a.rate - b.rate || a.cessRate - b.cessRate),
  };
}

const ELIGIBILITY_LABELS: Readonly<Record<ItcEligibility, string>> = {
  inputs: 'Inputs',
  capital_goods: 'Capital goods',
  input_services: 'Input services',
  ineligible: 'Ineligible — blocked under s.17(5)',
};

function eligibilityOf(l: GstDocLine): ItcEligibility {
  return l.itcEligibility ?? (l.supplyType === 'services' ? 'input_services' : 'inputs');
}

export function itcReport(db: Db, company: GstCompany, from: string, to: string, today: string): GstItcResult {
  const docs = loadDocs(db, company, { from, to, today }).filter((d) => d.direction === 'inward');
  const by = new Map<string, GstItcSupplierRow & { ids: Set<number> }>();
  const elig = new Map<ItcEligibility, { taxable: number; tax: TaxAmounts }>();
  for (const k of Object.keys(ELIGIBILITY_LABELS) as ItcEligibility[]) elig.set(k, { taxable: 0, tax: zeroTax() });

  for (const d of docs) {
    const key = d.partyLedgerId !== null ? `L${d.partyLedgerId}` : d.party.gstin ? `G${d.party.gstin}` : `N${d.party.name ?? ''}`;
    const rcm = d.reverseCharge || d.nature === 'inward_rcm' || d.nature === 'import_services';
    const imports = d.nature === 'import_goods';
    for (const l of d.lines) {
      if (l.taxability !== 'taxable') continue;
      let r = by.get(key);
      if (!r) {
        r = {
          partyLedgerId: d.partyLedgerId,
          partyName: d.party.name ?? d.party.ledgerName ?? '(no party)',
          gstin: d.party.gstin,
          documents: 0,
          taxable: 0,
          eligible: zeroTax(),
          ineligible: zeroTax(),
          reverseCharge: zeroTax(),
          imports: zeroTax(),
          ids: new Set(),
        };
        by.set(key, r);
      }
      r.ids.add(d.id);
      r.taxable += d.sign * l.taxable;
      const e = eligibilityOf(l);
      addTax(e === 'ineligible' ? r.ineligible : r.eligible, l, d.sign);
      if (rcm || l.reverseCharge) addTax(r.reverseCharge, l, d.sign);
      if (imports) addTax(r.imports, l, d.sign);
      const eg = elig.get(e) as { taxable: number; tax: TaxAmounts };
      eg.taxable += d.sign * l.taxable;
      addTax(eg.tax, l, d.sign);
    }
  }
  const rows = [...by.values()]
    .map(({ ids, ...r }) => ({ ...r, documents: ids.size }))
    .sort((a, b) => a.partyName.localeCompare(b.partyName) || (a.gstin ?? '').localeCompare(b.gstin ?? ''));
  const totals = { taxable: 0, eligible: zeroTax(), ineligible: zeroTax(), reverseCharge: zeroTax(), imports: zeroTax() };
  for (const r of rows) {
    totals.taxable += r.taxable;
    addTax(totals.eligible, r.eligible);
    addTax(totals.ineligible, r.ineligible);
    addTax(totals.reverseCharge, r.reverseCharge);
    addTax(totals.imports, r.imports);
  }
  return {
    from,
    to,
    rows,
    totals,
    byEligibility: [...elig.entries()].map(([eligibility, v]) => ({ eligibility, label: ELIGIBILITY_LABELS[eligibility], taxable: v.taxable, tax: v.tax })),
  };
}

/**
 * Every uncertain transaction in a range: GSTR-1 checks on outward documents + purchase-side checks.
 * `preloaded` (optional): loadDocs() of exactly this range with includeCancelled: true.
 */
export function collectIssues(db: Db, company: GstCompany, from: string, to: string, today: string, preloaded?: readonly GstDoc[]): GstIssue[] {
  const docs = preloaded ?? loadDocs(db, company, { from, to, today, includeCancelled: true });
  const issues: GstIssue[] = [...computeGstr1(db, company, rangeRef(from, to), today, docs).issues];
  const inward = docs.filter((d) => d.inBooks && d.direction === 'inward');
  const rcm = vouchersWithRcmLiability(
    db,
    inward.map((d) => d.id),
  );
  for (const d of inward) issues.push(...inwardIssues(d, rcm));
  return sortIssues(issues);
}

export function exceptionsReport(db: Db, company: GstCompany, from: string, to: string, today: string): GstExceptionsResult {
  const issues = collectIssues(db, company, from, to, today);
  const byCode: GstExceptionsResult['counts']['byCode'] = {};
  let errors = 0;
  for (const i of issues) {
    byCode[i.code] = (byCode[i.code] ?? 0) + 1;
    if (i.severity === 'error') errors += 1;
  }
  return { from, to, issues, counts: { errors, warnings: issues.length - errors, byCode } };
}

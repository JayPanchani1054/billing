/**
 * Uncertain-transaction helpers (pure; see issues.test.ts): which master or voucher to open to fix
 * an issue, grouping and counts for the panels and the exceptions report.
 */
import type { GstIssue, GstIssueCode } from '../../../../shared/types/gst-returns.ts';

export interface FixLink {
  /** Button text: 'Alter voucher', 'Open party ledger', 'Open stock item', 'Open ledger'. */
  label: string;
  screen: string;
  params: Record<string, unknown>;
  /** Short description for screen readers / tooltips. */
  hint: string;
}

/** Codes whose fix is in the party ledger (GSTIN, registration, state). */
const PARTY_CODES: ReadonlySet<GstIssueCode> = new Set<GstIssueCode>([
  'gstin_missing',
  'gstin_invalid',
  'b2c_with_gstin',
  'pos_missing',
  'supplier_gstin_invalid',
  'itc_without_gstin',
]);

/** Codes whose fix is in the stock item / ledger of a line (HSN, rate). */
const LINE_CODES: ReadonlySet<GstIssueCode> = new Set<GstIssueCode>(['hsn_missing', 'hsn_short', 'hsn_invalid', 'rate_not_slab']);

/**
 * Fix links for an issue, most relevant first: the master that holds the wrong data (party ledger
 * for GSTIN / state problems, stock item or ledger for HSN / rate problems), then the voucher (it
 * keeps a copy of party and GST details, so it must be re-saved after the master is corrected).
 * Period-level issues (no voucher) get no links.
 */
export function fixLinks(issue: GstIssue): FixLink[] {
  const links: FixLink[] = [];
  const who = issue.partyName ? ` “${issue.partyName}”` : '';
  if (LINE_CODES.has(issue.code)) {
    if (issue.itemId) {
      links.push({ label: 'Open stock item', screen: 'inventory.item.form', params: { id: issue.itemId }, hint: 'Correct the HSN/SAC or GST rate in the stock item' });
    } else if (issue.lineLedgerId) {
      links.push({ label: 'Open ledger', screen: 'accounts.ledger.form', params: { id: issue.lineLedgerId }, hint: 'Correct the HSN/SAC or GST rate in the sales / purchase ledger' });
    }
  }
  if (PARTY_CODES.has(issue.code) && issue.partyLedgerId) {
    links.push({ label: 'Open party ledger', screen: 'accounts.ledger.form', params: { id: issue.partyLedgerId }, hint: `Correct the GST details of the party${who}` });
  }
  if (issue.voucherId !== null) {
    links.push({ label: 'Alter voucher', screen: 'vouchers.entry', params: { id: issue.voucherId }, hint: 'Open the voucher, correct it and save it again' });
  }
  return links;
}

/** The master to correct (stock item, line ledger or party ledger) — the first fix link that is not the voucher. */
export function masterLink(issue: GstIssue): FixLink | null {
  return fixLinks(issue).find((l) => l.screen !== 'vouchers.entry') ?? null;
}

/** "Alter voucher" for an issue that has a voucher. */
export function alterVoucherLink(issue: GstIssue): FixLink | null {
  return fixLinks(issue).find((l) => l.screen === 'vouchers.entry') ?? null;
}

/** The voucher behind an issue, for Enter / drill-down. */
export function issueVoucherLink(issue: GstIssue): FixLink | null {
  return issue.voucherId === null ? null : { label: 'View voucher', screen: 'vouchers.view', params: { id: issue.voucherId }, hint: 'Open the voucher' };
}

export interface IssueCounts {
  errors: number;
  warnings: number;
}

export function countIssues(issues: readonly GstIssue[]): IssueCounts {
  const errors = issues.filter((i) => i.severity === 'error').length;
  return { errors, warnings: issues.length - errors };
}

/** 'No problems found', '2 errors', '1 error and 3 warnings'. */
export function issueSummaryText(c: IssueCounts): string {
  if (c.errors === 0 && c.warnings === 0) return 'No problems found';
  const e = c.errors > 0 ? `${c.errors} error${c.errors === 1 ? '' : 's'}` : '';
  const w = c.warnings > 0 ? `${c.warnings} warning${c.warnings === 1 ? '' : 's'}` : '';
  return e && w ? `${e} and ${w}` : e || w;
}

/** Plain-language names of the issue codes (filter chips, export). */
export const ISSUE_CODE_LABELS: Readonly<Record<GstIssueCode, string>> = {
  gstin_missing: 'GSTIN missing',
  gstin_invalid: 'GSTIN invalid',
  b2c_with_gstin: 'B2C sale to a registered buyer',
  hsn_missing: 'HSN/SAC missing',
  hsn_short: 'HSN/SAC too short',
  hsn_invalid: 'HSN/SAC looks wrong',
  pos_missing: 'Place of supply missing',
  note_without_original: 'Note without original invoice',
  doc_no_missing: 'Document number missing',
  doc_no_invalid: 'Document number not accepted',
  doc_series_gap: 'Gap in number series',
  rate_not_slab: 'Not a GST rate',
  nature_mismatch: 'B2CS / B2CL classification',
  tax_head_mismatch: 'Wrong tax type (IGST vs CGST/SGST)',
  no_gst_lines: 'No GST details',
  negative_value: 'Negative value',
  export_shipping_bill_missing: 'Shipping bill details missing',
  supplier_invoice_missing: 'Supplier invoice no./date missing',
  supplier_gstin_invalid: 'Supplier GSTIN invalid',
  itc_without_gstin: 'ITC from a supplier without GSTIN',
  rcm_without_liability: 'Reverse charge not booked',
  itc_time_limit: 'ITC after the time limit',
};

/** Distinct codes present, most frequent first (filter options). */
export function codesPresent(issues: readonly GstIssue[]): Array<{ code: GstIssueCode; count: number }> {
  const m = new Map<GstIssueCode, number>();
  for (const i of issues) m.set(i.code, (m.get(i.code) ?? 0) + 1);
  return [...m.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Stable row key for an issue list. */
export function issueKey(i: GstIssue, index: number): string {
  return `${i.code}:${i.voucherId ?? 'p'}:${index}`;
}

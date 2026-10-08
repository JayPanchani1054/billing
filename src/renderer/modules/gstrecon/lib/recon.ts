/**
 * Display logic of the reconciliation screen (pure, tested in recon.test.ts): status tones and
 * filters, the side-by-side compare table with highlighted differences, ITC tiles, import and
 * conflict messages, tolerance form validation and the results export definition.
 */
import { formatDate } from '../../../../shared/dates.ts';
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type {
  DiffField,
  ReconImportConflict,
  ReconImportResult,
  ReconRow,
  ReconSource,
  ReconStatus,
  ReconStatusFilter,
  ReconSummary,
  ReconTolerance,
  TaxHeads,
} from '../../../../shared/types/gstrecon.ts';
import { MATCH_METHOD_LABELS, PORTAL_DOC_TYPE_LABELS, RECON_SOURCE_LABELS, RECON_STATUS_LABELS } from '../../../../shared/types/gstrecon.ts';

export type Tone = 'neutral' | 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export const STATUS_TONES: Readonly<Record<ReconStatus, Tone>> = {
  matched: 'success',
  partial: 'warning',
  missing_in_books: 'danger',
  missing_in_portal: 'danger',
  duplicate: 'warning',
  accepted: 'info',
  ignored: 'neutral',
  pending: 'neutral',
};

/** Order of the status tiles. */
export const TILE_STATUSES: readonly ReconStatus[] = ['matched', 'partial', 'missing_in_books', 'missing_in_portal', 'duplicate', 'accepted', 'ignored'];

/** 'Supplier' for GSTR-2A/2B, 'Customer' for GSTR-1. */
export const partyWord = (source: ReconSource): string => (source === 'gstr1' ? 'Customer' : 'Supplier');

/** Plain-English status names, worded for the side being reconciled. */
export function statusLabel(status: ReconStatus, source: ReconSource): string {
  if (source === 'gstr1' && status === 'missing_in_portal') return 'Not in GSTR-1';
  if (source === 'gstr1' && status === 'missing_in_books') return 'Not in books';
  return RECON_STATUS_LABELS[status];
}

/** What each status asks the user to do (tile captions and empty states). */
export function statusAdvice(status: ReconStatus, source: ReconSource): string {
  const inward = source !== 'gstr1';
  switch (status) {
    case 'matched':
      return 'Nothing to do';
    case 'partial':
      return 'Check the differences, then correct the voucher or accept';
    case 'missing_in_books':
      return inward ? 'Enter the purchase, or link it to the voucher' : 'Reported in GSTR-1 but not in the books';
    case 'missing_in_portal':
      return inward ? 'Ask the supplier to report it in GSTR-1' : 'Add it to GSTR-1 (amend next month)';
    case 'duplicate':
      return 'The same document is entered more than once';
    case 'accepted':
      return 'Differences accepted by you';
    case 'ignored':
      return 'Left out of follow-up';
    default:
      return 'Run the reconciliation';
  }
}

export interface StatusFilterOption {
  value: ReconStatusFilter;
  label: string;
}

/** Results filter choices with counts ('Partially matched (2)'); `otherPeriod` counts the "reported in another month" rows when known. */
export function statusFilterOptions(source: ReconSource, counts: Partial<Record<ReconStatus, number>>, otherPeriod?: number): StatusFilterOption[] {
  const n = (s: ReconStatus): number => counts[s] ?? 0;
  const open = n('partial') + n('missing_in_books') + n('missing_in_portal') + n('duplicate');
  const all = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const withCount = (label: string, c: number): string => `${label} (${c})`;
  return [
    { value: 'open', label: withCount('Needs action', open) },
    { value: 'all', label: withCount('All rows', all) },
    ...TILE_STATUSES.map((s) => ({ value: s as ReconStatusFilter, label: withCount(statusLabel(s, source), n(s)) })),
    { value: 'other_period', label: otherPeriod === undefined ? 'Missing — reported in another month' : withCount('Missing — reported in another month', otherPeriod) },
  ];
}

// ───────────────────────────── Amount text ─────────────────────────────

/** Signed difference for display: '+1.01', '−1.01' (true minus sign), '' for 0. */
export function signedMoney(p: Paise | null | undefined): string {
  if (p === null || p === undefined || p === 0) return '';
  return p > 0 ? `+${formatMoney(p)}` : `−${formatMoney(-p)}`;
}

const headsTotal = (h: TaxHeads): number => h.igst + h.cgst + h.sgst + h.cess;

/** Total tax of a row's documents (portal side when present, else books). */
export function rowTax(r: ReconRow): { portal: Paise | null; books: Paise | null; difference: Paise | null } {
  return { portal: r.portal?.tax ?? null, books: r.books?.tax ?? null, difference: r.difference?.tax ?? null };
}

/** The document number to show for a row (portal number first). */
export const rowDocNo = (r: ReconRow): string => r.portal?.docNo ?? r.books?.docNo ?? '';
export const rowDocDate = (r: ReconRow): string => r.portal?.docDate ?? r.books?.docDate ?? '';

// ───────────────────────────── Compare table ─────────────────────────────

export interface CompareLine {
  key: string;
  label: string;
  portal: string;
  books: string;
  /** Difference text (portal − books) for amounts and dates. */
  difference: string;
  /** A mismatch that makes the row partial — highlighted. */
  mismatch: boolean;
  /** A difference within tolerance or informational — marked, not highlighted. */
  info: boolean;
}

const yesNo = (b: boolean | null | undefined): string => (b === null || b === undefined ? '' : b ? 'Yes' : 'No');
const dmy = (iso: string | null | undefined): string => (iso ? formatDate(iso, 'DD-MM-YYYY') : '');
const money = (p: number | null | undefined): string => (p === null || p === undefined ? '' : formatMoney(p));
const rates = (r: readonly number[] | undefined): string => (r && r.length > 0 ? r.map((x) => `${x}%`).join(', ') : '');

/** Side-by-side lines for the compare drawer; differences come from the stored diffs. */
export function compareLines(row: ReconRow): CompareLine[] {
  const p = row.portal;
  const b = row.books;
  const sev = new Map<DiffField, 'mismatch' | 'info'>();
  const diffNum = new Map<DiffField, number | null>();
  for (const d of row.diffs) {
    sev.set(d.field, d.severity);
    diffNum.set(d.field, d.difference);
  }
  const line = (key: DiffField | string, label: string, portal: string, books: string, difference = ''): CompareLine => {
    const s = sev.get(key as DiffField);
    return { key, label, portal, books, difference, mismatch: s === 'mismatch', info: s === 'info' };
  };
  const amountLine = (key: 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess', label: string): CompareLine => {
    const pv = p ? p[key] : null;
    const bv = b ? b[key] : null;
    const d = pv !== null && bv !== null ? pv - bv : null;
    return line(key, label, money(pv), money(bv), signedMoney(d));
  };
  const dd = diffNum.get('date');
  const lines: CompareLine[] = [
    line('doc_no', 'Document no.', p?.docNo ?? '', b?.docNo ?? ''),
    line('date', 'Document date', dmy(p?.docDate), dmy(b?.docDate), typeof dd === 'number' && dd !== 0 ? `${dd > 0 ? '+' : '−'}${Math.abs(dd)} day${Math.abs(dd) === 1 ? '' : 's'}` : ''),
    line('doc_type', 'Type', p ? PORTAL_DOC_TYPE_LABELS[p.docType] : '', b ? PORTAL_DOC_TYPE_LABELS[b.docType] : ''),
    line('gstin', 'GSTIN', p?.gstin ?? '', b?.gstin ?? ''),
    line('name', 'Name', p?.name ?? '', b?.partyName ?? ''),
    line('pos', 'Place of supply', p?.pos ?? '', b?.pos ?? ''),
    line('reverse_charge', 'Reverse charge', p ? yesNo(p.reverseCharge) : '', b ? yesNo(b.reverseCharge) : ''),
    line('rate', 'Tax rate', rates(p?.rates), rates(b?.rates)),
    amountLine('taxable', 'Taxable value'),
    amountLine('igst', 'IGST'),
    amountLine('cgst', 'CGST'),
    amountLine('sgst', 'SGST/UTGST'),
    amountLine('cess', 'Cess'),
    line('tax', 'Total tax', money(p?.tax), money(b?.tax), signedMoney(p && b ? p.tax - b.tax : null)),
    line('invoice_value', 'Document value', money(p?.invoiceValue), money(b?.invoiceValue), signedMoney(p && b && p.invoiceValue && b.invoiceValue ? p.invoiceValue - b.invoiceValue : null)),
  ];
  if (row.portal?.itcAvailable !== null && row.portal?.itcAvailable !== undefined) {
    lines.push(line('itc', 'ITC available', yesNo(row.portal.itcAvailable) + (row.portal.itcReason ? ` — ${row.portal.itcReason}` : ''), b ? (b.eligibleTax > 0 ? 'Claimed' : 'Not claimed') : ''));
  }
  if (b && !b.inPeriod) lines.push(line('books_period', 'Booked in', '', periodLabelOf(b.period)));
  return lines;
}

function periodLabelOf(key: string): string {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const m = Number(key.slice(0, 2));
  return m >= 1 && m <= 12 ? `${names[m - 1]} ${key.slice(2)}` : key;
}

/** One-line explanation of how/why a row is what it is. */
export function rowExplanation(row: ReconRow, source: ReconSource): string {
  const party = partyWord(source).toLowerCase();
  if (row.status === 'accepted') return `Differences accepted${row.remarks ? `: ${row.remarks}` : ''}.`;
  if (row.status === 'ignored') return `Ignored${row.remarks ? `: ${row.remarks}` : ''}.`;
  switch (row.status) {
    case 'matched':
      return `Matched by ${MATCH_METHOD_LABELS[row.method ?? 'exact'].toLowerCase()}.`;
    case 'partial': {
      const n = row.diffs.filter((d) => d.severity === 'mismatch').length;
      return `Found the voucher, but ${n} ${n === 1 ? 'detail differs' : 'details differ'} (highlighted).`;
    }
    case 'missing_in_books':
      return row.suggestionCount > 0
        ? `No voucher with this number — ${row.suggestionCount} probable ${row.suggestionCount === 1 ? 'match' : 'matches'} below.`
        : source === 'gstr1'
          ? 'Reported in GSTR-1, but no sales voucher has this number.'
          : `The ${party} reported this document, but no purchase voucher has this number.`;
    case 'missing_in_portal':
      return row.otherPeriod
        ? `The ${party} reported it in ${periodLabelOf(row.otherPeriod)} instead.`
        : source === 'gstr1'
          ? 'In the books, but not in the GSTR-1 file.'
          : `In the books, but the ${party} has not reported it in ${RECON_SOURCE_LABELS[source]}.`;
    case 'duplicate':
      if (row.kind === 'portal' && row.otherPeriod) {
        return `Already matched in the return for ${periodLabelOf(row.otherPeriod)}: the ${party} reported it twice. Claim the ITC only once.`;
      }
      return row.duplicateOfDocId !== null ? 'The portal lists this document twice.' : `${row.duplicateVoucherIds.length + 1} vouchers carry this ${party} and number; only one should remain.`;
    default:
      return 'Not reconciled yet — run the reconciliation.';
  }
}

// ───────────────────────────── ITC heads ─────────────────────────────

export interface HeadLine {
  key: string;
  label: string;
  portal: Paise;
  books: Paise | null;
  difference: Paise | null;
}

/** ITC (or tax) per head: portal vs books, difference portal − books. */
export function headLines(s: ReconSummary): HeadLine[] {
  const portal = s.portalItc;
  const books = s.booksItc;
  const keys = [
    ['taxable', 'Taxable value'],
    ['igst', 'IGST'],
    ['cgst', 'CGST'],
    ['sgst', 'SGST/UTGST'],
    ['cess', 'Cess'],
    ['tax', 'Total tax'],
  ] as const;
  return keys.map(([k, label]) => ({
    key: k,
    label,
    portal: portal[k],
    books: books ? books[k] : null,
    difference: books ? portal[k] - books[k] : null,
  }));
}

export interface ItcTile {
  key: 'portal' | 'books' | 'risk' | 'notBooked';
  label: string;
  value: Paise | null;
  caption: string;
}

/** Parts of the ITC at risk that are not zero: 'Not on portal 2,280.00 · credit notes not booked 180.00'. */
export function itcRiskCaption(s: ReconSummary): string {
  const parts: Array<[string, Paise]> = [
    ['Not on portal', headsTotal(s.itcAtRisk.missingInPortal)],
    ['books higher', headsTotal(s.itcAtRisk.excessInBooks)],
    ['ITC not available', headsTotal(s.itcAtRisk.itcNotAvailable)],
    ['credit notes not booked', headsTotal(s.itcAtRisk.creditNotesNotBooked)],
  ];
  const shown = parts.filter(([, v]) => v !== 0).map(([l, v]) => `${l} ${formatMoney(v)}`);
  if (shown.length === 0) return 'Nothing at risk';
  const text = shown.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function itcTiles(s: ReconSummary): ItcTile[] {
  const inward = s.source !== 'gstr1';
  return [
    { key: 'portal', label: inward ? `ITC as per ${s.sourceLabel}` : 'Tax as per GSTR-1', value: s.portalItc.tax, caption: `${s.portal.count} documents` },
    { key: 'books', label: inward ? 'ITC as per books' : 'Tax as per books', value: s.booksItc ? s.booksItc.tax : null, caption: s.booksItc ? `${s.booksItc.count} vouchers` : 'Run to compare' },
    {
      key: 'risk',
      label: inward ? 'ITC at risk' : 'Tax not reported',
      value: s.itcAtRisk.total,
      caption: inward ? itcRiskCaption(s) : 'Books higher than GSTR-1',
    },
    { key: 'notBooked', label: inward ? 'ITC not booked' : 'Reported, not in books', value: s.itcNotBooked.total, caption: inward ? 'On the portal, not in your books' : 'GSTR-1 higher than books' },
  ];
}

// ───────────────────────────── Import messages ─────────────────────────────

export function importResultText(r: ReconImportResult): string {
  const skipped = Object.entries(r.skipped);
  return [
    `${r.docCount} ${r.docCount === 1 ? 'document' : 'documents'} imported for ${r.periodLabel}`,
    r.replacedBatchId ? 'the earlier file was replaced' : '',
    skipped.length > 0 ? `not reconciled: ${skipped.map(([k, n]) => `${k} ${n}`).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function conflictMessage(c: ReconImportConflict): { title: string; message: string } {
  const label = RECON_SOURCE_LABELS[c.source];
  return {
    title: `Replace the ${label} for ${periodLabelOf(c.period)}?`,
    message:
      `It was imported on ${formatDate(c.existingImportedAt.slice(0, 10))}${c.existingFileName ? ` from ${c.existingFileName}` : ''} with ${c.existingDocCount} documents. ` +
      `The new file has ${c.newDocCount}. Replacing removes the earlier results; your links, accepted and ignored documents are kept.`,
  };
}

// ───────────────────────────── Tolerance form ─────────────────────────────

export interface ToleranceDraft {
  /** Paise (AmountInput value). */
  amountPaise: number | null;
  dateDays: number | null;
  fuzzyDocNo: boolean;
}

export function toleranceErrors(d: ToleranceDraft): Partial<Record<'amountPaise' | 'dateDays', string>> {
  const e: Partial<Record<'amountPaise' | 'dateDays', string>> = {};
  if (d.amountPaise === null || !Number.isInteger(d.amountPaise) || d.amountPaise < 0) e.amountPaise = 'Enter the allowed difference per tax head, for example 1.00';
  else if (d.amountPaise > 1_00_00_000) e.amountPaise = 'Keep the allowed difference at ₹1,00,000.00 or less';
  if (d.dateDays === null || !Number.isInteger(d.dateDays) || d.dateDays < 0) e.dateDays = 'Enter 0 or more days';
  else if (d.dateDays > 366) e.dateDays = 'Keep the date difference at 366 days or less';
  return e;
}

export function toleranceFromDraft(d: ToleranceDraft): ReconTolerance | null {
  if (Object.keys(toleranceErrors(d)).length > 0) return null;
  return { amountPaise: d.amountPaise as number, dateDays: d.dateDays as number, fuzzyDocNo: d.fuzzyDocNo };
}

export function toleranceText(t: ReconTolerance): string {
  return `±₹${formatMoney(t.amountPaise)} per head · ${t.dateDays === 0 ? 'same date' : `±${t.dateDays} day${t.dateDays === 1 ? '' : 's'}`} · ${t.fuzzyDocNo ? 'smart number matching' : 'exact numbers'}`;
}

// ───────────────────────────── Decisions ─────────────────────────────

/** Ids for gstrecon.accept / ignore / unlink from a row. */
export function decisionTarget(row: ReconRow, period: string, source: ReconSource): { portalDocIds?: number[]; voucherIds?: number[]; period?: string; source?: ReconSource } {
  if (row.kind === 'portal' && row.portalDocId !== null) return { portalDocIds: [row.portalDocId] };
  return { voucherIds: row.voucherId !== null ? [row.voucherId] : [], period, source };
}

/** What can be done with a row. */
export function rowActions(row: ReconRow): { canAccept: boolean; canIgnore: boolean; canUndo: boolean; canLink: boolean; canUnlink: boolean } {
  const decided = row.status === 'accepted' || row.status === 'ignored';
  return {
    canAccept: !decided && row.status !== 'matched' && row.status !== 'pending',
    canIgnore: !decided && row.status !== 'pending',
    canUndo: decided,
    canLink: !row.manual && (row.baseStatus === 'missing_in_books' || row.baseStatus === 'missing_in_portal'),
    canUnlink: row.manual,
  };
}

// ───────────────────────────── Export / print ─────────────────────────────

export interface ResultsExport {
  title: string;
  subtitle: string;
  period: string;
  columns: Array<{ header: string; kind?: 'text' | 'amount' | 'date'; width?: number }>;
  rows: Array<Array<string | number | null>>;
  landscape: boolean;
}

/** The visible results as a printable table (amounts in paise, dates ISO — the shell formats them). */
export function resultsExport(rows: readonly ReconRow[], source: ReconSource, periodText: string, filterLabel: string): ResultsExport {
  return {
    title: `${RECON_SOURCE_LABELS[source]} Reconciliation`,
    subtitle: filterLabel,
    period: periodText,
    landscape: true,
    columns: [
      { header: 'Status', width: 16 },
      { header: `${partyWord(source)} GSTIN`, width: 16 },
      { header: 'Name', width: 24 },
      { header: 'Doc no.', width: 16 },
      { header: 'Date', kind: 'date', width: 11 },
      { header: 'Voucher', width: 14 },
      { header: 'Taxable (portal)', kind: 'amount' },
      { header: 'Tax (portal)', kind: 'amount' },
      { header: 'Tax (books)', kind: 'amount' },
      { header: 'Tax difference', kind: 'amount' },
      { header: 'Remarks', width: 24 },
    ],
    rows: rows.map((r) => [
      statusLabel(r.status, source),
      r.gstin,
      r.name ?? '',
      rowDocNo(r),
      rowDocDate(r) || null,
      r.books ? `${r.books.voucherType} ${r.books.voucherNumber ?? ''}`.trim() : '',
      r.portal?.taxable ?? null,
      r.portal?.tax ?? null,
      r.books?.tax ?? null,
      r.difference?.tax ?? null,
      r.remarks ?? '',
    ]),
  };
}

// ───────────────────────────── Follow-up e-mail ─────────────────────────────

/** Longest mailto: link handed to the e-mail app (Windows mail handlers truncate around 2 000 characters). */
export const MAILTO_LIMIT = 1900;

/** mailto: link with subject and body (no address — the user picks the supplier); null when too long. */
export function mailtoUrl(subject: string, body: string, to = ''): string | null {
  const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`;
  return url.length <= MAILTO_LIMIT ? url : null;
}

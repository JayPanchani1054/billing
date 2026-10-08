/**
 * e-Invoice / e-way bill screen helpers (pure; see compliance.test.ts): row selection, e-way bill
 * number entry and the plain-language summary of an IRP response import.
 */
import type { EinvoiceGeneratedRow, EinvoiceImportResult, GstDocEvent } from '../../../../shared/types/gst-returns.ts';

// ───────────────────────────── Selection ─────────────────────────────

export interface SelectableRow {
  voucherId: number;
  ready: boolean;
}

/** Keep only ids that are still listed and ready (after a refresh). */
export function pruneSelection(selected: ReadonlySet<number>, rows: readonly SelectableRow[]): Set<number> {
  const ready = new Set(rows.filter((r) => r.ready).map((r) => r.voucherId));
  return new Set([...selected].filter((id) => ready.has(id)));
}

export function toggleSelection(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** All ready rows, or none when all ready rows are already selected (Ctrl+Space style toggle). */
export function toggleAllReady(selected: ReadonlySet<number>, rows: readonly SelectableRow[]): Set<number> {
  const ready = rows.filter((r) => r.ready).map((r) => r.voucherId);
  const allOn = ready.length > 0 && ready.every((id) => selected.has(id));
  return allOn ? new Set() : new Set(ready);
}

export function selectionState(selected: ReadonlySet<number>, rows: readonly SelectableRow[]): 'none' | 'some' | 'all' {
  const ready = rows.filter((r) => r.ready);
  const n = ready.filter((r) => selected.has(r.voucherId)).length;
  return n === 0 ? 'none' : n === ready.length ? 'all' : 'some';
}

/** Bulk files take at most 1000 documents. */
export const MAX_BULK = 1000;

// ───────────────────────────── e-Way bill number ─────────────────────────────

/** '1234 5678 9012' → '123456789012'. */
export function normaliseEwbNo(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export interface EwbFormErrors {
  ewayBillNo?: string;
  date?: string;
  validUpto?: string;
}

/** Field checks before 'gst.ewaybill.update' (the server checks again). */
export function validateEwbForm(f: { ewayBillNo: string; date: string | null; validUpto: string | null }, voucherDate: string): EwbFormErrors {
  const e: EwbFormErrors = {};
  const no = normaliseEwbNo(f.ewayBillNo);
  if (no === '') e.ewayBillNo = 'Enter the 12-digit e-way bill number from the EWB portal.';
  else if (!/^\d+$/.test(no)) e.ewayBillNo = 'An e-way bill number has digits only — check what you typed.';
  else if (no.length !== 12) e.ewayBillNo = `An e-way bill number has 12 digits — this one has ${no.length}.`;
  if (!f.date) e.date = 'Enter the date the e-way bill was generated.';
  else if (f.date < voucherDate) e.date = 'The e-way bill date cannot be before the invoice date.';
  if (f.validUpto && f.date && f.validUpto < f.date) e.validUpto = 'Valid up to must be on or after the e-way bill date.';
  return e;
}

// ───────────────────────────── IRP response import ─────────────────────────────

export interface ImportSummary {
  tone: 'success' | 'warning' | 'danger' | 'info';
  title: string;
  lines: string[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Headline + detail lines for the import result dialog. */
export function importSummary(r: EinvoiceImportResult): ImportSummary {
  const lines: string[] = [];
  if (r.updated.length > 0) lines.push(`${plural(r.updated.length, 'invoice')} updated with the IRN${r.updated.some((u) => u.ewayBillNo) ? ' (and e-way bill where given)' : ''}.`);
  if (r.unchanged.length > 0) lines.push(`${plural(r.unchanged.length, 'invoice')} already had the same IRN.`);
  if (r.skipped.length > 0) lines.push(`${plural(r.skipped.length, 'record')} could not be matched or applied — see the list below.`);
  if (r.failed.length > 0) lines.push(`${plural(r.failed.length, 'record')} were rejected by the IRP — correct the invoices and upload them again.`);
  let tone: ImportSummary['tone'] = 'success';
  let title = `Imported ${plural(r.records, 'record')} from the IRP file`;
  if (r.records === 0) {
    tone = 'info';
    title = 'The file has no e-invoice records';
  } else if (r.updated.length === 0 && r.unchanged.length === 0) {
    tone = 'danger';
    title = 'Nothing was imported';
  } else if (r.skipped.length > 0 || r.failed.length > 0 || r.warnings.length > 0) {
    tone = 'warning';
  }
  return { tone, title, lines };
}

// ───────────────────────────── Document trail ─────────────────────────────

const ACTION_LABELS: Readonly<Record<string, string>> = {
  exported: 'Exported to JSON',
  generated: 'IRN generated',
  cancelled: 'Cancelled',
  updated: 'Details recorded',
};

/** 'e-Invoice · IRN generated'. */
export function docEventLabel(e: Pick<GstDocEvent, 'kind' | 'action'>): string {
  const kind = e.kind === 'einvoice' ? 'e-Invoice' : 'e-Way bill';
  const action = ACTION_LABELS[e.action] ?? e.action.charAt(0).toUpperCase() + e.action.slice(1);
  return `${kind} · ${action}`;
}

/** Short text of an event's detail object (file name, ack no., reason …), safe for display as text. */
export function docEventDetail(e: Pick<GstDocEvent, 'detail'>): string {
  if (!e.detail) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e.detail)) {
    if (v === null || v === undefined || v === '') continue;
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${humanKey(k)}: ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`);
  }
  return parts.join(' · ');
}

function humanKey(k: string): string {
  const spaced = k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// ───────────────────────────── Bulk file errors ─────────────────────────────

export interface RejectedDoc {
  voucherId: number;
  number: string | null;
  errors: string[];
}

/**
 * The vouchers listed in a BUSINESS_RULE error's details ("nothing exportable": every selected
 * voucher has errors). Anything malformed is ignored.
 */
export function rejectedFromDetails(details: unknown): RejectedDoc[] {
  if (!details || typeof details !== 'object') return [];
  const list = (details as { rejected?: unknown }).rejected;
  if (!Array.isArray(list)) return [];
  const out: RejectedDoc[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const x = r as { voucherId?: unknown; number?: unknown; errors?: unknown };
    if (typeof x.voucherId !== 'number') continue;
    out.push({
      voucherId: x.voucherId,
      number: typeof x.number === 'string' ? x.number : null,
      errors: Array.isArray(x.errors) ? x.errors.filter((e): e is string => typeof e === 'string') : [],
    });
  }
  return out;
}

// ───────────────────────────── Generated IRNs ─────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO instant → '10-May-2026 18:00' in Indian time (the IRP's clock), whatever the PC's time zone. */
export function formatIstDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + 330 * 60_000); // UTC+05:30, read with getUTC*
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** What the user can still do with an active IRN (the IRP cancels only within 24 hours of the acknowledgement). */
export function cancelWindowText(r: Pick<EinvoiceGeneratedRow, 'cancellableUntil' | 'cancelWindowOpen' | 'cancelledInBooks'>): string {
  if (!r.cancellableUntil) return 'Acknowledgement time not recorded. The IRP cancels an IRN only within 24 hours of generation.';
  const until = formatIstDateTime(r.cancellableUntil);
  if (r.cancelWindowOpen) {
    return r.cancelledInBooks ? `Cancelled in the books — cancel the IRN on the IRP before ${until}.` : `Can be cancelled on the IRP until ${until}.`;
  }
  return r.cancelledInBooks
    ? `The 24-hour window closed on ${until}, so the IRP will not cancel it. Issue a credit note against it instead, and record here only if the IRP did cancel it.`
    : `The 24-hour window to cancel on the IRP closed on ${until}. To reverse this invoice, issue a credit note.`;
}

/** IRP cancellation reasons (CnlRsn 1–4) as the e-invoice portal lists them. */
export type IrnCancelReason = 'duplicate' | 'data_entry' | 'order_cancelled' | 'others';

export const IRN_CANCEL_REASONS: ReadonlyArray<{ value: IrnCancelReason; code: 1 | 2 | 3 | 4; label: string }> = [
  { value: 'duplicate', code: 1, label: 'Duplicate' },
  { value: 'data_entry', code: 2, label: 'Data entry mistake' },
  { value: 'order_cancelled', code: 3, label: 'Order cancelled' },
  { value: 'others', code: 4, label: 'Others' },
];

/**
 * The reason recorded in the trail ('Data entry mistake — wrong GSTIN'); null when "Others" has no
 * remark of at least 3 characters (the IRP needs one, and so does 'gst.einvoice.markCancelled').
 */
export function irnCancelReasonText(reason: IrnCancelReason, remark: string): string | null {
  const r = IRN_CANCEL_REASONS.find((x) => x.value === reason);
  if (!r) return null;
  const extra = remark.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (reason === 'others') return extra.length >= 3 ? `Others — ${extra}` : null;
  return extra ? `${r.label} — ${extra}` : r.label;
}

/**
 * GST details of a stock group or stock item as edited on screen (pure, tested in gstDraft.test.ts
 * and through itemForm.test.ts). Same rules as the core (core/modules/inventory/gst.ts):
 *  - "Set GST here" off → the master inherits (group → parent group → ledger); turning it off also
 *    removes the master's dated history;
 *  - exempt / nil-rated / non-GST carry no rate or cess;
 *  - once a master has dated history, a change to its details (HSN included) needs an
 *    "applicable from" date, so earlier invoices keep the earlier rate.
 */
import type { GstFieldsInput, Taxability } from '../../../../shared/types/inventory.ts';
import { isStandardRate, isValidCessRate, isValidRate } from '../../../../shared/gst/index.ts';
import { validateHsnSac } from '../../../../shared/validators.ts';
import { formatPercent } from '../../../../shared/format.ts';

export interface GstDraft {
  /** The master carries its own GST details. */
  gstApplicable: boolean;
  taxability: Taxability;
  gstRate: number | null;
  cessRate: number | null;
  /** Paise per base unit. */
  cessPerUnit: number | null;
  hsnSac: string;
  /** Date the changed details apply from (null: no dated change). */
  gstApplicableFrom: string | null;
  allowNonStandardRate: boolean;
}

/** GST columns as the API returns them for a group or an item. */
export interface GstMaster {
  gstApplicable: boolean;
  taxability: Taxability | null;
  gstRate: number | null;
  cessRate: number | null;
  cessPerUnit: number;
  hsnSac: string | null;
}

export function emptyGstDraft(): GstDraft {
  return { gstApplicable: false, taxability: 'taxable', gstRate: null, cessRate: null, cessPerUnit: null, hsnSac: '', gstApplicableFrom: null, allowNonStandardRate: false };
}

export function gstDraftFrom(m: GstMaster): GstDraft {
  const taxability = m.taxability ?? 'taxable';
  const own = m.gstApplicable && taxability === 'taxable';
  return {
    gstApplicable: m.gstApplicable,
    taxability,
    gstRate: own ? m.gstRate : null,
    cessRate: own && m.cessRate ? m.cessRate : null,
    cessPerUnit: own && m.cessPerUnit ? m.cessPerUnit : null,
    hsnSac: m.hsnSac ?? '',
    gstApplicableFrom: null,
    allowNonStandardRate: m.gstRate !== null && !isStandardRate(m.gstRate),
  };
}

const normHsn = (s: string): string | null => {
  const t = s.replace(/\s+/g, '');
  return t === '' ? null : t;
};

function sig(d: GstDraft): string {
  if (!d.gstApplicable) return JSON.stringify([false]);
  const taxable = d.taxability === 'taxable';
  return JSON.stringify([true, d.taxability, taxable ? d.gstRate : 0, taxable ? (d.cessRate ?? 0) : 0, taxable ? (d.cessPerUnit ?? 0) : 0, normHsn(d.hsnSac)]);
}

/**
 * True when the master's own GST details differ (HSN included while it has its own details;
 * otherwise only switching "own details" on counts).
 */
export function gstChanged(draft: GstDraft, saved: GstMaster | null): boolean {
  if (!saved) return draft.gstApplicable;
  return sig(draft) !== sig(gstDraftFrom(saved));
}

export function hsnDiffers(draft: GstDraft, saved: GstMaster | null): boolean {
  return normHsn(draft.hsnSac) !== (saved?.hsnSac ?? null);
}

export interface GstCheckContext {
  /** 'goods' (HSN) / 'services' (SAC) / null for a stock group (either). */
  kind: 'goods' | 'services' | null;
  /** The master already has dated history. */
  hasHistory: boolean;
}

/** Field → message ('hsnSac', 'gstRate', 'cessRate', 'cessPerUnit', 'gstApplicableFrom'). */
export function validateGstDraft(d: GstDraft, saved: GstMaster | null, ctx: GstCheckContext): Record<string, string> {
  const e: Record<string, string> = {};
  const hsn = normHsn(d.hsnSac);
  if (hsn) {
    const err = validateHsnSac(hsn, ctx.kind ?? undefined);
    if (err) e.hsnSac = err;
  }
  if (d.gstApplicable && d.taxability === 'taxable') {
    if (d.gstRate === null) e.gstRate = 'Enter the GST rate (e.g. 18), or turn off "Set GST here" to use the stock group or ledger rate';
    else if (!isValidRate(d.gstRate)) e.gstRate = 'GST rate must be between 0 and 100';
    else if (!isStandardRate(d.gstRate) && !d.allowNonStandardRate) e.gstRate = `${formatPercent(d.gstRate)} is not a notified GST rate. Tick "Allow a non-standard rate" if it is correct.`;
    if (d.cessRate !== null && !isValidCessRate(d.cessRate)) e.cessRate = 'Cess must be between 0 and 400%';
    if (d.cessPerUnit !== null && (!Number.isSafeInteger(d.cessPerUnit) || d.cessPerUnit < 0)) e.cessPerUnit = 'Cess per unit cannot be negative';
  }
  if (saved && ctx.hasHistory && d.gstApplicable && gstChanged(d, saved) && !d.gstApplicableFrom)
    e.gstApplicableFrom = 'This has a dated rate history: say from which date the new GST details apply';
  return e;
}

/**
 * GST fields for a save input. Create: all of them. Alter: the HSN when it changed, and the whole
 * block (with the date) only when the details changed — an unchanged block is not sent, so a
 * master with history can be renamed without a date.
 */
export function gstSaveFields(d: GstDraft, saved: GstMaster | null): GstFieldsInput {
  const out: GstFieldsInput = {};
  const hsn = normHsn(d.hsnSac);
  if (!saved || hsnDiffers(d, saved)) out.hsnSac = hsn;
  if (!saved || gstChanged(d, saved)) {
    out.hsnSac = hsn;
    out.gstApplicable = d.gstApplicable;
    if (d.gstApplicable) {
      const taxable = d.taxability === 'taxable';
      out.taxability = d.taxability;
      out.gstRate = taxable ? d.gstRate : null;
      out.cessRate = taxable ? d.cessRate : null;
      out.cessPerUnit = taxable ? d.cessPerUnit : null;
      if (taxable && d.allowNonStandardRate) out.allowNonStandardRate = true;
      if (d.gstApplicableFrom) out.gstApplicableFrom = d.gstApplicableFrom;
    }
  }
  return out;
}

// ───────────────────────────── Rate select ─────────────────────────────

export interface RateOptionGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}

/** The special select value for "another rate" (typed in a percent field). */
export const OTHER_RATE = 'other';

/**
 * Options for the GST rate select: the slabs in use since the Sept-2025 rationalisation first,
 * then the other notified rates (older slabs and special rates), then "Another rate…".
 */
export function rateSelectGroups(current: readonly number[], all: readonly number[]): RateOptionGroup[] {
  const cur = [...current].sort((a, b) => a - b);
  const rest = all.filter((r) => !cur.includes(r)).sort((a, b) => a - b);
  return [
    { label: 'Current GST slabs', options: cur.map((r) => ({ value: String(r), label: `${formatPercent(r)}${r === 0 ? ' (zero rated)' : ''}` })) },
    { label: 'Other notified rates', options: rest.map((r) => ({ value: String(r), label: formatPercent(r) })) },
    { label: 'Not listed', options: [{ value: OTHER_RATE, label: 'Another rate…' }] },
  ];
}

/** Select value for a draft: the slab, OTHER_RATE for a non-standard rate, '' when none. */
export function rateSelectValue(d: Pick<GstDraft, 'gstRate' | 'allowNonStandardRate'>): string {
  if (d.allowNonStandardRate) return OTHER_RATE;
  if (d.gstRate === null) return '';
  return isStandardRate(d.gstRate) ? String(d.gstRate) : OTHER_RATE;
}

/** Draft patch for a select change. */
export function patchFromRateSelect(value: string): Pick<GstDraft, 'gstRate' | 'allowNonStandardRate'> | Pick<GstDraft, 'allowNonStandardRate'> {
  if (value === OTHER_RATE) return { allowNonStandardRate: true };
  if (value === '') return { gstRate: null, allowNonStandardRate: false };
  return { gstRate: Number(value), allowNonStandardRate: false };
}

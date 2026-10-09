/**
 * GSTR-3B screen model (pure; see gstr3b.test.ts): manual-entry fields and their dirty diff, the 3.2
 * table by place of supply, the ITC set-off explanation and the print / export table.
 *
 * Manual entries are edited as a draft (same shape as Gstr3bAdjustments, paise ≥ 0). Saving sends only
 * the heads that changed ('gst.gstr3b.saveAdjustments' merges them into what is stored).
 */
import type {
  Gstr3bAdjustmentKey,
  Gstr3bAdjustments,
  Gstr3bAdjustmentsInput,
  Gstr3bInterStateRow,
  Gstr3bSummary,
  SetOffResult,
  TaxAmounts,
  TaxHead,
} from '../../../../shared/types/gst-returns.ts';
import { GSTR3B_ADJUSTMENT_KEYS, TAX_HEADS } from '../../../../shared/types/gst-returns.ts';
import { formatMoney } from '../../../../shared/format.ts';
import type { TableExportDef } from '../../../app/lib/exportFormat.ts';

export const HEAD_LABELS: Readonly<Record<TaxHead, string>> = { igst: 'IGST', cgst: 'CGST', sgst: 'SGST/UTGST', cess: 'Cess' };

export interface AdjustmentField {
  key: Gstr3bAdjustmentKey;
  /** Form row ('4(A)(4)') or '6.1'. */
  row: string;
  label: string;
  help: string;
  heads: readonly TaxHead[];
  group: 'itc' | 'payment';
}

/** Manual GSTR-3B entries in the order they appear on the form. */
export const ADJUSTMENT_FIELDS: readonly AdjustmentField[] = [
  { key: 'itcIsd', row: '4(A)(4)', label: 'ITC from Input Service Distributor', help: 'Credit distributed to you by your ISD (see GSTR-6 / GSTR-2B).', heads: TAX_HEADS, group: 'itc' },
  {
    key: 'itcReclaimed',
    row: '4(D)(1)',
    label: 'ITC reclaimed (reversed earlier)',
    help: 'Credit reversed under 4(B)(2) earlier that you can take again now. It is also added to 4(A)(5).',
    heads: TAX_HEADS,
    group: 'itc',
  },
  {
    key: 'itcReversalRules',
    row: '4(B)(1)',
    label: 'ITC reversed — rules 38, 42, 43',
    help: 'Reversals for exempt / non-business use. Blocked credit under s.17(5) is added from your books automatically.',
    heads: TAX_HEADS,
    group: 'itc',
  },
  { key: 'itcReversalOthers', row: '4(B)(2)', label: 'ITC reversed — others', help: 'Any other reversal, e.g. unpaid suppliers after 180 days.', heads: TAX_HEADS, group: 'itc' },
  {
    key: 'itcIneligibleOthers',
    row: '4(D)(2)',
    label: 'Ineligible ITC — s.16(4) and place of supply',
    help: 'Credit you cannot take because of the time limit or place-of-supply rules (information only).',
    heads: TAX_HEADS,
    group: 'itc',
  },
  { key: 'interest', row: '5.1', label: 'Interest', help: 'Interest on late payment, as computed on the portal.', heads: TAX_HEADS, group: 'payment' },
  { key: 'lateFee', row: '5.1', label: 'Late fee', help: 'Late fee is charged under CGST and SGST only.', heads: ['cgst', 'sgst'], group: 'payment' },
  {
    key: 'creditLedgerBalance',
    row: '6.1',
    label: 'Credit not in the books (credit ledger)',
    help: 'Unused ITC of earlier months is brought forward from the books automatically. Enter only credit the books do not hold — e.g. your electronic credit ledger balance when you started using Bahi ERP.',
    heads: TAX_HEADS,
    group: 'payment',
  },
];

export type AdjustmentDraft = Gstr3bAdjustments;

export function emptyDraft(): AdjustmentDraft {
  const out = {} as AdjustmentDraft;
  for (const k of GSTR3B_ADJUSTMENT_KEYS) out[k] = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  return out;
}

/** A fresh, editable copy of the saved entries (missing keys / heads become 0). */
export function draftFrom(saved: Partial<Gstr3bAdjustments> | undefined): AdjustmentDraft {
  const out = emptyDraft();
  if (!saved) return out;
  for (const k of GSTR3B_ADJUSTMENT_KEYS) {
    const src = saved[k];
    if (!src) continue;
    for (const h of TAX_HEADS) out[k][h] = Number.isSafeInteger(src[h]) ? src[h] : 0;
  }
  return out;
}

/** Set one cell (blank → 0; negatives are not allowed on the form → 0). Returns a new draft. */
export function setDraftCell(draft: AdjustmentDraft, key: Gstr3bAdjustmentKey, head: TaxHead, value: number | null): AdjustmentDraft {
  const v = value === null || !Number.isFinite(value) || value < 0 ? 0 : Math.round(value);
  if (draft[key][head] === v) return draft;
  return { ...draft, [key]: { ...draft[key], [head]: v } };
}

/** Only the heads that differ from what is saved — the payload for 'gst.gstr3b.saveAdjustments'. */
export function diffAdjustments(saved: Partial<Gstr3bAdjustments> | undefined, draft: AdjustmentDraft): Gstr3bAdjustmentsInput['values'] {
  const base = draftFrom(saved);
  const out: Gstr3bAdjustmentsInput['values'] = {};
  for (const k of GSTR3B_ADJUSTMENT_KEYS) {
    const changed: Partial<TaxAmounts> = {};
    let any = false;
    for (const h of TAX_HEADS) {
      if (base[k][h] !== draft[k][h]) {
        changed[h] = draft[k][h];
        any = true;
      }
    }
    if (any) out[k] = changed;
  }
  return out;
}

export function isDraftDirty(saved: Partial<Gstr3bAdjustments> | undefined, draft: AdjustmentDraft): boolean {
  return Object.keys(diffAdjustments(saved, draft)).length > 0;
}

/** Number of edited cells (for "3 unsaved changes"). */
export function changedCellCount(saved: Partial<Gstr3bAdjustments> | undefined, draft: AdjustmentDraft): number {
  return Object.values(diffAdjustments(saved, draft)).reduce((n, v) => n + Object.keys(v ?? {}).length, 0);
}

// ───────────────────────────── 3.2 ─────────────────────────────

export interface InterStateRow {
  pos: string;
  posName: string;
  unregistered: { taxable: number; igst: number };
  composition: { taxable: number; igst: number };
  uin: { taxable: number; igst: number };
}

/** 3.2 as one row per place of supply with the three recipient categories side by side. */
export function interStateTable(s: Gstr3bSummary['interState']): InterStateRow[] {
  const map = new Map<string, InterStateRow>();
  const add = (rows: readonly Gstr3bInterStateRow[], cat: 'unregistered' | 'composition' | 'uin') => {
    for (const r of rows) {
      const row = map.get(r.pos) ?? {
        pos: r.pos,
        posName: r.posName,
        unregistered: { taxable: 0, igst: 0 },
        composition: { taxable: 0, igst: 0 },
        uin: { taxable: 0, igst: 0 },
      };
      row[cat].taxable += r.taxable;
      row[cat].igst += r.igst;
      map.set(r.pos, row);
    }
  };
  add(s.unregistered, 'unregistered');
  add(s.composition, 'composition');
  add(s.uin, 'uin');
  return [...map.values()].sort((a, b) => a.pos.localeCompare(b.pos));
}

// ───────────────────────────── 6.1 set-off ─────────────────────────────

export interface SetOffLine {
  credit: TaxHead;
  /** Credit available for set-off. */
  available: number;
  /** Part of `available` brought forward from the previous return period (books). */
  broughtForward: number;
  /** Uses in the order they are applied: [liability head, amount]. */
  uses: Array<{ against: TaxHead; amount: number }>;
  used: number;
  carriedForward: number;
}

/** Heads each credit may pay, in display order (Rule 88A / s.49(5); the amounts come from core setoff.ts). */
const USE_ORDER: Readonly<Record<TaxHead, readonly TaxHead[]>> = {
  igst: ['igst', 'cgst', 'sgst'],
  cgst: ['cgst', 'igst'],
  sgst: ['sgst', 'igst'],
  cess: ['cess'],
};

/** One line per credit head: what it paid, in order, and what is carried forward. */
export function setOffLines(setOff: SetOffResult, creditAvailable: TaxAmounts, broughtForward?: TaxAmounts): SetOffLine[] {
  return TAX_HEADS.map((credit) => {
    const row = setOff.utilisation[credit];
    const uses = USE_ORDER[credit].map((against) => ({ against, amount: row[against] ?? 0 })).filter((u) => u.amount > 0);
    // Anything the order table does not list (should not happen) is still shown.
    for (const h of TAX_HEADS) if (!USE_ORDER[credit].includes(h) && (row[h] ?? 0) > 0) uses.push({ against: h, amount: row[h] });
    const used = uses.reduce((a, u) => a + u.amount, 0);
    return { credit, available: creditAvailable[credit], broughtForward: broughtForward?.[credit] ?? 0, uses, used, carriedForward: setOff.creditBalance[credit] };
  });
}

/** Whether credit of one head may pay a liability of another (s.49(5): CGST and SGST never cross; cess only cess). */
export function creditMayPay(credit: TaxHead, liability: TaxHead): boolean {
  if (credit === 'cess' || liability === 'cess') return credit === liability;
  if (credit === 'igst') return true;
  return liability === credit || liability === 'igst';
}

const rs = (p: number): string => formatMoney(p, { symbol: true });

/** "IGST credit ₹ 600.00: ₹ 500.00 paid SGST, ₹ 100.00 paid CGST · nothing left." */
export function setOffSentence(l: SetOffLine): string {
  const head = `${HEAD_LABELS[l.credit]} credit ${rs(l.available)}${l.broughtForward > 0 ? ` (incl. ${rs(l.broughtForward)} brought forward)` : ''}`;
  if (l.available <= 0) return `${head}: none available.`;
  const uses = l.uses.length === 0 ? 'not needed this period' : l.uses.map((u) => `${rs(u.amount)} paid ${HEAD_LABELS[u.against]}`).join(', ');
  const left = l.carriedForward > 0 ? `${rs(l.carriedForward)} carried forward` : 'nothing left';
  return `${head}: ${uses} · ${left}.`;
}

/** The plain-language rule shown above the set-off table. */
export const SET_OFF_RULE =
  'IGST credit is used first — against IGST, then CGST and SGST (Rule 88A). CGST credit then pays CGST and then IGST; SGST credit pays SGST and then IGST. CGST and SGST credit are never used against each other. Cess credit pays cess only.';

// ───────────────────────────── 6.1 payment table (portal layout) ─────────────────────────────

export interface PaymentLine {
  head: TaxHead;
  label: string;
  /** Tax payable on this row. */
  payable: number;
  /** Paid through ITC, per credit head; null where that credit may not pay this tax (s.49(5)). */
  itc: Record<TaxHead, number | null>;
  /** Tax paid in cash. */
  cash: number;
  /** Interest / late fee paid in cash; null where the portal has no cell. */
  interest: number | null;
  lateFee: number | null;
}

export interface PaymentSection {
  id: 'A' | 'B';
  title: string;
  lines: PaymentLine[];
}

const NO_ITC: Readonly<Record<TaxHead, null>> = { igst: null, cgst: null, sgst: null, cess: null };

/**
 * 6.1 as on the portal: (A) other than reverse charge — tax payable, paid through ITC per credit head,
 * cash, interest and late fee (late fee only CGST / SGST); (B) reverse charge — always paid in cash.
 * Amounts come from the server (`Gstr3bPaymentRow`); nothing is recomputed.
 */
export function paymentSections(p: Gstr3bSummary['payment']): PaymentSection[] {
  const a: PaymentLine[] = p.rows.map((r) => {
    const paid: Record<TaxHead, number> = { igst: r.paidIgst, cgst: r.paidCgst, sgst: r.paidSgst, cess: r.paidCess };
    const itc = {} as Record<TaxHead, number | null>;
    for (const credit of TAX_HEADS) itc[credit] = creditMayPay(credit, r.head) ? paid[credit] : null;
    return {
      head: r.head,
      label: r.label,
      payable: r.liability,
      itc,
      cash: r.cash,
      interest: r.interest,
      // The portal charges late fee under CGST / SGST only; any other amount is still shown so the cash adds up.
      lateFee: r.head === 'cgst' || r.head === 'sgst' || r.lateFee !== 0 ? r.lateFee : null,
    };
  });
  const b: PaymentLine[] = p.rows.map((r) => ({ head: r.head, label: r.label, payable: r.rcmLiability, itc: { ...NO_ITC }, cash: r.rcmLiability, interest: null, lateFee: null }));
  return [
    { id: 'A', title: '(A) Other than reverse charge', lines: a },
    { id: 'B', title: '(B) Reverse charge', lines: b },
  ];
}

/** Everything paid in cash in the 6.1 sections (tax + interest + late fee) — equals `payment.cashTotal`. */
export function paymentCashTotal(sections: readonly PaymentSection[]): number {
  let total = 0;
  for (const s of sections) for (const l of s.lines) total += l.cash + (l.interest ?? 0) + (l.lateFee ?? 0);
  return total;
}

// ───────────────────────────── Export / print ─────────────────────────────

/** The whole form as one table (Section | Description | Taxable | IGST | CGST | SGST | Cess). */
export function gstr3bExport(s: Gstr3bSummary): Omit<TableExportDef, 'title' | 'company' | 'period'> {
  type Cells = [string, string, number | null, number | null, number | null, number | null, number | null];
  const rows: Cells[] = [];
  const tv = (row: string, label: string, v: { taxable?: number; igst: number; cgst: number; sgst: number; cess: number }): Cells => [
    row,
    label,
    v.taxable ?? null,
    v.igst,
    v.cgst,
    v.sgst,
    v.cess,
  ];
  for (const r of s.supplies) rows.push(tv(r.row, r.label, r));
  for (const r of s.eco) rows.push(tv(r.row, r.label, r));
  for (const r of interStateTable(s.interState)) {
    if (r.unregistered.taxable || r.unregistered.igst) rows.push(['3.2', `${r.posName} — unregistered persons`, r.unregistered.taxable, r.unregistered.igst, null, null, null]);
    if (r.composition.taxable || r.composition.igst) rows.push(['3.2', `${r.posName} — composition taxpayers`, r.composition.taxable, r.composition.igst, null, null, null]);
    if (r.uin.taxable || r.uin.igst) rows.push(['3.2', `${r.posName} — UIN holders`, r.uin.taxable, r.uin.igst, null, null, null]);
  }
  for (const r of s.itc.available) rows.push(tv(r.row, r.label, r));
  for (const r of s.itc.reversed) rows.push(tv(r.row, r.label, r));
  rows.push(tv('4(C)', 'Net ITC available (A − B)', s.itc.net));
  for (const r of s.itc.ineligible) rows.push(tv(r.row, r.label, r));
  for (const r of s.inward) {
    rows.push(['5', `${r.label} — inter-state`, r.inter, null, null, null, null]);
    rows.push(['5', `${r.label} — intra-state`, r.intra, null, null, null, null]);
  }
  rows.push(tv('5.1', 'Interest', s.interest));
  rows.push(tv('5.1', 'Late fee', s.lateFee));
  for (const sec of paymentSections(s.payment)) {
    const tag = `6.1${sec.id === 'A' ? '(A)' : '(B)'}`;
    for (const l of sec.lines) {
      if (sec.id === 'B' && l.payable === 0) continue;
      rows.push([tag, `${l.label} — tax payable${sec.id === 'A' ? ' (IGST…Cess columns: paid through that credit)' : ' under reverse charge'}`, l.payable, l.itc.igst, l.itc.cgst, l.itc.sgst, l.itc.cess]);
      const extra = (l.interest ?? 0) + (l.lateFee ?? 0);
      rows.push([tag, `${l.label} — paid in cash${extra > 0 ? ' (tax + interest + late fee)' : ''}`, l.cash + extra, null, null, null, null]);
    }
  }
  return {
    subtitle: `Return period ${s.period.label}${s.gstin ? ` · GSTIN ${s.gstin}` : ''}`,
    columns: [
      { header: 'Table', width: 8 },
      { header: 'Description', width: 50 },
      { header: 'Taxable value / amount', kind: 'amount' },
      { header: 'IGST', kind: 'amount' },
      { header: 'CGST', kind: 'amount' },
      { header: 'SGST/UTGST', kind: 'amount' },
      { header: 'Cess', kind: 'amount' },
    ],
    rows,
    totals: ['', 'Total cash to pay', s.payment.cashTotal, null, null, null, null],
    notes: s.notes.join(' '),
    landscape: true,
  };
}

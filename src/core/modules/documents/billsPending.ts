/**
 * Sales Bills Pending / Purchase Bills Pending (Tally › Statements of Inventory): delivery / receipt
 * notes and rejections whose goods moved but which are not (fully) billed yet.
 *
 *   sales:    delivery_note ← sales invoice,   rejection_in  ← credit note
 *   purchase: receipt_note  ← purchase invoice, rejection_out ← debit note
 *
 * A note line carries the note's own number in `inventory_entries.tracking_ref`; an invoice line that
 * bills it carries the same number (vouchers README › Tracking). Billing is matched per party + note
 * number + item and applied to the note's lines in line order — the rule of `vouchers.trackingRefs` —
 * across all parties, counting only invoices dated on or before `asOf` (so the report can be run for
 * a past date). Optional and cancelled documents never count. Value = pending qty × rate less
 * discount (the note's own rate; a stock-only challan has rate 0 and value 0).
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { diffDays } from '../../../shared/dates.ts';
import { lineAmount } from '../../../shared/money.ts';
import type { BillsPendingInput, BillsPendingKind, BillsPendingResult, BillsPendingRow } from '../../../shared/types/documents.ts';
import type { Db } from '../../db/db.ts';

/** Note base type → the invoice base type that bills it. */
export const NOTE_BILLED_BY: Partial<Record<VoucherBaseType, VoucherBaseType>> = {
  delivery_note: 'sales',
  rejection_in: 'credit_note',
  receipt_note: 'purchase',
  rejection_out: 'debit_note',
};

const KIND_NOTES: Record<BillsPendingKind, readonly VoucherBaseType[]> = {
  sales: ['delivery_note', 'rejection_in'],
  purchase: ['receipt_note', 'rejection_out'],
};

const EPS = 1e-9;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

interface NoteLineDb {
  voucher_id: number;
  line_no: number;
  number: string;
  date: string;
  base_type: string;
  type_name: string;
  party_ledger_id: number | null;
  party_name: string | null;
  item_id: number;
  item_name: string;
  unit: string;
  qty: number;
  rate: number;
  discount_pct: number | null;
  godown_id: number | null;
  batch_name: string | null;
  ledger_id: number | null;
}

export interface PendingNoteLine {
  noteId: number;
  lineNo: number;
  noteNo: string;
  noteDate: string;
  noteBaseType: VoucherBaseType;
  noteTypeName: string;
  partyLedgerId: number | null;
  partyName: string;
  itemId: number;
  itemName: string;
  unit: string;
  qty: number;
  billedQty: number;
  pendingQty: number;
  rate: number;
  discountPct: number;
  godownId: number | null;
  batchName: string | null;
  ledgerId: number | null;
}

const LINES_SQL = (filter: string): string => `
  SELECT ie.voucher_id, ie.line_no, v.number, v.date, v.base_type, vt.name AS type_name, v.party_ledger_id,
         COALESCE(l.name, v.party_name) AS party_name, ie.item_id, si.name AS item_name, u.symbol AS unit,
         ABS(ie.qty) AS qty, ie.rate, ie.discount_pct, ie.godown_id, ie.batch_name, ie.ledger_id
    FROM inventory_entries ie
    JOIN vouchers v ON v.id = ie.voucher_id
    JOIN voucher_types vt ON vt.id = v.voucher_type_id
    JOIN stock_items si ON si.id = ie.item_id
    JOIN units u ON u.id = si.unit_id
    LEFT JOIN ledgers l ON l.id = v.party_ledger_id
   WHERE v.is_cancelled = 0 AND v.is_optional = 0 AND v.number IS NOT NULL AND ie.tracking_ref IS NOT NULL AND ${filter}
   ORDER BY v.date, v.id, ie.line_no`;

/** Billed quantity per `${noteBase}|${party}|${ref}|${item}` (invoices dated ≤ asOf). */
function billedMap(db: Db, invoiceBases: readonly VoucherBaseType[], asOf: string, party: number | null): Map<string, number> {
  const out = new Map<string, number>();
  const noteOf = new Map<string, string>(Object.entries(NOTE_BILLED_BY).map(([n, i]) => [i as string, n]));
  const sql = `SELECT v.base_type, v.party_ledger_id AS party, ie.tracking_ref AS ref, ie.item_id, SUM(ABS(ie.qty)) AS qty
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.base_type IN (SELECT value FROM json_each(:bases)) AND v.is_cancelled = 0 AND v.is_optional = 0
        AND v.date <= :asOf AND ie.tracking_ref IS NOT NULL ${party === null ? '' : 'AND v.party_ledger_id = :party'}
      GROUP BY v.base_type, v.party_ledger_id, ie.tracking_ref, ie.item_id`;
  for (const r of db.all<{ base_type: string; party: number | null; ref: string; item_id: number; qty: number }>(sql, {
    bases: JSON.stringify(invoiceBases),
    asOf,
    ...(party === null ? {} : { party }),
  })) {
    out.set(`${noteOf.get(r.base_type)}|${r.party ?? 0}|${r.ref}|${r.item_id}`, Number(r.qty));
  }
  return out;
}

function positions(lines: readonly NoteLineDb[], billed: Map<string, number>): PendingNoteLine[] {
  const left = new Map(billed);
  const out: PendingNoteLine[] = [];
  for (const l of lines) {
    const key = `${l.base_type}|${l.party_ledger_id ?? 0}|${l.number}|${l.item_id}`;
    const avail = left.get(key) ?? 0;
    const qty = Number(l.qty);
    const take = Math.min(avail, qty);
    left.set(key, avail - take);
    out.push({
      noteId: l.voucher_id,
      lineNo: l.line_no,
      noteNo: l.number,
      noteDate: l.date,
      noteBaseType: l.base_type as VoucherBaseType,
      noteTypeName: l.type_name,
      partyLedgerId: l.party_ledger_id,
      partyName: l.party_name ?? '',
      itemId: l.item_id,
      itemName: l.item_name,
      unit: l.unit,
      qty: round6(qty),
      billedQty: round6(take),
      pendingQty: round6(qty - take),
      rate: Number(l.rate),
      discountPct: Number(l.discount_pct ?? 0),
      godownId: l.godown_id,
      batchName: l.batch_name,
      ledgerId: l.ledger_id,
    });
  }
  return out;
}

/** 'documents.billsPending' — unbilled note lines as of a date. */
export function billsPending(db: Db, input: BillsPendingInput): BillsPendingResult {
  const notes = KIND_NOTES[input.kind];
  const party = input.partyLedgerId ?? null;
  const lines = db.all<NoteLineDb>(
    LINES_SQL(`v.base_type IN (SELECT value FROM json_each(:bases)) AND v.date <= :asOf${party === null ? '' : ' AND v.party_ledger_id = :party'}${input.itemId === undefined ? '' : ' AND ie.item_id = :item'}`),
    { bases: JSON.stringify(notes), asOf: input.asOf, ...(party === null ? {} : { party }), ...(input.itemId === undefined ? {} : { item: input.itemId }) },
  );
  const billed = billedMap(db, notes.map((n) => NOTE_BILLED_BY[n] as VoucherBaseType), input.asOf, party);
  const rows: BillsPendingRow[] = [];
  const noteIds = new Set<number>();
  const parties = new Set<string>();
  const old = new Set<number>();
  let pendingValue = 0;
  for (const p of positions(lines, billed)) {
    if (p.pendingQty <= EPS) continue;
    const value = lineAmount(p.pendingQty, p.rate, p.discountPct);
    const age = diffDays(p.noteDate, input.asOf);
    rows.push({
      key: `n:${p.noteId}:${p.lineNo}`,
      noteId: p.noteId,
      noteNo: p.noteNo,
      noteDate: p.noteDate,
      noteBaseType: p.noteBaseType,
      noteTypeName: p.noteTypeName,
      invoiceBaseType: NOTE_BILLED_BY[p.noteBaseType] as VoucherBaseType,
      partyLedgerId: p.partyLedgerId,
      partyName: p.partyName,
      itemId: p.itemId,
      itemName: p.itemName,
      unit: p.unit,
      qty: p.qty,
      billedQty: p.billedQty,
      pendingQty: p.pendingQty,
      rate: p.rate,
      discountPct: p.discountPct,
      pendingValue: value,
      ageDays: age,
    });
    noteIds.add(p.noteId);
    parties.add(String(p.partyLedgerId ?? p.partyName));
    // Challans only (a rejection awaits a credit / debit note, not an invoice under s.31).
    if (age > 7 && (p.noteBaseType === 'delivery_note' || p.noteBaseType === 'receipt_note')) old.add(p.noteId);
    pendingValue += value;
  }
  return { kind: input.kind, asOf: input.asOf, rows, totals: { notes: noteIds.size, parties: parties.size, pendingValue, olderThan7Days: old.size } };
}

/** Unbilled lines of one note, counting every regular invoice that bills it (for "Invoice now"). */
export function notePendingLines(db: Db, noteId: number): PendingNoteLine[] {
  const lines = db.all<NoteLineDb>(LINES_SQL('v.id = :id'), { id: noteId });
  if (lines.length === 0) return [];
  const invoiceBase = NOTE_BILLED_BY[lines[0].base_type as VoucherBaseType];
  if (!invoiceBase) return [];
  const billed = billedMap(db, [invoiceBase], '9999-12-31', lines[0].party_ledger_id);
  return positions(lines, billed).filter((p) => p.pendingQty > EPS);
}

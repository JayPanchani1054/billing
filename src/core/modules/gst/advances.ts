/**
 * Advances received for future supplies (CGST s.12(2) / s.13(2): time of supply of services is the
 * earlier of invoice and payment; for goods, Notification 66/2017-CT (15-Nov-2017) exempts every
 * registered person other than composition taxpayers from paying tax on advances — so only services
 * attract tax here).
 *
 * Posting (by the gst voucher hook, hook.ts):
 *   Receipt marked "advance against supply":  Dr GST on Advances Received / Cr Output IGST|CGST+SGST (+Cess)
 *   Sales invoice adjusting the advance:       Dr Output tax / Cr GST on Advances Received (proportionate)
 *   Refund voucher (payment) for the advance:  Dr Output tax / Cr GST on Advances Received (proportionate)
 * The receipt's own lines (Dr Bank / Cr Party) are as entered. Tax is computed treating the amount
 * received as inclusive of tax: taxable = amount × 100 / (100 + rate + cess rate), heads on taxable,
 * taxable absorbing the rounding so taxable + tax = amount exactly.
 *
 * Returns: GSTR-1 Table 11A (received in the period, POS × rate) and 11B (adjusted / refunded in the
 * period, at the advance's rate and POS); GSTR-3B 3.1(a) adds 11A − 11B.
 */
import type { Paise } from '../../../shared/money.ts';
import { stateName } from '../../../shared/gst/index.ts';
import type { AdvanceVoucherRow, Gstr1AdvancesSummary, PendingAdvance, Table11Row } from '../../../shared/types/gst-plus.ts';
import type { TaxValue } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { addTV, zeroTV } from './docs.ts';

export interface AdvanceTax extends TaxValue {
  gross: Paise;
}

/** Split an amount received (incl. tax) into taxable value and tax heads. */
export function advanceTax(gross: Paise, rate: number, cessRate: number, interState: boolean): AdvanceTax {
  if (rate <= 0 && cessRate <= 0) return { gross, taxable: gross, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const base = Math.round((gross * 100) / (100 + rate + cessRate));
  const cess = Math.round((base * cessRate) / 100);
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  if (interState) igst = Math.round((base * rate) / 100);
  else {
    cgst = Math.round((base * rate) / 200);
    sgst = cgst;
  }
  return { gross, taxable: gross - igst - cgst - sgst - cess, igst, cgst, sgst, cess };
}

export interface ReceivedAdvance {
  receiptVoucherId: number;
  partyLedgerId: number | null;
  pos: string;
  supplyType: string;
  rate: number;
  cessRate: number;
  gross: Paise;
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  /** Already adjusted / refunded by other vouchers (books filter). */
  used: AdvanceTax;
}

/** The advance recorded by a receipt (counting in the books), with what other vouchers already used. */
export function receivedAdvance(db: Db, receiptVoucherId: number, today: string, excludeVoucherId: number | null): ReceivedAdvance | null {
  const r = db.get<{
    party_ledger_id: number | null;
    pos: string;
    supply_type: string;
    rate: number;
    cess_rate: number;
    gross: number;
    taxable_value: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  }>(
    `SELECT party_ledger_id, pos, supply_type, rate, cess_rate, gross, taxable_value, igst, cgst, sgst, cess
       FROM gst_advance_lines a WHERE a.voucher_id = :id AND a.kind = 'received' AND ${BOOKS_FILTER('a')}`,
    { id: receiptVoucherId, today },
  );
  if (!r) return null;
  const used = db.get<{ gross: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>(
    `SELECT COALESCE(SUM(gross),0) AS gross, COALESCE(SUM(taxable_value),0) AS taxable, COALESCE(SUM(igst),0) AS igst,
            COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst, COALESCE(SUM(cess),0) AS cess
       FROM gst_advance_lines a
      WHERE a.receipt_voucher_id = :id AND a.kind IN ('adjusted','refunded') AND a.voucher_id <> :self AND ${BOOKS_FILTER('a')}`,
    { id: receiptVoucherId, self: excludeVoucherId ?? 0, today },
  ) ?? { gross: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  return {
    receiptVoucherId,
    partyLedgerId: r.party_ledger_id,
    pos: r.pos,
    supplyType: r.supply_type,
    rate: r.rate,
    cessRate: r.cess_rate,
    gross: r.gross,
    taxable: r.taxable_value,
    igst: r.igst,
    cgst: r.cgst,
    sgst: r.sgst,
    cess: r.cess,
    used: { gross: used.gross, taxable: used.taxable, igst: used.igst, cgst: used.cgst, sgst: used.sgst, cess: used.cess },
  };
}

/**
 * Proportionate share of an advance for `amount` (gross). The last use (amount = what is left) takes
 * exactly the remainder of every head, so the advance's tax is reversed to the paisa in total.
 */
export function shareOfAdvance(a: ReceivedAdvance, amount: Paise): AdvanceTax {
  const left = a.gross - a.used.gross;
  if (amount >= left) {
    return {
      gross: left,
      taxable: a.taxable - a.used.taxable,
      igst: a.igst - a.used.igst,
      cgst: a.cgst - a.used.cgst,
      sgst: a.sgst - a.used.sgst,
      cess: a.cess - a.used.cess,
    };
  }
  const f = (x: number): number => Math.round((x * amount) / a.gross);
  const igst = f(a.igst);
  const cgst = f(a.cgst);
  const sgst = f(a.sgst);
  const cess = f(a.cess);
  return { gross: amount, taxable: amount - igst - cgst - sgst - cess, igst, cgst, sgst, cess };
}

/** Receipt that created bill `billName` of `ledgerId` as an advance with GST (for bill-wise adjustment). */
export function advanceReceiptForBill(db: Db, ledgerId: number, billName: string, today: string): number | null {
  return (
    db.value<number>(
      `SELECT ba.voucher_id FROM bill_allocations ba
         JOIN gst_advance_lines a ON a.voucher_id = ba.voucher_id AND a.kind = 'received'
        WHERE ba.ledger_id = :ledger AND ba.bill_name = :name AND ba.ref_type = 'advance' AND ${BOOKS_FILTER('ba')}
        ORDER BY ba.date, ba.voucher_id LIMIT 1`,
      { ledger: ledgerId, name: billName, today },
    ) ?? null
  );
}

/** Advances not yet fully adjusted or refunded as of `asOf` (optionally of one party). */
export function pendingAdvances(db: Db, asOf: string, today: string, partyLedgerId?: number): PendingAdvance[] {
  const rows = db.all<{
    id: number;
    number: string | null;
    date: string;
    party_ledger_id: number | null;
    party: string | null;
    pos: string;
    rate: number;
    gross: number;
    used: number;
  }>(
    `SELECT a.voucher_id AS id, v.number, a.date, a.party_ledger_id, l.name AS party, a.pos, a.rate, a.gross,
            COALESCE((SELECT SUM(u.gross) FROM gst_advance_lines u
                       WHERE u.receipt_voucher_id = a.voucher_id AND u.kind IN ('adjusted','refunded') AND u.date <= :asOf
                         AND ${BOOKS_FILTER('u')}), 0) AS used
       FROM gst_advance_lines a
       JOIN vouchers v ON v.id = a.voucher_id
       LEFT JOIN ledgers l ON l.id = a.party_ledger_id
      WHERE a.kind = 'received' AND a.date <= :asOf AND ${BOOKS_FILTER('a')}
      ORDER BY a.date, a.voucher_id`,
    { asOf, today },
  );
  return rows
    .filter((r) => (partyLedgerId === undefined || r.party_ledger_id === partyLedgerId) && r.gross - r.used > 0)
    .map((r) => ({
      receiptVoucherId: r.id,
      number: r.number,
      date: r.date,
      partyLedgerId: r.party_ledger_id,
      partyName: r.party,
      pos: r.pos,
      rate: r.rate,
      gross: r.gross,
      pending: r.gross - r.used,
    }));
}

// ───────────────────────────── Table 11 ─────────────────────────────

interface LineRow {
  voucher_id: number;
  receipt_voucher_id: number | null;
  kind: 'received' | 'adjusted' | 'refunded';
  pos: string;
  rate: number;
  gross: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  date: string;
  number: string | null;
  party: string | null;
}

function aggregate(rows: readonly LineRow[], companyState: string): Table11Row[] {
  const by = new Map<string, Table11Row>();
  for (const r of rows) {
    const inter = r.igst !== 0 || (r.cgst === 0 && r.sgst === 0 && r.pos !== companyState);
    const key = `${r.pos}|${r.rate}|${inter ? 'INTER' : 'INTRA'}`;
    let t = by.get(key);
    if (!t) {
      t = { pos: r.pos, posName: stateName(r.pos) || r.pos, supplyKind: inter ? 'INTER' : 'INTRA', rate: r.rate, gross: 0, ...zeroTV() };
      by.set(key, t);
    }
    t.gross += r.gross;
    addTV(t, { taxable: r.taxable_value, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess });
  }
  return [...by.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate);
}

/**
 * GSTR-1 Table 11A / 11B for a date range (books filter). An advance received and adjusted / refunded
 * within the same range is left out of both tables (only its unadjusted part is in 11A); `vouchers`
 * still lists every advance line of the range.
 */
export function table11(db: Db, from: string, to: string, today: string, companyState: string): Gstr1AdvancesSummary {
  const rows = db.all<LineRow>(
    `SELECT a.voucher_id, a.receipt_voucher_id, a.kind, a.pos, a.rate, a.gross, a.taxable_value, a.igst, a.cgst, a.sgst, a.cess, a.date,
            v.number, COALESCE(v.party_name, l.name) AS party
       FROM gst_advance_lines a
       JOIN vouchers v ON v.id = a.voucher_id
       LEFT JOIN ledgers l ON l.id = a.party_ledger_id
      WHERE a.date >= :from AND a.date <= :to AND ${BOOKS_FILTER('a')}
      ORDER BY a.date, a.voucher_id, a.id`,
    { from, to, today },
  );
  // GSTR-1 instructions: 11A(1) is an advance received in the period "for which invoice has not been
  // issued in the same tax period", and 11B(1) adjusts advances "received in earlier tax period". An
  // advance received and adjusted / refunded in the same period is therefore in neither table — only
  // the part still unadjusted at the end of the period goes to 11A (the tax effect is the same).
  const receivedHere = new Map<number, LineRow>();
  for (const r of rows) if (r.kind === 'received') receivedHere.set(r.voucher_id, { ...r });
  const adjustedRows: LineRow[] = [];
  for (const r of rows) {
    if (r.kind === 'received') continue;
    const own = r.receipt_voucher_id !== null ? receivedHere.get(r.receipt_voucher_id) : undefined;
    if (!own) {
      adjustedRows.push(r);
      continue;
    }
    own.gross -= r.gross;
    own.taxable_value -= r.taxable_value;
    own.igst -= r.igst;
    own.cgst -= r.cgst;
    own.sgst -= r.sgst;
    own.cess -= r.cess;
  }
  const received = aggregate([...receivedHere.values()].filter((r) => r.gross !== 0 || r.taxable_value !== 0), companyState).filter(
    (t) => t.gross !== 0 || t.taxable !== 0 || t.igst !== 0 || t.cgst !== 0 || t.sgst !== 0 || t.cess !== 0,
  );
  const adjusted = aggregate(adjustedRows, companyState);
  const net = zeroTV();
  for (const r of received) addTV(net, r);
  for (const r of adjusted) addTV(net, r, -1);
  const vouchers: AdvanceVoucherRow[] = rows.map((r) => ({
    voucherId: r.voucher_id,
    receiptVoucherId: r.receipt_voucher_id,
    kind: r.kind,
    number: r.number,
    date: r.date,
    partyName: r.party,
    pos: r.pos,
    rate: r.rate,
    gross: r.gross,
    taxable: r.taxable_value,
    igst: r.igst,
    cgst: r.cgst,
    sgst: r.sgst,
    cess: r.cess,
  }));
  return { received, adjusted, vouchers, net };
}

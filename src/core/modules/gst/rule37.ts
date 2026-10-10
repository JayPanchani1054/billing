/**
 * Rule 37 — the 180-day payment check (final wave; README §19).
 *
 * CGST Act s.16(2) second proviso and CGST Rules, Rule 37: when the recipient has not paid the supplier
 * the value of the supply together with the tax within 180 days from the date of the invoice, the input
 * tax credit availed, proportionate to the amount not paid, is reversed in GSTR-3B (Table 4(B)(2)) for
 * the tax period immediately following the period in which the 180 days end, with interest u/s 50. It
 * may be re-availed (Rule 37(4): 4(A)(5) + 4(D)(1)) once the supplier is paid.
 *
 * The report reads, for every purchase invoice in the books (B2B forward charge; credit taken, i.e. not
 * marked ineligible; not reverse charge, imports or composition suppliers), the supplier's bill-wise
 * balance of the invoice's own bill as of the as-of date (payments, debit notes and TDS against the bill
 * count as paid; a payment by a later voucher dated after the as-of date does not):
 *   due      = credit × unpaid ÷ invoice value (per head, rounded to the paisa)
 *   reversed = Rule 37 reversals − reclaims already posted for the invoice (gst_rule37_links)
 *   reverse now = due − reversed when positive;  reclaim now = reversed − due when positive.
 * Purchases of suppliers kept without bill-wise details cannot be traced and are listed apart.
 *
 * Posting (`postRule37`) goes through the existing stat-adjustment mechanism: one Journal
 *   reversal: Dr ITC Reversed (GST) / Cr Input <head>   gstDetails.adjustment { itc_reversal_r37, rule37[] }
 *   reclaim:  Dr Input <head> / Cr ITC Reversed (GST)   gstDetails.adjustment { itc_reclaim, rule37[] }
 * via saveVoucher (numbered, audited, period-lock aware); the gst hook writes the invoice links.
 * Interest u/s 50 (18% p.a. from the date the credit was availed) is the user's computation: it is
 * entered under GSTR-3B "Your entries" (5.1 Interest).
 */
import type { Rule37Input, Rule37PostInput, Rule37Result, Rule37Row } from '../../../shared/types/gst-plus.ts';
import type { TaxAmounts, TaxHead } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import type { LedgerLineInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { addDays, addMonths, formatDate } from '../../../shared/dates.ts';
import { roundPaise, type Paise } from '../../../shared/money.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { rule, validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { zeroTax, type GstCompany } from './docs.ts';
import { periodLabel } from './filings.ts';
import { monthPeriodKey, parsePeriodKey, quarterPeriodKey } from './period.ts';
import { dutyLedgers, ensureStatLedger } from './statLedgers.ts';

interface PurchaseRow {
  id: number;
  number: string | null;
  date: string;
  reference_no: string | null;
  party_ledger_id: number;
  party_name: string;
  bill_wise: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

/** Credit-carrying B2B forward-charge purchases dated on or before `cutoff` (books filter). */
const PURCHASES_SQL = /* sql */ `
  SELECT v.id, v.number, v.date, v.reference_no, v.party_ledger_id, l.name AS party_name, l.maintain_bill_wise AS bill_wise,
         SUM(g.igst) AS igst, SUM(g.cgst) AS cgst, SUM(g.sgst) AS sgst, SUM(g.cess) AS cess
    FROM vouchers v
    JOIN ledgers l ON l.id = v.party_ledger_id
    JOIN gst_lines g ON g.voucher_id = v.id
   WHERE v.base_type = 'purchase' AND ${BOOKS_FILTER('v')} AND v.date <= :cutoff
     AND v.is_reverse_charge = 0
     AND COALESCE(v.gst_nature, '') IN ('inward_b2b', 'inward_sez')
     AND g.taxability = 'taxable' AND g.is_reverse_charge = 0
     AND COALESCE(g.itc_eligibility, '') <> 'ineligible'
     AND NOT (COALESCE(v.gst_nature, '') = 'inward_sez' AND g.supply_type = 'goods')
   GROUP BY v.id
  HAVING SUM(g.igst) + SUM(g.cgst) + SUM(g.sgst) + SUM(g.cess) > 0
   ORDER BY v.date, v.id`;

/** Return period (month, or quarter for quarterly filers) following the one containing `iso`. */
function nextPeriod(company: GstCompany, iso: string): string {
  const quarterly = company.config.gst.filingFrequency === 'quarterly';
  if (!quarterly) return monthPeriodKey(addMonths(`${iso.slice(0, 7)}-01`, 1));
  const ref = parsePeriodKey(quarterPeriodKey(iso));
  return quarterPeriodKey(addMonths(ref?.from ?? iso, 3));
}

function scale(t: TaxAmounts, num: Paise, den: Paise): TaxAmounts {
  const out = zeroTax();
  if (den <= 0) return out;
  for (const h of TAX_HEADS) out[h] = roundPaise((t[h] * num) / den);
  return out;
}

export function rule37Report(db: Db, company: GstCompany, today: string, input: Rule37Input): Rule37Result {
  const asOf = input.asOf;
  // Unpaid within 180 days of the invoice date: the 180th day has passed by the as-of date.
  const cutoff = addDays(asOf, -181);
  const params: Record<string, string | number> = { cutoff, today };
  let rows = db.all<PurchaseRow>(PURCHASES_SQL, params);
  if (input.partyLedgerId !== undefined) rows = rows.filter((r) => r.party_ledger_id === input.partyLedgerId);
  const out: Rule37Row[] = [];
  const notBillWise: Rule37Result['notBillWise'] = [];
  const totals = { toReverse: zeroTax(), toReclaim: zeroTax(), unpaid: 0 };
  for (const r of rows) {
    if (r.bill_wise !== 1) {
      notBillWise.push({ voucherId: r.id, number: r.number, date: r.date, partyName: r.party_name });
      continue;
    }
    // The invoice's own bill on the supplier (a 'new' reference, Cr).
    const bill = db.get<{ name: string; amount: number }>(
      `SELECT bill_name AS name, SUM(amount) AS amount FROM bill_allocations
        WHERE voucher_id = :v AND ledger_id = :party AND ref_type = 'new' AND bill_name IS NOT NULL
        GROUP BY bill_name ORDER BY MIN(id) LIMIT 1`,
      { v: r.id, party: r.party_ledger_id },
    );
    if (!bill || bill.amount >= 0) {
      notBillWise.push({ voucherId: r.id, number: r.number, date: r.date, partyName: r.party_name });
      continue;
    }
    const value = -bill.amount;
    const net =
      db.value<number>(
        `SELECT COALESCE(SUM(ba.amount), 0) FROM bill_allocations ba JOIN vouchers v ON v.id = ba.voucher_id
          WHERE ba.ledger_id = :party AND ba.bill_name = :name AND ba.date <= :asOf AND ${BOOKS_FILTER('v')}`,
        { party: r.party_ledger_id, name: bill.name, asOf, today },
      ) ?? 0;
    const unpaid = Math.max(0, Math.min(value, -net));
    const itc: TaxAmounts = { igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess };
    const due = scale(itc, unpaid, value);
    const reversed = zeroTax();
    for (const l of db.all<{ kind: string } & Record<TaxHead, number>>(
      `SELECT kind, SUM(igst) AS igst, SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(cess) AS cess FROM gst_rule37_links k
        WHERE k.purchase_voucher_id = :v AND ${BOOKS_FILTER('k')} GROUP BY kind`,
      { v: r.id, today },
    )) {
      for (const h of TAX_HEADS) reversed[h] += (l.kind === 'reversal' ? 1 : -1) * l[h];
    }
    const toReverse = zeroTax();
    const toReclaim = zeroTax();
    for (const h of TAX_HEADS) {
      toReverse[h] = Math.max(0, due[h] - reversed[h]);
      toReclaim[h] = Math.max(0, reversed[h] - due[h]);
    }
    if (unpaid === 0 && TAX_HEADS.every((h) => reversed[h] === 0)) continue; // paid, nothing reversed
    const deadline = addDays(r.date, 180);
    const report = nextPeriod(company, deadline);
    out.push({
      voucherId: r.id,
      number: r.number,
      date: r.date,
      referenceNo: r.reference_no,
      partyLedgerId: r.party_ledger_id,
      partyName: r.party_name,
      deadline,
      reportPeriod: report,
      reportPeriodLabel: periodLabel('gstr3b', report),
      value,
      unpaid,
      itc,
      due,
      reversed,
      toReverse,
      toReclaim,
    });
    for (const h of TAX_HEADS) {
      totals.toReverse[h] += toReverse[h];
      totals.toReclaim[h] += toReclaim[h];
    }
    totals.unpaid += unpaid;
  }
  const notes = [
    'Credit on purchases not paid within 180 days of the invoice date is reversed in GSTR-3B 4(B)(2) of the period after the one in which the 180 days end (CGST s.16(2), Rule 37), and re-availed in 4(A)(5) / 4(D)(1) once paid (Rule 37(4)).',
    'Interest u/s 50 on the credit reversed is not computed here: enter it under GSTR-3B "Your entries" (5.1 Interest).',
    'Paid means paid against the invoice’s bill (bill-wise): payments, debit notes and TDS set against it. Payments made "on account" are not traced.',
  ];
  if (notBillWise.length > 0) notes.push(`${notBillWise.length} purchase(s) are of suppliers kept without bill-wise details; check their payment by hand.`);
  return { asOf, rows: out, totals, notBillWise, notes };
}

function journalTypeId(db: Db): number {
  const id = db.value<number>(`SELECT id FROM voucher_types WHERE base_type = 'journal' AND is_active = 1 ORDER BY is_predefined DESC, id LIMIT 1`);
  if (id === undefined) throw rule('No active Journal voucher type. Activate one under Masters › Voucher Types.');
  return id;
}

/** Post the Rule 37 reversal (or Rule 37(4) reclaim) journal for the report's rows. */
export function postRule37(ctx: CompanyCtx, company: GstCompany, input: Rule37PostInput): VoucherSaveResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  if (company.registration !== 'regular') throw rule('Rule 37 applies to regular taxpayers who take input tax credit.');
  const report = rule37Report(db, company, today, { asOf: input.asOf });
  const want = input.voucherIds ? new Set(input.voucherIds) : null;
  const pick = input.kind === 'reversal' ? (r: Rule37Row) => r.toReverse : (r: Rule37Row) => r.toReclaim;
  const rows = report.rows.filter((r) => (!want || want.has(r.voucherId)) && TAX_HEADS.some((h) => pick(r)[h] > 0));
  if (rows.length === 0) {
    throw validation([{ path: 'voucherIds', message: input.kind === 'reversal' ? `Nothing to reverse under Rule 37 as on ${formatDate(input.asOf)}.` : `Nothing to reclaim as on ${formatDate(input.asOf)}.` }]);
  }
  if (input.date < input.asOf) throw validation([{ path: 'date', message: `Date the journal on or after ${formatDate(input.asOf)} (the date the report was taken).` }]);
  const total = zeroTax();
  for (const r of rows) for (const h of TAX_HEADS) total[h] += pick(r)[h];
  const duty = dutyLedgers(db);
  const ts = ctx.clock.now().toISOString();
  const reversedLedger = ensureStatLedger(db, 'ITC_REVERSED', ts, (e) => ctx.audit(e));
  const sign = input.kind === 'reversal' ? -1 : 1;
  const lines: LedgerLineInput[] = [];
  let sum = 0;
  for (const h of TAX_HEADS) {
    if (total[h] === 0) continue;
    const id = duty.input[h];
    if (id === undefined) throw rule(`The Input ${h.toUpperCase()} ledger is missing. Turn GST on again under F11 to recreate the GST ledgers.`);
    lines.push({ ledgerId: id, amount: sign * total[h] });
    sum += total[h];
  }
  lines.unshift({ ledgerId: reversedLedger, amount: -sign * sum });
  return saveVoucher(ctx, {
    voucherTypeId: journalTypeId(db),
    date: input.date,
    mode: 'ledger',
    narration:
      input.narration?.trim() ||
      (input.kind === 'reversal'
        ? `ITC reversed under Rule 37 — ${rows.length} purchase invoice(s) not paid within 180 days (as on ${formatDate(input.asOf)})`
        : `ITC reclaimed under Rule 37(4) — ${rows.length} purchase invoice(s) since paid (as on ${formatDate(input.asOf)})`),
    ledgers: lines,
    gstDetails: {
      adjustment: {
        nature: input.kind === 'reversal' ? 'itc_reversal_r37' : 'itc_reclaim',
        rule37: rows.map((r) => {
          const a = pick(r);
          return { purchaseVoucherId: r.voucherId, igst: a.igst, cgst: a.cgst, sgst: a.sgst, cess: a.cess };
        }),
      },
    },
    acknowledgeWarnings: true,
  });
}

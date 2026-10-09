/**
 * GST set-off for a return period, posted to the books, and GST challans (PMT-06).
 *
 * Regular taxpayers (GSTR-3B 6.1): the utilisation computed by setoff.ts (s.49(5), Rule 88A: IGST credit
 * first — against IGST, then CGST / SGST in any proportion; CGST credit never against SGST and vice
 * versa; cess credit only against cess) and the cash left per head, with reverse-charge tax, interest,
 * late fee (from the GSTR-3B entries), penalty and others (entered here) paid in cash.
 * Composition taxpayers (CMP-08): everything is paid in cash (no credit).
 *
 * Posting — one Journal (ledger mode, through the vouchers service, so it is numbered, audited and
 * period-lock aware), tagged gstDetails.setoff so the electronic ledgers can read it:
 *   Dr Output IGST/CGST/SGST/Cess        forward-charge liability discharged (3.1(a)+(b), incl. advances)
 *   Dr Input <head>                      where reversals exceeded credit (negative 4(C)) — paid in cash
 *   Cr Input <head>                      credit utilised from that head
 *   Dr IGST/CGST/SGST/Cess Payable (RC)  reverse-charge tax
 *   Dr Interest on GST / Late Fee on GST Returns / GST Penalty and Other Dues
 *   Dr Composition Tax (GST)             composition tax (CMP-08)
 *   Cr GST Electronic Cash Ledger        total cash utilised (by major × minor head in gst_stat_lines)
 * Challan — one Payment voucher: Dr GST Electronic Cash Ledger / Cr Bank, tagged gstDetails.challan
 * (CPIN, CIN, BRN, date, bank, head-wise amounts).
 */
import type { Paise } from '../../../shared/money.ts';
import type {
  CashHeadAmount,
  CashMinorHead,
  GstChallanInput,
  GstChallanRow,
  GstSetoffResult,
  SetoffCashRow,
  SetoffCreditRow,
} from '../../../shared/types/gst-plus.ts';
import { CASH_MINOR_HEADS } from '../../../shared/types/gst-plus.ts';
import type { ReturnPeriodRef, TaxAmounts, TaxHead } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import type { LedgerLineInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { formatDate } from '../../../shared/dates.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { conflict, rule, validation } from '../../lib/errors.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { computeCmp08, readCmp08Interest } from './composition.ts';
import { zeroTax, type GstCompany } from './docs.ts';
import { computeGstr3b } from './gstr3b.ts';
import { dutyLedgers, ensureStatLedger } from './statLedgers.ts';

const HEAD_LABELS: Readonly<Record<TaxHead, string>> = { igst: 'Integrated tax', cgst: 'Central tax', sgst: 'State/UT tax', cess: 'Cess' };

export interface SetoffExtras {
  penalty?: Partial<TaxAmounts>;
  others?: Partial<TaxAmounts>;
}

interface SetoffPlan {
  result: GstSetoffResult;
  /** Forward-charge output tax discharged per head (Dr Output). */
  outputPart: TaxAmounts;
  /** Negative 4(C) paid in cash (Dr Input). */
  excessReversal: TaxAmounts;
  /** Credit utilised per credit head (Cr Input). */
  itcUsed: TaxAmounts;
  compositionTax: Paise;
}

const take = (t: Partial<TaxAmounts> | undefined, h: TaxHead): Paise => Math.max(0, t?.[h] ?? 0);

/** Electronic cash ledger balance per major head as of a date (deposits − utilisation, books filter). */
export function cashBalances(db: Db, asOf: string, today: string, excludeVoucherId?: number): TaxAmounts {
  const out = zeroTax();
  for (const r of db.all<{ head: TaxHead; nature: string; amount: number }>(
    `SELECT head, nature, SUM(amount) AS amount FROM gst_stat_lines s
      WHERE s.nature IN ('cash_deposit', 'cash_utilised') AND s.date <= :asOf AND s.voucher_id <> :ex AND ${BOOKS_FILTER('s')}
      GROUP BY head, nature`,
    { asOf, today, ex: excludeVoucherId ?? 0 },
  )) {
    out[r.head] += r.nature === 'cash_deposit' ? r.amount : -r.amount;
  }
  return out;
}

function postedFor(db: Db, periodKey: string, today: string): GstSetoffResult['posted'] {
  const r = db.get<{ id: number; number: string | null; date: string }>(
    `SELECT v.id, v.number, v.date FROM gst_stat_lines s JOIN vouchers v ON v.id = s.voucher_id
      WHERE s.return_period = :p AND s.nature IN ('cash_utilised', 'itc_utilised') AND ${BOOKS_FILTER('s')}
      ORDER BY v.date, v.id LIMIT 1`,
    { p: periodKey, today },
  );
  return r ? { voucherId: r.id, number: r.number, date: r.date } : null;
}

export function listChallans(db: Db, opts: { from?: string; to?: string; period?: string }, today: string): GstChallanRow[] {
  const where: string[] = [BOOKS_FILTER('c')];
  const params: Record<string, string> = { today };
  if (opts.period) {
    where.push('c.return_period = :p');
    params.p = opts.period;
  }
  if (opts.from) {
    where.push('c.date >= :from');
    params.from = opts.from;
  }
  if (opts.to) {
    where.push('c.date <= :to');
    params.to = opts.to;
  }
  const rows = db.all<{
    voucher_id: number;
    number: string | null;
    date: string;
    cpin: string;
    cin: string | null;
    brn: string | null;
    challan_date: string | null;
    bank_name: string | null;
    mode: string | null;
    return_period: string | null;
  }>(
    `SELECT c.voucher_id, v.number, c.date, c.cpin, c.cin, c.brn, c.challan_date, c.bank_name, c.mode, c.return_period
       FROM gst_challans c JOIN vouchers v ON v.id = c.voucher_id
      WHERE ${where.join(' AND ')} ORDER BY c.date, c.voucher_id`,
    params,
  );
  if (rows.length === 0) return [];
  const heads = new Map<number, CashHeadAmount[]>();
  for (const h of db.all<{ voucher_id: number; head: TaxHead; minor: CashMinorHead; amount: number }>(
    `SELECT voucher_id, head, minor, amount FROM gst_stat_lines WHERE nature = 'cash_deposit' AND voucher_id IN (SELECT value FROM json_each(:ids)) ORDER BY id`,
    { ids: JSON.stringify(rows.map((r) => r.voucher_id)) },
  )) {
    const list = heads.get(h.voucher_id) ?? [];
    list.push({ head: h.head, minor: h.minor, amount: h.amount });
    heads.set(h.voucher_id, list);
  }
  return rows.map((r) => {
    const hs = heads.get(r.voucher_id) ?? [];
    return {
      voucherId: r.voucher_id,
      number: r.number,
      date: r.date,
      cpin: r.cpin,
      cin: r.cin,
      brn: r.brn,
      challanDate: r.challan_date,
      bankName: r.bank_name,
      mode: r.mode,
      period: r.return_period,
      total: hs.reduce((s, x) => s + x.amount, 0),
      heads: hs,
    };
  });
}

function plan(db: Db, company: GstCompany, period: ReturnPeriodRef & { key: string }, today: string, extras: SetoffExtras): SetoffPlan {
  const composition = company.registration === 'composition';
  const notes: string[] = [];
  const liability = zeroTax();
  const rcm = zeroTax();
  const creditAvailable = zeroTax();
  const creditBalance = zeroTax();
  const credit: SetoffCreditRow[] = [];
  const interest = zeroTax();
  const fee = zeroTax();
  const outputPart = zeroTax();
  const excessReversal = zeroTax();
  const itcUsed = zeroTax();
  const cashTax = zeroTax();
  let compositionTax = 0;
  if (composition) {
    const c = computeCmp08(db, company, period.key, today);
    const [out, rc] = c.table3;
    for (const h of TAX_HEADS) {
      liability[h] = Math.max(0, out[h]);
      rcm[h] = Math.max(0, rc[h]);
      cashTax[h] = liability[h] + rcm[h];
      compositionTax += liability[h];
    }
    Object.assign(interest, readCmp08Interest(db, period.key));
    notes.push('Composition taxpayers pay CMP-08 tax and reverse-charge tax in cash; no input tax credit is used.');
  } else {
    const s = computeGstr3b(db, company, period, today);
    const out = zeroTax();
    for (const r of s.supplies) if (r.key === 'osup_det' || r.key === 'osup_zero') for (const h of TAX_HEADS) out[h] += r[h];
    for (const row of s.payment.rows) {
      const h = row.head;
      liability[h] = row.liability;
      rcm[h] = row.rcmLiability;
      outputPart[h] = Math.max(0, out[h]);
      excessReversal[h] = Math.max(0, -s.itc.net[h]);
      cashTax[h] = row.cash + row.rcmLiability;
      interest[h] = row.interest;
      fee[h] = row.lateFee;
    }
    Object.assign(creditAvailable, s.payment.creditAvailable);
    Object.assign(creditBalance, s.payment.setOff.creditBalance);
    for (const from of TAX_HEADS) {
      for (const to of TAX_HEADS) {
        const a = s.payment.setOff.utilisation[from][to];
        if (a > 0) {
          credit.push({ from, to, amount: a });
          itcUsed[from] += a;
        }
      }
    }
    // Liability and its discharge must agree (setOff: payable = paid by credit + cash).
    for (const h of TAX_HEADS) {
      const paidByItc = s.payment.setOff.paidByItc[h];
      if (outputPart[h] + excessReversal[h] !== paidByItc + s.payment.setOff.cash[h]) {
        notes.push(`${HEAD_LABELS[h]}: tax on outward supplies is negative this period (credit notes exceed supplies); nothing is paid for it.`);
        outputPart[h] = Math.max(0, paidByItc + s.payment.setOff.cash[h] - excessReversal[h]);
      }
    }
    if (TAX_HEADS.some((h) => s.payment.broughtForward[h] !== 0)) notes.push('Credit brought forward from the previous period (per the books) is included in the credit available.');
  }
  const available = cashBalances(db, today, today);
  const cash: SetoffCashRow[] = TAX_HEADS.map((h) => {
    const penalty = take(extras.penalty, h);
    const others = take(extras.others, h);
    const total = cashTax[h] + interest[h] + fee[h] + penalty + others;
    return {
      head: h,
      label: HEAD_LABELS[h],
      tax: cashTax[h],
      interest: interest[h],
      penalty,
      fee: fee[h],
      others,
      total,
      available: available[h],
      toDeposit: Math.max(0, total - Math.max(0, available[h])),
    };
  });
  const result: GstSetoffResult = {
    period,
    form: composition ? 'cmp08' : 'gstr3b',
    composition,
    liability,
    rcm,
    creditAvailable,
    credit,
    creditBalance,
    cash,
    cashTotal: cash.reduce((s, r) => s + r.total, 0),
    toDepositTotal: cash.reduce((s, r) => s + r.toDeposit, 0),
    posted: postedFor(db, period.key, today),
    challans: listChallans(db, { period: period.key }, today),
    notes,
  };
  return { result, outputPart, excessReversal, itcUsed, compositionTax };
}

export function computeSetoff(db: Db, company: GstCompany, period: ReturnPeriodRef & { key: string }, today: string, extras: SetoffExtras = {}): GstSetoffResult {
  return plan(db, company, period, today, extras).result;
}

function journalTypeId(db: Db, base: 'journal' | 'payment'): number {
  const id = db.value<number>(`SELECT id FROM voucher_types WHERE base_type = :b AND is_active = 1 ORDER BY is_predefined DESC, id LIMIT 1`, { b: base });
  if (id === undefined) throw rule(`No active ${base === 'journal' ? 'Journal' : 'Payment'} voucher type. Activate one under Masters › Voucher Types.`);
  return id;
}

export function postSetoff(
  ctx: CompanyCtx,
  company: GstCompany,
  period: ReturnPeriodRef & { key: string },
  input: SetoffExtras & { date: string; narration?: string },
): VoucherSaveResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  if (input.date < period.to) {
    throw validation([{ path: 'date', message: `Set-off is made when the return is filed, after the period ends: date it on or after ${formatDate(period.to)}.` }]);
  }
  const p = plan(db, company, period, today, input);
  const r = p.result;
  if (r.posted) {
    throw conflict(
      `The set-off for ${period.label} is already posted (Journal ${r.posted.number ?? ''} dated ${formatDate(r.posted.date)}). Alter or delete that journal to post it again.`,
    );
  }
  const ts = ctx.clock.now().toISOString();
  const ecl = ensureStatLedger(db, 'GST_CASH_LEDGER', ts);
  const duty = dutyLedgers(db);
  const lines: LedgerLineInput[] = [];
  const add = (ledgerId: number | undefined, amount: Paise, what: string): void => {
    if (amount === 0) return;
    if (ledgerId === undefined) throw rule(`The ${what} ledger is missing. Turn GST on again under F11 to recreate the GST ledgers.`);
    lines.push({ ledgerId, amount });
  };
  if (r.composition) {
    add(ensureStatLedger(db, 'COMPOSITION_TAX', ts), p.compositionTax, 'Composition Tax');
  } else {
    for (const h of TAX_HEADS) add(duty.output[h], p.outputPart[h], `Output ${h.toUpperCase()}`);
    for (const h of TAX_HEADS) add(duty.input[h], p.excessReversal[h], `Input ${h.toUpperCase()}`);
    for (const h of TAX_HEADS) add(duty.input[h], -p.itcUsed[h], `Input ${h.toUpperCase()}`);
  }
  for (const h of TAX_HEADS) add(duty.rcm[h], r.rcm[h], `${h.toUpperCase()} Payable (Reverse Charge)`);
  const sumMinor = (k: 'interest' | 'fee' | 'penalty' | 'others'): Paise => r.cash.reduce((s, c) => s + c[k], 0);
  if (sumMinor('interest') > 0) add(ensureStatLedger(db, 'GST_INTEREST', ts), sumMinor('interest'), 'Interest on GST');
  if (sumMinor('fee') > 0) add(ensureStatLedger(db, 'GST_LATE_FEE', ts), sumMinor('fee'), 'Late Fee');
  if (sumMinor('penalty') + sumMinor('others') > 0) add(ensureStatLedger(db, 'GST_PENALTY', ts), sumMinor('penalty') + sumMinor('others'), 'GST Penalty');
  const cashRows: CashHeadAmount[] = [];
  for (const c of r.cash) for (const m of CASH_MINOR_HEADS) if (c[m] > 0) cashRows.push({ head: c.head, minor: m, amount: c[m] });
  add(ecl, -r.cashTotal, 'GST Electronic Cash Ledger');
  if (lines.length === 0) throw rule(`Nothing to set off for ${period.label}: there is no tax payable.`);
  return saveVoucher(ctx, {
    voucherTypeId: journalTypeId(db, 'journal'),
    date: input.date,
    mode: 'ledger',
    narration: input.narration?.trim() || `GST set-off for ${period.label} (${r.composition ? 'CMP-08' : 'GSTR-3B'})`,
    ledgers: lines,
    gstDetails: { setoff: { period: period.key, cash: cashRows, credit: r.credit } },
    acknowledgeWarnings: true,
  });
}

export interface ChallanPostInput extends Omit<GstChallanInput, 'heads'> {
  date: string;
  bankLedgerId: number;
  heads: CashHeadAmount[];
  narration?: string;
}

export function postChallan(ctx: CompanyCtx, input: ChallanPostInput): VoucherSaveResult {
  const { db } = ctx;
  const heads = input.heads.filter((h) => h.amount > 0);
  const total = heads.reduce((s, h) => s + h.amount, 0);
  if (total <= 0) throw validation([{ path: 'heads', message: 'Enter the amount paid against at least one head.' }]);
  const seen = new Set<string>();
  for (const h of heads) {
    const k = `${h.head}|${h.minor}`;
    if (seen.has(k)) throw validation([{ path: 'heads', message: `${HEAD_LABELS[h.head]} — ${h.minor} appears twice. Enter each head once.` }]);
    seen.add(k);
  }
  const bank = db.get<{ code: string | null }>(
    `SELECT g.reserved_code AS code FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = :id`,
    { id: input.bankLedgerId },
  );
  if (!bank) throw validation([{ path: 'bankLedgerId', message: 'Select the bank (or cash) ledger the challan was paid from.' }]);
  const ecl = ensureStatLedger(db, 'GST_CASH_LEDGER', ctx.clock.now().toISOString());
  return saveVoucher(ctx, {
    voucherTypeId: journalTypeId(db, 'payment'),
    date: input.date,
    mode: 'ledger',
    narration: input.narration?.trim() || `GST challan CPIN ${input.cpin.trim()}${input.period ? ` for ${input.period}` : ''}`,
    ledgers: [
      { ledgerId: ecl, amount: total },
      { ledgerId: input.bankLedgerId, amount: -total },
    ],
    gstDetails: {
      challan: {
        cpin: input.cpin,
        cin: input.cin,
        brn: input.brn,
        challanDate: input.challanDate,
        bankName: input.bankName,
        mode: input.mode,
        period: input.period,
        heads,
      },
    },
    acknowledgeWarnings: true,
  });
}

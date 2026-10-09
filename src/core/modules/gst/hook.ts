/**
 * The gst module's voucher hook (vouchers/hooks.ts): posts and derives the GST details a voucher
 * carries in `VoucherInput.gstDetails`, and keeps filed GSTR-1 periods intact.
 *
 *   Receipt  + advance          Dr GST on Advances Received / Cr Output tax          → gst_advance_lines 'received'
 *   Sales / outward debit note  Dr Output tax / Cr GST on Advances (advance adjusted) → 'adjusted'
 *     (explicit `advanceAdjustments`, else every bill-wise "against" allocation on an advance bill
 *      created by a receipt with GST)
 *   Payment  + advanceRefund    Dr Output tax / Cr GST on Advances (refund voucher)   → 'refunded'
 *   Purchase + billOfEntry      Dr Input IGST (+Cess) / Cr IGST Payable on Imports    → gst_bill_of_entry
 *                               (composition company: the IGST is a cost — Dr the purchase ledger)
 *   Journal  + adjustment       lines as entered (Cr Input = reversal, Dr Input = reclaim,
 *                               Cr RCM payable [+ Dr Input] = reverse-charge liability) → gst_stat_lines
 *   Payment  + challan          lines as entered (Dr GST Electronic Cash Ledger / Cr Bank) → gst_challans + gst_stat_lines 'cash_deposit'
 *   Journal  + setoff           lines as built by GST Set-off                          → gst_stat_lines 'cash_utilised' / 'itc_utilised'
 *
 * Every derived row carries the voucher date / affects_books / is_post_dated and is rebuilt on every
 * save (clear + write in the voucher's transaction). Amendments: an outward document of a GSTR-1 period
 * marked filed is logged when altered (filings.ts) and cannot be deleted or cancelled (beforeRemove).
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { CashHeadAmount, GstAdjustmentNature, GstDocSnapshot, VoucherGstDetailsInput } from '../../../shared/types/gst-plus.ts';
import { GST_ADJUSTMENT_LABELS } from '../../../shared/types/gst-plus.ts';
import type { TaxHead } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { rule } from '../../lib/errors.ts';
import type { PostingAdjustContext, VoucherHook, VoucherHookWriteContext } from '../vouchers/hooks.ts';
import type { PostingEnv } from '../vouchers/posting.ts';
import type { VoucherRow } from '../vouchers/service.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { advanceReceiptForBill, advanceTax, receivedAdvance, shareOfAdvance, type AdvanceTax } from './advances.ts';
import { loadCompany } from './docs.ts';
import { amendmentPeriod, docSnapshot, filedGstr1Period, periodLabel, recordAmendment } from './filings.ts';
import { monthPeriodKey, parsePeriodKey, quarterPeriodKey } from './period.ts';
import { dutyLedgers, ensureStatLedger, statLedgerId } from './statLedgers.ts';

// ───────────────────────────── Stashed data (adjust → write) ─────────────────────────────

interface AdvanceRow extends AdvanceTax {
  kind: 'received' | 'adjusted' | 'refunded';
  receiptVoucherId: number | null;
  partyLedgerId: number | null;
  pos: string;
  supplyType: string;
  rate: number;
  cessRate: number;
}

interface StatRow {
  nature: string;
  period: string | null;
  head: TaxHead;
  minor: string | null;
  amount: Paise;
  taxableValue: Paise;
}

interface HookData {
  advances: AdvanceRow[];
  boe: { no: string; date: string; port: string | null; assessable: Paise; duty: Paise; igst: Paise; cess: Paise; itc: boolean } | null;
  stat: StatRow[];
  challan: { cpin: string; cin: string | null; brn: string | null; challanDate: string | null; bankName: string | null; mode: string | null; period: string | null } | null;
  amendment: { today: string; originalDate: string | null; original: GstDocSnapshot | null; originalFiled: string | null } | null;
}

const emptyData = (): HookData => ({ advances: [], boe: null, stat: [], challan: null, amendment: null });

const money = (p: Paise): string => formatMoney(p, { symbol: true });
const OUTWARD_BASES = new Set(['sales', 'credit_note', 'debit_note']);
const NOT_REPORTED = new Set(['composition_outward', 'no_gst']);
/** A stored nature that GSTR-1 reports (outward, not composition / non-GST). */
const reportedNature = (n: string | null): boolean => n !== null && !NOT_REPORTED.has(n) && !n.startsWith('inward') && !n.startsWith('import');

function headOf(dutyHead: string | null): TaxHead | null {
  const h = dutyHead?.toLowerCase();
  return h === 'igst' || h === 'cgst' || h === 'sgst' || h === 'cess' ? h : null;
}

function returnPeriodOf(ctx: PostingAdjustContext, date: string): string {
  return ctx.env.config.gst.filingFrequency === 'quarterly' ? quarterPeriodKey(date) : monthPeriodKey(date);
}

// ───────────────────────────── adjust ─────────────────────────────

function adjust(ctx: PostingAdjustContext): void {
  const g: VoucherGstDetailsInput | undefined = ctx.input.gstDetails;
  const { env } = ctx;
  const gstOn = env.features.gst && env.company.gstRegistrationType !== 'unregistered';
  const data = emptyData();
  let used = false;
  const block = (message: string, path = 'gstDetails'): void => ctx.warn('gst_stat', message, 'block', path);

  if (g && Object.keys(g).length > 0) {
    if (!gstOn) {
      block('GST details were entered but this company does not charge GST (GST is off or the company is unregistered). Remove them.');
    } else {
      used = true;
      const base = ctx.baseType;
      if (g.advance) base === 'receipt' ? advanceReceived(ctx, g.advance, data) : block('Advance details go on a Receipt voucher (the money received before the supply).', 'gstDetails.advance');
      if (g.advanceRefund) base === 'payment' ? advanceUse(ctx, [g.advanceRefund], 'refunded', true, data) : block('A refund of an advance is entered as a Payment voucher.', 'gstDetails.advanceRefund');
      if (g.advanceAdjustments && g.advanceAdjustments.length > 0) {
        if (OUTWARD_BASES.has(base) && ctx.outward && ctx.mode !== 'ledger') advanceUse(ctx, g.advanceAdjustments, 'adjusted', true, data);
        else block('Advances are adjusted on the sales invoice (or a debit note to the customer) that bills the supply.', 'gstDetails.advanceAdjustments');
      }
      if (g.billOfEntry) base === 'purchase' ? billOfEntry(ctx, g.billOfEntry, data) : block('A bill of entry goes on the Purchase voucher of the imported goods.', 'gstDetails.billOfEntry');
      if (g.adjustment) base === 'journal' ? statAdjustment(ctx, g.adjustment, data) : block('A GST stat adjustment is entered as a Journal voucher (Alt+J).', 'gstDetails.adjustment');
      if (g.challan) base === 'payment' ? challan(ctx, g.challan, data) : block('A GST challan is entered as a Payment voucher.', 'gstDetails.challan');
      if (g.setoff) base === 'journal' ? setoff(ctx, g.setoff, data) : block('A GST set-off is a Journal voucher.', 'gstDetails.setoff');
    }
  }
  // Bill-wise adjustment of advances on an invoice, when not given explicitly.
  if (gstOn && !g?.advanceAdjustments && OUTWARD_BASES.has(ctx.baseType) && ctx.outward && ctx.mode !== 'ledger' && ctx.party) {
    const refs: Array<{ receiptVoucherId: number; amount: Paise }> = [];
    for (const b of ctx.input.partyBillAllocations ?? []) {
      if (b.refType !== 'against' || !b.billName || b.amount <= 0) continue;
      const receipt = advanceReceiptForBill(env.db, ctx.party.id, b.billName.trim(), env.today);
      if (receipt !== null) refs.push({ receiptVoucherId: receipt, amount: b.amount });
    }
    if (refs.length > 0) {
      used = true;
      advanceUse(ctx, refs, 'adjusted', false, data);
    }
  }
  if (gstOn && OUTWARD_BASES.has(ctx.baseType) && ctx.outward && env.company.gstRegistrationType === 'regular') {
    if (amendmentCheck(ctx, data)) used = true;
  }
  if (used) ctx.setData(data);
}

function companyState(ctx: PostingAdjustContext): string {
  return ctx.env.company.stateCode ?? '';
}

function advanceReceived(ctx: PostingAdjustContext, a: NonNullable<VoucherGstDetailsInput['advance']>, data: HookData): void {
  const { env } = ctx;
  if (env.company.gstRegistrationType === 'composition') {
    ctx.warn('gst_stat', 'Composition taxpayers do not report advances in GSTR-1 Table 11: their tax is paid on turnover through CMP-08. Remove the advance details.', 'block', 'gstDetails.advance');
    return;
  }
  const party =
    ctx.party ??
    ctx.entries.map((e) => ctx.masters.ledger(e.ledgerId)).find((l, i) => ctx.entries[i].amount < 0 && (l.isDebtor || l.isCreditor)) ??
    null;
  const gross = a.amount ?? ctx.entries.filter((e) => e.amount > 0 && ctx.masters.ledger(e.ledgerId).isCashBank).reduce((s, e) => s + e.amount, 0);
  if (gross <= 0) {
    ctx.warn('gst_stat', 'Enter the amount received from the customer (debit Cash or Bank) before marking it as an advance.', 'block', 'gstDetails.advance');
    return;
  }
  if (a.supplyType === 'goods') {
    ctx.warn(
      'gst_stat',
      'No GST is payable on advances received for goods (Notification 66/2017-Central Tax): tax is paid when the invoice is issued. The receipt is recorded without tax.',
      'info',
      'gstDetails.advance',
    );
    return;
  }
  const pos = a.placeOfSupply || party?.row.state_code || companyState(ctx);
  const tax = advanceTax(gross, a.rate, a.cessRate ?? 0, pos !== companyState(ctx));
  if (a.rate <= 0) ctx.warn('gst_stat', 'The GST rate of the advance is 0%: no tax is payable on it.', 'info', 'gstDetails.advance.rate');
  const row: AdvanceRow = {
    kind: 'received',
    receiptVoucherId: null,
    partyLedgerId: party?.id ?? null,
    pos,
    supplyType: a.supplyType,
    rate: a.rate,
    cessRate: a.cessRate ?? 0,
    ...tax,
  };
  data.advances.push(row);
  postAdvanceTax(ctx, tax, +1);
}

/** sign +1: tax on an advance received (Dr GST on Advances / Cr Output); −1: reversed on adjustment / refund. */
function postAdvanceTax(ctx: PostingAdjustContext, tax: AdvanceTax, sign: 1 | -1): void {
  const total = tax.igst + tax.cgst + tax.sgst + tax.cess;
  if (total === 0) return;
  const adv = statLedgerId(ctx.env.db, 'GST_ADVANCE');
  const out = dutyLedgers(ctx.env.db).output;
  if (adv === undefined || TAX_HEADS.some((h) => tax[h] !== 0 && out[h] === undefined)) {
    ctx.warn('gst_stat', `GST on the advance (${money(total)}) will be posted to "GST on Advances Received" and the Output tax ledgers when you save.`, 'info', 'gstDetails');
    return;
  }
  ctx.addEntry({ ledgerId: adv, amount: sign * total, role: 'tax', narration: sign > 0 ? 'GST on advance received' : 'GST on advance adjusted' });
  for (const h of TAX_HEADS) if (tax[h] !== 0) ctx.addEntry({ ledgerId: out[h] as number, amount: -sign * tax[h], role: 'tax' });
}

function advanceUse(
  ctx: PostingAdjustContext,
  refs: ReadonlyArray<{ receiptVoucherId: number; amount: Paise }>,
  kind: 'adjusted' | 'refunded',
  explicit: boolean,
  data: HookData,
): void {
  const { env } = ctx;
  const path = kind === 'refunded' ? 'gstDetails.advanceRefund' : 'gstDetails.advanceAdjustments';
  const seen = new Map<number, ReturnType<typeof receivedAdvance>>();
  refs.forEach((ref, i) => {
    let adv = seen.get(ref.receiptVoucherId);
    if (adv === undefined) {
      adv = receivedAdvance(env.db, ref.receiptVoucherId, env.today, ctx.voucherId);
      seen.set(ref.receiptVoucherId, adv);
    }
    const p = kind === 'refunded' ? path : `${path}[${i}]`;
    if (!adv) {
      if (explicit) ctx.warn('gst_stat', 'The selected receipt has no advance with GST in the books (it may be optional, cancelled or not marked as an advance).', 'block', p);
      return;
    }
    if (ctx.party && adv.partyLedgerId !== null && adv.partyLedgerId !== ctx.party.id) {
      ctx.warn('gst_stat', 'The advance was received from another party. Check that you selected the right receipt.', 'confirm', p);
    }
    const left = adv.gross - adv.used.gross;
    if (left <= 0) {
      if (explicit) ctx.warn('gst_stat', 'This advance has already been fully adjusted or refunded.', 'block', p);
      return;
    }
    if (ref.amount > left && explicit) {
      ctx.warn('gst_stat', `Only ${money(left)} of this advance is still to be adjusted; you entered ${money(ref.amount)}.`, 'block', p);
      return;
    }
    const share = shareOfAdvance(adv, Math.min(ref.amount, left));
    adv.used.gross += share.gross;
    adv.used.taxable += share.taxable;
    for (const h of TAX_HEADS) adv.used[h] += share[h];
    data.advances.push({
      kind,
      receiptVoucherId: adv.receiptVoucherId,
      partyLedgerId: adv.partyLedgerId,
      pos: adv.pos,
      supplyType: adv.supplyType,
      rate: adv.rate,
      cessRate: adv.cessRate,
      ...share,
    });
    postAdvanceTax(ctx, share, -1);
  });
}

function billOfEntry(ctx: PostingAdjustContext, b: NonNullable<VoucherGstDetailsInput['billOfEntry']>, data: HookData): void {
  const { env } = ctx;
  const reg = ctx.party?.row.gst_registration_type ?? null;
  if (reg !== 'overseas' && reg !== 'sez') {
    ctx.warn(
      'gst_stat',
      'A bill of entry is for imports of goods: the supplier must be overseas (registration "Overseas") or an SEZ unit. For a domestic purchase remove it.',
      'block',
      'gstDetails.billOfEntry',
    );
    return;
  }
  if (b.portCode && !/^[A-Z0-9]{6}$/i.test(b.portCode.trim())) {
    ctx.warn('gst_stat', `Port code "${b.portCode}" should be the six-character customs code (e.g. INNSA1).`, 'confirm', 'gstDetails.billOfEntry.portCode');
  }
  if (b.date > ctx.date) {
    ctx.warn('gst_stat', `The bill of entry is dated ${formatDate(b.date)}, after the purchase (${formatDate(ctx.date)}). ITC is reported in the purchase's return period.`, 'info', 'gstDetails.billOfEntry.date');
  }
  const cess = b.cess ?? 0;
  const computed = ctx.invoiceLines.reduce((s, l) => s + l.tax, 0);
  if (computed !== b.igst + cess) {
    ctx.warn(
      'gst_stat',
      `IGST + cess on the bill of entry (${money(b.igst + cess)}) differs from the tax worked out on the invoice value (${money(computed)}) — usual, as customs adds duty to the value. GSTR-3B 4(A)(1) uses the bill of entry.`,
      'info',
      'gstDetails.billOfEntry.igst',
    );
  }
  const itc = env.company.gstRegistrationType === 'regular';
  data.boe = { no: b.number.trim(), date: b.date, port: b.portCode?.trim().toUpperCase() || null, assessable: b.assessableValue, duty: b.customsDuty ?? 0, igst: b.igst, cess, itc };
  const total = b.igst + cess;
  if (total === 0) return;
  let credit = b.creditLedgerId ?? statLedgerId(env.db, 'CUSTOMS_IGST');
  if (b.creditLedgerId !== undefined) {
    const l = ctx.masters.ledgerOrNull(b.creditLedgerId);
    if (!l) {
      ctx.warn('gst_stat', 'The ledger for the IGST paid at customs no longer exists. Select it again.', 'block', 'gstDetails.billOfEntry.creditLedgerId');
      return;
    }
    if (l.isGstDuty || l.id === ctx.party?.id) {
      ctx.warn('gst_stat', 'Credit the IGST paid at customs to the customs / clearing agent or duty payable ledger — not to a GST tax ledger or the supplier.', 'block', 'gstDetails.billOfEntry.creditLedgerId');
      return;
    }
    credit = l.id;
  }
  const input = dutyLedgers(env.db).input;
  if (credit === undefined) {
    ctx.warn('gst_stat', `IGST on the bill of entry (${money(total)}) will be posted when you save.`, 'info', 'gstDetails.billOfEntry');
    return;
  }
  if (itc) {
    if (b.igst > 0 && input.igst !== undefined) ctx.addEntry({ ledgerId: input.igst, amount: b.igst, role: 'tax', narration: `IGST on bill of entry ${b.number}` });
    if (cess > 0 && input.cess !== undefined) ctx.addEntry({ ledgerId: input.cess, amount: cess, role: 'tax', narration: `Cess on bill of entry ${b.number}` });
  } else {
    // Composition taxpayers cannot take credit: the IGST paid is part of the cost of the goods.
    const purchase = ctx.entries.find((e) => e.role === 'purchase');
    if (!purchase) {
      ctx.warn('gst_stat', 'No purchase ledger on this voucher to carry the IGST paid at customs as cost.', 'block', 'gstDetails.billOfEntry');
      return;
    }
    ctx.addEntry({ ledgerId: purchase.ledgerId, amount: total, role: 'purchase', narration: `IGST on bill of entry ${b.number} (no credit: composition)` });
  }
  ctx.addEntry({ ledgerId: credit, amount: -total, role: 'other', narration: `IGST paid at customs, bill of entry ${b.number}` });
}

interface HeadSums {
  input: Record<TaxHead, Paise>;
  output: Record<TaxHead, Paise>;
  rcm: Record<TaxHead, Paise>;
}

function headSums(ctx: PostingAdjustContext): HeadSums {
  const z = (): Record<TaxHead, Paise> => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const out: HeadSums = { input: z(), output: z(), rcm: z() };
  for (const e of ctx.entries) {
    const l = ctx.masters.ledger(e.ledgerId);
    if (!l.isGstDuty) continue;
    const h = headOf(l.row.gst_duty_head ?? l.gstDutyHead);
    if (!h) continue;
    const dir = l.row.gst_tax_direction;
    if (dir === 'input') out.input[h] += e.amount;
    else if (dir === 'output') out.output[h] += e.amount;
    else if (dir === 'rcm_liability') out.rcm[h] += e.amount;
  }
  return out;
}

const REVERSALS = new Set<GstAdjustmentNature>([
  'itc_reversal_r42',
  'itc_reversal_r43',
  'itc_reversal_r38',
  'itc_reversal_s17_5',
  'itc_reversal_r37',
  'itc_reversal_r37a',
  'itc_reversal_others',
]);

function statAdjustment(ctx: PostingAdjustContext, a: NonNullable<VoucherGstDetailsInput['adjustment']>, data: HookData): void {
  const path = 'gstDetails.adjustment';
  const s = headSums(ctx);
  const label = GST_ADJUSTMENT_LABELS[a.nature];
  const composition = ctx.env.company.gstRegistrationType === 'composition';
  const period = a.period ?? returnPeriodOf(ctx, ctx.date);
  const ref = parsePeriodKey(period);
  if (ref && (ctx.date < ref.from || ctx.date > ref.to)) {
    ctx.warn('gst_stat', `The journal is dated ${formatDate(ctx.date)}, outside ${ref.label}: GSTR-3B reports it in the period of its date.`, 'confirm', `${path}.period`);
  }
  const anyOutput = TAX_HEADS.some((h) => s.output[h] !== 0);
  if (anyOutput) {
    ctx.warn('gst_stat', `${label}: Output tax ledgers do not belong in this adjustment. Use the Input tax (or reverse-charge payable) ledgers.`, 'block', path);
    return;
  }
  const push = (nature: string, amounts: Record<TaxHead, Paise>, taxable = 0): void => {
    let first = true;
    for (const h of TAX_HEADS) {
      if (amounts[h] === 0) continue;
      data.stat.push({ nature, period, head: h, minor: null, amount: amounts[h], taxableValue: first ? taxable : 0 });
      first = false;
    }
  };
  if (REVERSALS.has(a.nature) || a.nature === 'itc_reclaim') {
    if (composition) {
      ctx.warn('gst_stat', 'Composition taxpayers take no input tax credit, so there is nothing to reverse or reclaim.', 'block', path);
      return;
    }
    if (TAX_HEADS.some((h) => s.rcm[h] !== 0)) {
      ctx.warn('gst_stat', `${label}: use only Input tax ledgers (not the reverse-charge payable ledgers).`, 'block', path);
      return;
    }
    const reclaim = a.nature === 'itc_reclaim';
    const amounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 } as Record<TaxHead, Paise>;
    for (const h of TAX_HEADS) amounts[h] = reclaim ? s.input[h] : -s.input[h];
    if (TAX_HEADS.some((h) => amounts[h] < 0) || TAX_HEADS.every((h) => amounts[h] === 0)) {
      ctx.warn(
        'gst_stat',
        reclaim
          ? `${label}: debit the Input tax ledgers with the credit reclaimed (and credit the expense / supplier ledger).`
          : `${label}: credit the Input tax ledgers with the credit reversed (and debit "ITC Reversed (GST)" or the expense ledger).`,
        'block',
        path,
      );
      return;
    }
    push(a.nature, amounts);
    return;
  }
  // Reverse-charge liability.
  const liability = { igst: 0, cgst: 0, sgst: 0, cess: 0 } as Record<TaxHead, Paise>;
  const credit = { igst: 0, cgst: 0, sgst: 0, cess: 0 } as Record<TaxHead, Paise>;
  for (const h of TAX_HEADS) {
    liability[h] = -s.rcm[h];
    credit[h] = s.input[h];
  }
  if (TAX_HEADS.some((h) => liability[h] < 0 || credit[h] < 0) || TAX_HEADS.every((h) => liability[h] === 0)) {
    ctx.warn('gst_stat', `${label}: credit the "… Payable (Reverse Charge)" ledgers with the tax, and debit the Input tax ledgers with the credit you may take.`, 'block', path);
    return;
  }
  if (composition && TAX_HEADS.some((h) => credit[h] !== 0)) {
    ctx.warn('gst_stat', 'Composition taxpayers pay reverse-charge tax but take no credit for it: debit an expense ledger instead of the Input tax ledgers.', 'block', path);
    return;
  }
  if (!a.taxableValue) {
    ctx.warn('gst_stat', 'Enter the taxable value of the supply under reverse charge (GSTR-3B 3.1(d) reports it).', 'confirm', `${path}.taxableValue`);
  }
  push('rcm_liability', liability, a.taxableValue ?? 0);
  push('rcm_credit', credit);
}

function sumOnLedger(ctx: PostingAdjustContext, ledgerId: number | undefined): Paise {
  if (ledgerId === undefined) return 0;
  return ctx.entries.filter((e) => e.ledgerId === ledgerId).reduce((s, e) => s + e.amount, 0);
}

function cashRows(rows: readonly CashHeadAmount[]): CashHeadAmount[] {
  return rows.filter((r) => r.amount > 0);
}

function challan(ctx: PostingAdjustContext, c: NonNullable<VoucherGstDetailsInput['challan']>, data: HookData): void {
  const path = 'gstDetails.challan';
  const ecl = statLedgerId(ctx.env.db, 'GST_CASH_LEDGER');
  const heads = cashRows(c.heads);
  const total = heads.reduce((s, r) => s + r.amount, 0);
  const deposited = sumOnLedger(ctx, ecl);
  if (ecl !== undefined && deposited !== total) {
    ctx.warn(
      'gst_stat',
      `The challan's heads total ${money(total)} but the voucher debits "GST Electronic Cash Ledger" with ${money(deposited)}. They must be equal.`,
      'block',
      path,
    );
    return;
  }
  if (!/^\d{14}$/.test(c.cpin.trim())) ctx.warn('gst_stat', 'A CPIN has 14 digits. Check it against the challan.', 'confirm', `${path}.cpin`);
  if (c.cin && !/^[A-Z0-9]{17}$/i.test(c.cin.trim())) ctx.warn('gst_stat', 'A CIN has 17 characters (CPIN + bank code). Check it against the challan.', 'confirm', `${path}.cin`);
  data.challan = {
    cpin: c.cpin.trim(),
    cin: c.cin?.trim() || null,
    brn: c.brn?.trim() || null,
    challanDate: c.challanDate ?? null,
    bankName: c.bankName?.trim() || null,
    mode: c.mode ?? null,
    period: c.period ?? null,
  };
  for (const r of heads) data.stat.push({ nature: 'cash_deposit', period: c.period ?? null, head: r.head, minor: r.minor, amount: r.amount, taxableValue: 0 });
}

function setoff(ctx: PostingAdjustContext, s: NonNullable<VoucherGstDetailsInput['setoff']>, data: HookData): void {
  const ecl = statLedgerId(ctx.env.db, 'GST_CASH_LEDGER');
  const cash = cashRows(s.cash);
  const total = cash.reduce((a, r) => a + r.amount, 0);
  const utilised = -sumOnLedger(ctx, ecl);
  if (ecl !== undefined && utilised !== total) {
    ctx.warn('gst_stat', `The set-off uses ${money(total)} of cash but the journal credits "GST Electronic Cash Ledger" with ${money(utilised)}. Post the set-off again from GST › Set-off.`, 'block', 'gstDetails.setoff');
    return;
  }
  for (const r of cash) data.stat.push({ nature: 'cash_utilised', period: s.period, head: r.head, minor: r.minor, amount: r.amount, taxableValue: 0 });
  for (const r of s.credit) if (r.amount > 0) data.stat.push({ nature: 'itc_utilised', period: s.period, head: r.from, minor: r.to, amount: r.amount, taxableValue: 0 });
}

// ───────────────────────────── Amendments ─────────────────────────────

/** Warn (and stash the original as filed) when an outward document touches a filed GSTR-1 period. */
function amendmentCheck(ctx: PostingAdjustContext, data: HookData): boolean {
  const { db, today } = { db: ctx.env.db, today: ctx.env.today };
  const hasFilings = db.value<number>(`SELECT 1 FROM gst_return_filings WHERE form = 'gstr1' LIMIT 1`) !== undefined;
  if (!hasFilings) return false;
  const existing =
    ctx.voucherId !== null
      ? db.get<{ date: string; affects_books: number; gst_nature: string | null; base_type: string }>('SELECT date, affects_books, gst_nature, base_type FROM vouchers WHERE id = :id', {
          id: ctx.voucherId,
        })
      : undefined;
  const company = loadCompany(db);
  const origFiled = existing && existing.affects_books === 1 && reportedNature(existing.gst_nature) ? filedGstr1Period(db, existing.date) : null;
  const newFiled = filedGstr1Period(db, ctx.date);
  if (!origFiled && !newFiled) return false;
  if (origFiled && existing) {
    const original = docSnapshot(db, company, ctx.voucherId as number, today);
    const amendPeriod = amendmentPeriod(db, company, existing.date, today);
    ctx.warn(
      'gst_amendment',
      `GSTR-1 for ${origFiled.periodLabel} was filed on ${formatDate(origFiled.filedOn)} with this document. The change will be reported as an amendment in the GSTR-1 for ${periodLabel('gstr1', amendPeriod)}; the filed return is not changed.`,
      'confirm',
      'date',
    );
    data.amendment = { today, originalDate: existing.date, original, originalFiled: origFiled.period };
    return true;
  }
  if (newFiled && !ctx.isOptional) {
    const amendPeriod = amendmentPeriod(db, company, ctx.date, today);
    ctx.warn(
      'gst_amendment',
      `GSTR-1 for ${newFiled.periodLabel} has already been filed without this document. It will be listed in the GSTR-1 for ${periodLabel('gstr1', amendPeriod)} under "Documents added after filing" — report it in that return.`,
      'confirm',
      'date',
    );
    data.amendment = { today, originalDate: null, original: null, originalFiled: null };
    return true;
  }
  return false;
}

function writeAmendment(w: VoucherHookWriteContext, a: NonNullable<HookData['amendment']>): void {
  const { db, voucherId } = w;
  const company = loadCompany(db);
  const amended = docSnapshot(db, company, voucherId, a.today);
  const row = db.get<{ guid: string; updated_at: string }>('SELECT guid, updated_at FROM vouchers WHERE id = :id', { id: voucherId });
  const ts = row?.updated_at ?? new Date().toISOString();
  if (a.originalFiled && a.originalDate) {
    const amendPeriod = amendmentPeriod(db, company, a.originalDate, a.today);
    const same = JSON.stringify(a.original) === JSON.stringify(amended);
    const logged = db.value('SELECT 1 FROM gst_amendments WHERE voucher_id = :v AND amend_period = :p', { v: voucherId, p: amendPeriod }) !== undefined;
    if (same && !logged) return; // nothing GSTR-1 reports changed (e.g. the narration)
    recordAmendment(db, { voucherId, guid: row?.guid ?? null, kind: 'amended', originalPeriod: a.originalFiled, amendPeriod, original: a.original, amended, ts });
    return;
  }
  if (!amended) return;
  const filed = filedGstr1Period(db, amended.date);
  if (!filed) return;
  const amendPeriod = amendmentPeriod(db, company, amended.date, a.today);
  recordAmendment(db, { voucherId, guid: row?.guid ?? null, kind: 'added', originalPeriod: filed.period, amendPeriod, original: null, amended, ts });
}

// ───────────────────────────── prepare / write / clear / beforeRemove ─────────────────────────────

function prepare(ctx: CompanyCtx, args: { env: PostingEnv; input: VoucherInput }): void {
  const { env, input } = args;
  if (!env.features.gst || env.company.gstRegistrationType === 'unregistered') return;
  const g = input.gstDetails;
  const ts = ctx.clock.now().toISOString();
  const db = env.db;
  if (g?.advance || g?.advanceRefund || (g?.advanceAdjustments?.length ?? 0) > 0) ensureStatLedger(db, 'GST_ADVANCE', ts);
  else if ((input.partyBillAllocations?.length ?? 0) > 0 && db.value(`SELECT 1 FROM gst_advance_lines LIMIT 1`) !== undefined) ensureStatLedger(db, 'GST_ADVANCE', ts);
  if (g?.billOfEntry && g.billOfEntry.creditLedgerId === undefined) ensureStatLedger(db, 'CUSTOMS_IGST', ts);
  if (g?.challan || g?.setoff) ensureStatLedger(db, 'GST_CASH_LEDGER', ts);
}

function write(w: VoucherHookWriteContext): void {
  const d = w.data as HookData | undefined;
  if (!d) return;
  const { db, voucherId: id, date } = w;
  const books = w.affectsBooks ? 1 : 0;
  const pdc = w.isPostDated ? 1 : 0;
  for (const a of d.advances) {
    db.run(
      `INSERT INTO gst_advance_lines (voucher_id, kind, receipt_voucher_id, party_ledger_id, pos, supply_type, rate, cess_rate, gross, taxable_value,
              igst, cgst, sgst, cess, date, affects_books, is_post_dated)
       VALUES (:id, :kind, :receipt, :party, :pos, :supply, :rate, :cessRate, :gross, :taxable, :igst, :cgst, :sgst, :cess, :date, :books, :pdc)`,
      {
        id,
        kind: a.kind,
        receipt: a.receiptVoucherId ?? id,
        party: a.partyLedgerId,
        pos: a.pos,
        supply: a.supplyType,
        rate: a.rate,
        cessRate: a.cessRate,
        gross: a.gross,
        taxable: a.taxable,
        igst: a.igst,
        cgst: a.cgst,
        sgst: a.sgst,
        cess: a.cess,
        date,
        books,
        pdc,
      },
    );
  }
  if (d.boe) {
    const b = d.boe;
    db.run(
      `INSERT INTO gst_bill_of_entry (voucher_id, boe_no, boe_date, port_code, assessable_value, customs_duty, igst, cess, itc_claimed, date, affects_books, is_post_dated)
       VALUES (:id, :no, :boeDate, :port, :assessable, :duty, :igst, :cess, :itc, :date, :books, :pdc)`,
      { id, no: b.no, boeDate: b.date, port: b.port, assessable: b.assessable, duty: b.duty, igst: b.igst, cess: b.cess, itc: b.itc ? 1 : 0, date, books, pdc },
    );
  }
  for (const s of d.stat) {
    db.run(
      `INSERT INTO gst_stat_lines (voucher_id, nature, return_period, head, minor, amount, taxable_value, date, affects_books, is_post_dated)
       VALUES (:id, :nature, :period, :head, :minor, :amount, :taxable, :date, :books, :pdc)`,
      { id, nature: s.nature, period: s.period, head: s.head, minor: s.minor, amount: s.amount, taxable: s.taxableValue, date, books, pdc },
    );
  }
  if (d.challan) {
    const c = d.challan;
    db.run(
      `INSERT INTO gst_challans (voucher_id, cpin, cin, brn, challan_date, bank_name, mode, return_period, date, affects_books, is_post_dated)
       VALUES (:id, :cpin, :cin, :brn, :cdate, :bank, :mode, :period, :date, :books, :pdc)`,
      { id, cpin: c.cpin, cin: c.cin, brn: c.brn, cdate: c.challanDate, bank: c.bankName, mode: c.mode, period: c.period, date, books, pdc },
    );
  }
  if (d.amendment) writeAmendment(w, d.amendment);
}

function clear(db: Db, voucherId: number): void {
  db.run('DELETE FROM gst_advance_lines WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM gst_bill_of_entry WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM gst_stat_lines WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM gst_challans WHERE voucher_id = :id', { id: voucherId });
}

/**
 * Delete / cancel: a document reported in a filed GSTR-1 cannot simply disappear (the portal keeps it);
 * an advance already adjusted or refunded cannot be removed while those vouchers stand.
 */
function beforeRemove(ctx: CompanyCtx, row: VoucherRow, action: 'delete' | 'cancel'): void {
  const db = ctx.db;
  if (row.base_type === 'receipt') {
    const users = db.value<number>(`SELECT COUNT(*) FROM gst_advance_lines WHERE receipt_voucher_id = :id AND voucher_id <> :id`, { id: row.id }) ?? 0;
    if (users > 0) {
      throw rule(`This receipt's advance has been adjusted or refunded by ${users} other voucher(s). ${action === 'delete' ? 'Delete' : 'Cancel'} those first, or alter them to drop the adjustment.`);
    }
  }
  if (!OUTWARD_BASES.has(row.base_type) || row.affects_books !== 1 || !reportedNature(row.gst_nature)) return;
  const filed = filedGstr1Period(db, row.date);
  if (!filed) return;
  throw rule(
    `GSTR-1 for ${filed.periodLabel} was filed with this document, so it cannot be ${action === 'delete' ? 'deleted' : 'cancelled'}. ` +
      'Issue a credit note for it, or alter it (the change is reported as an amendment in your next GSTR-1). If the return was marked filed by mistake, unmark it under GST › Return filing status.',
  );
}

export const gstVoucherHook: VoucherHook = {
  name: 'gst',
  prepare,
  adjust,
  write,
  clear,
  beforeRemove,
};

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
 *                               (composition company or blocked goods: the IGST is a cost — Dr the purchase ledger)
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
import type { CashHeadAmount, GstAdjustmentNature, GstDocSnapshot, Gstr3bEffect, VoucherGstDetailsInput } from '../../../shared/types/gst-plus.ts';
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
import { anyGstr3bFiled, filedGstr3bPeriod, gstr3bReportPeriod, recordGstr3bChange, voucherEffect, voucherHasGstr3bChanges } from './filed3b.ts';
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
  /** Changes after GSTR-3B is filed (filed3b.ts): the effect before this save and the filed period. */
  filed3b: { today: string; original: Gstr3bEffect | null; originalPeriod: string } | null;
  /** Rule 37 reversal / reclaim journal: the purchase invoices it is for (gst_rule37_links). */
  rule37: { kind: 'reversal' | 'reclaim'; links: Array<{ purchaseVoucherId: number } & Record<TaxHead, Paise>> } | null;
}

const emptyData = (): HookData => ({ advances: [], boe: null, stat: [], challan: null, amendment: null, filed3b: null, rule37: null });

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
  if (gstOn && env.company.gstRegistrationType === 'regular' && filed3bCheck(ctx, data)) used = true;
  if (ctx.baseType === 'receipt' && ctx.voucherId !== null) guardUsedAdvance(ctx, data);
  if (used) ctx.setData(data);
}

/**
 * Altering an advance receipt that other vouchers already adjust or refund: those vouchers reversed its
 * tax at its rate, place of supply and amount, so the receipt must keep them (else "GST on Advances
 * Received" is left with a balance and Table 11B exceeds 11A). Change or delete the adjusting vouchers first.
 */
function guardUsedAdvance(ctx: PostingAdjustContext, data: HookData): void {
  const db = ctx.env.db;
  const used = db.get<{ n: number; gross: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(gross), 0) AS gross FROM gst_advance_lines
      WHERE receipt_voucher_id = :id AND voucher_id <> :id AND kind IN ('adjusted', 'refunded')`,
    { id: ctx.voucherId },
  );
  if (!used || used.n === 0) return;
  const before = db.get<{ pos: string; rate: number; cess_rate: number; igst: number }>(
    `SELECT pos, rate, cess_rate, igst FROM gst_advance_lines WHERE voucher_id = :id AND kind = 'received'`,
    { id: ctx.voucherId },
  );
  const now = data.advances.find((a) => a.kind === 'received');
  const users = `${used.n} voucher(s) already adjust or refund ${money(used.gross)} of this advance`;
  const path = 'gstDetails.advance';
  if (ctx.isOptional || !now) {
    ctx.warn('gst_stat', `${users}. Keep it a regular receipt with the advance details, or alter those vouchers first to drop the adjustment.`, 'block', path);
    return;
  }
  if (now.gross < used.gross) {
    ctx.warn('gst_stat', `${users}: the advance cannot be reduced to ${money(now.gross)}. Alter those vouchers first.`, 'block', `${path}.amount`);
    return;
  }
  if (before && (before.rate !== now.rate || before.cess_rate !== now.cessRate || before.pos !== now.pos || (before.igst !== 0) !== (now.igst !== 0))) {
    ctx.warn('gst_stat', `${users} at ${before.rate}% for state ${before.pos}: the rate and place of supply cannot change now. Alter those vouchers first.`, 'block', path);
  }
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
  const received = ctx.entries.filter((e) => e.amount > 0 && ctx.masters.ledger(e.ledgerId).isCashBank).reduce((s, e) => s + e.amount, 0);
  const gross = a.amount ?? received;
  if (a.amount !== undefined && received > 0 && a.amount > received) {
    ctx.warn('gst_stat', `The advance (${money(a.amount)}) is more than the amount received on this voucher (${money(received)}). Tax is payable only on what was received.`, 'block', 'gstDetails.advance.amount');
    return;
  }
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
  // ITC on the IGST paid at customs follows the goods: none for a composition taxpayer, none when the
  // purchase lines are blocked (s.17(5) / marked ineligible). A bill of entry is one document, so its
  // lines must agree — enter blocked goods on a purchase of their own.
  const taxed = ctx.invoiceLines.filter((l) => l.tax !== 0);
  const blockedLines = taxed.filter((l) => l.itcEligibility === 'ineligible').length;
  if (env.company.gstRegistrationType === 'regular' && blockedLines > 0 && blockedLines < taxed.length) {
    ctx.warn(
      'gst_stat',
      'Some lines of this import carry input tax credit and some are blocked (ineligible). Enter the blocked goods on a separate purchase with their own bill of entry details.',
      'block',
      'gstDetails.billOfEntry',
    );
    return;
  }
  const itc = env.company.gstRegistrationType === 'regular' && (taxed.length === 0 || blockedLines === 0);
  data.boe ={ no: b.number.trim(), date: b.date, port: b.portCode?.trim().toUpperCase() || null, assessable: b.assessableValue, duty: b.customsDuty ?? 0, igst: b.igst, cess, itc };
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
    // No credit (composition taxpayer, or blocked goods): the IGST paid is part of the cost of the goods.
    // Charged to the ledger of the (first) taxed line — the purchase or the asset bought — else a purchase line.
    const lineLedger = taxed.find((l) => l.ledgerId !== null)?.ledgerId ?? null;
    const target = (lineLedger !== null ? ctx.entries.find((e) => e.ledgerId === lineLedger && e.amount > 0) : undefined) ?? ctx.entries.find((e) => e.role === 'purchase');
    if (!target) {
      ctx.warn('gst_stat', 'No purchase or asset ledger on this voucher to carry the IGST paid at customs as cost.', 'block', 'gstDetails.billOfEntry');
      return;
    }
    ctx.addEntry({ ledgerId: target.ledgerId, amount: total, role: target.role, narration: `IGST on bill of entry ${b.number} (no input tax credit)` });
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
    if (a.rule37 && a.rule37.length > 0) rule37Links(ctx, a, amounts, data);
    return;
  }
  if (a.rule37 && a.rule37.length > 0) ctx.warn('gst_stat', 'Rule 37 invoices go only on an ITC reversal under Rule 37 or an ITC reclaim.', 'block', `${path}.rule37`);
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

/**
 * Rule 37 journal: the purchase invoices it reverses (or reclaims) credit for. Each must be a purchase in
 * the books; their per-head sums must equal the journal's Input tax lines (so the 180-day report never
 * counts a reversal twice or not at all).
 */
function rule37Links(ctx: PostingAdjustContext, a: NonNullable<VoucherGstDetailsInput['adjustment']>, amounts: Record<TaxHead, Paise>, data: HookData): void {
  const path = 'gstDetails.adjustment.rule37';
  if (a.nature !== 'itc_reversal_r37' && a.nature !== 'itc_reclaim') {
    ctx.warn('gst_stat', 'Rule 37 invoices go only on an ITC reversal under Rule 37 or an ITC reclaim.', 'block', path);
    return;
  }
  const links: Array<{ purchaseVoucherId: number } & Record<TaxHead, Paise>> = [];
  const sums = { igst: 0, cgst: 0, sgst: 0, cess: 0 } as Record<TaxHead, Paise>;
  const seen = new Set<number>();
  for (const [i, l] of (a.rule37 ?? []).entries()) {
    const v = ctx.env.db.get<{ base_type: string }>('SELECT base_type FROM vouchers WHERE id = :id', { id: l.purchaseVoucherId });
    if (!v || v.base_type !== 'purchase' || seen.has(l.purchaseVoucherId)) {
      ctx.warn('gst_stat', `Rule 37 line ${i + 1}: choose a purchase invoice (each once).`, 'block', `${path}[${i}].purchaseVoucherId`);
      return;
    }
    seen.add(l.purchaseVoucherId);
    const row = { purchaseVoucherId: l.purchaseVoucherId, igst: l.igst ?? 0, cgst: l.cgst ?? 0, sgst: l.sgst ?? 0, cess: l.cess ?? 0 };
    for (const h of TAX_HEADS) {
      if (!Number.isSafeInteger(row[h]) || row[h] < 0) {
        ctx.warn('gst_stat', `Rule 37 line ${i + 1}: ${h.toUpperCase()} must be zero or a positive amount.`, 'block', `${path}[${i}].${h}`);
        return;
      }
      sums[h] += row[h];
    }
    links.push(row);
  }
  if (TAX_HEADS.some((h) => sums[h] !== amounts[h])) {
    ctx.warn('gst_stat', 'The credit of the Rule 37 invoices does not add up to the Input tax lines of this journal. Make them equal.', 'block', path);
    return;
  }
  data.rule37 = { kind: a.nature === 'itc_reclaim' ? 'reclaim' : 'reversal', links };
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

const LEGAL_SETOFF: Readonly<Record<TaxHead, readonly TaxHead[]>> = {
  igst: ['igst', 'cgst', 'sgst'],
  cgst: ['cgst', 'igst'],
  sgst: ['sgst', 'igst'],
  cess: ['cess'],
};

function setoff(ctx: PostingAdjustContext, s: NonNullable<VoucherGstDetailsInput['setoff']>, data: HookData): void {
  const ecl = statLedgerId(ctx.env.db, 'GST_CASH_LEDGER');
  const cash = cashRows(s.cash);
  const total = cash.reduce((a, r) => a + r.amount, 0);
  const utilised = -sumOnLedger(ctx, ecl);
  if (ecl !== undefined && utilised !== total) {
    ctx.warn('gst_stat', `The set-off uses ${money(total)} of cash but the journal credits "GST Electronic Cash Ledger" with ${money(utilised)}. Post the set-off again from GST › Set-off.`, 'block', 'gstDetails.setoff');
    return;
  }
  // s.49(5) / Rule 88A: CGST credit never pays SGST (and vice versa); cess credit pays only cess.
  const bad = s.credit.find((r) => r.amount > 0 && !LEGAL_SETOFF[r.from].includes(r.to));
  if (bad) {
    ctx.warn('gst_stat', `${bad.from.toUpperCase()} credit cannot be used to pay ${bad.to.toUpperCase()} (section 49(5)). Post the set-off again from GST › Set-off.`, 'block', 'gstDetails.setoff');
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

// ───────────────────────────── Changes after GSTR-3B is filed ─────────────────────────────

const GST_DOC_BASES = new Set(['sales', 'purchase', 'credit_note', 'debit_note']);

/** An outward document whose GSTR-1 period is filed: the GSTR-1 amendments already move its 3.1 figures. */
function coveredByGstr1(ctx: PostingAdjustContext, dates: ReadonlyArray<string | null>): boolean {
  if (!OUTWARD_BASES.has(ctx.baseType) || !ctx.outward) return false;
  return dates.some((d) => d !== null && filedGstr1Period(ctx.env.db, d) !== null);
}

/**
 * A voucher touching a period whose GSTR-3B is marked filed (filed3b.ts): confirm, and log the change
 * for the next return. Vouchers already in the log are kept current silently (so the log never holds a
 * stale effect).
 */
function filed3bCheck(ctx: PostingAdjustContext, data: HookData): boolean {
  const { db, today } = ctx.env;
  if (!anyGstr3bFiled(db)) return false;
  const existing =
    ctx.voucherId !== null
      ? db.get<{ date: string; affects_books: number }>('SELECT date, affects_books FROM vouchers WHERE id = :id', { id: ctx.voucherId })
      : undefined;
  if (coveredByGstr1(ctx, [existing?.date ?? null, ctx.date])) return false;
  const company = loadCompany(db);
  const existingFiled = existing && existing.affects_books === 1 ? filedGstr3bPeriod(db, existing.date) : null;
  const logged = ctx.voucherId !== null ? voucherHasGstr3bChanges(db, ctx.voucherId) : null;
  // The effect before this save is needed only when the voucher sits in a filed period or is logged.
  const original = existing && ctx.voucherId !== null && (existingFiled || logged) ? voucherEffect(db, company, ctx.voucherId, today) : null;
  const origFiled = original ? existingFiled : null;
  if (origFiled && existing) {
    const report = gstr3bReportPeriod(db, company, existing.date, today);
    ctx.warn(
      'gst_amendment',
      `GSTR-3B for ${origFiled.periodLabel} was filed on ${formatDate(origFiled.filedOn)} with this voucher's tax / credit. The change will be reported in the GSTR-3B for ${periodLabel('gstr3b', report)}; the filed return keeps its figures.`,
      'confirm',
      'date',
    );
    data.filed3b = { today, original, originalPeriod: origFiled.period };
    return true;
  }
  const g = ctx.input.gstDetails;
  const mayTouch =
    GST_DOC_BASES.has(ctx.baseType) || !!(g?.advance || g?.advanceRefund || (g?.advanceAdjustments?.length ?? 0) > 0 || g?.billOfEntry || g?.adjustment);
  const newFiled = filedGstr3bPeriod(db, ctx.date);
  if (newFiled && mayTouch && !ctx.isOptional) {
    const report = gstr3bReportPeriod(db, company, ctx.date, today);
    ctx.warn(
      'gst_amendment',
      `GSTR-3B for ${newFiled.periodLabel} has already been filed. Any tax or input tax credit of this voucher will be reported in the GSTR-3B for ${periodLabel('gstr3b', report)} (GST › Changes after GSTR-3B filing).`,
      'confirm',
      'date',
    );
    data.filed3b = { today, original, originalPeriod: newFiled.period };
    return true;
  }
  if (logged) {
    data.filed3b = { today, original, originalPeriod: logged.originalPeriod };
    return true;
  }
  return false;
}

function writeFiled3b(w: VoucherHookWriteContext, f: NonNullable<HookData['filed3b']>): void {
  const { db, voucherId } = w;
  const company = loadCompany(db);
  const amended = voucherEffect(db, company, voucherId, f.today);
  const row = db.get<{ guid: string; updated_at: string; date: string }>('SELECT guid, updated_at, date FROM vouchers WHERE id = :id', { id: voucherId });
  if (!row) return;
  const docDate = f.original?.date ?? row.date;
  // A voucher first logged keeps reporting into the period chosen for its filed date.
  const report = gstr3bReportPeriod(db, company, filedGstr3bPeriod(db, docDate) ? docDate : (parsePeriodKey(f.originalPeriod)?.from ?? docDate), f.today);
  const logged = db.value('SELECT 1 FROM gst_3b_changes WHERE voucher_guid = :g AND report_period = :p', { g: row.guid, p: report }) !== undefined;
  if (!logged && JSON.stringify(f.original) === JSON.stringify(amended)) return; // nothing GSTR-3B reports changed
  if (!f.original && !amended) return;
  recordGstr3bChange(db, {
    voucherId,
    guid: row.guid,
    kind: f.original ? 'altered' : 'added',
    originalPeriod: f.originalPeriod,
    reportPeriod: report,
    label: (amended ?? f.original)?.label ?? `Voucher #${voucherId}`,
    docDate,
    original: f.original,
    amended,
    ts: row.updated_at,
  });
}

/** Delete / cancel of a voucher in a filed GSTR-3B period (or already in the log): log its removal. */
function removeFiled3b(ctx: CompanyCtx, row: VoucherRow): void {
  const db = ctx.db;
  if (!anyGstr3bFiled(db)) return;
  const today = ctx.clock.today();
  const filed = filedGstr3bPeriod(db, row.date);
  const logged = voucherHasGstr3bChanges(db, row.id);
  if (!filed && !logged) return;
  const company = loadCompany(db);
  if (OUTWARD_BASES.has(row.base_type) && reportedNature(row.gst_nature) && filedGstr1Period(db, row.date)) return;
  const original = voucherEffect(db, company, row.id, today);
  if (!original) return;
  const report = gstr3bReportPeriod(db, company, row.date, today);
  recordGstr3bChange(db, {
    voucherId: row.id,
    guid: row.guid,
    kind: 'removed',
    originalPeriod: filed?.period ?? logged?.originalPeriod ?? '',
    reportPeriod: report,
    label: original.label,
    docDate: row.date,
    original,
    amended: null,
    ts: ctx.clock.now().toISOString(),
  });
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
  if (g?.advance || g?.advanceRefund || (g?.advanceAdjustments?.length ?? 0) > 0) ensureStatLedger(db, 'GST_ADVANCE', ts, (e) => ctx.audit(e));
  else if ((input.partyBillAllocations?.length ?? 0) > 0 && db.value(`SELECT 1 FROM gst_advance_lines LIMIT 1`) !== undefined) ensureStatLedger(db, 'GST_ADVANCE', ts, (e) => ctx.audit(e));
  if (g?.billOfEntry && g.billOfEntry.creditLedgerId === undefined) ensureStatLedger(db, 'CUSTOMS_IGST', ts, (e) => ctx.audit(e));
  if (g?.challan || g?.setoff) ensureStatLedger(db, 'GST_CASH_LEDGER', ts, (e) => ctx.audit(e));
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
  if (d.filed3b) writeFiled3b(w, d.filed3b);
  if (d.rule37) {
    const books = w.affectsBooks ? 1 : 0;
    for (const l of d.rule37.links) {
      db.run(
        `INSERT INTO gst_rule37_links (voucher_id, purchase_voucher_id, kind, igst, cgst, sgst, cess, date, affects_books, is_post_dated)
         VALUES (:id, :pid, :kind, :igst, :cgst, :sgst, :cess, :date, :books, :pdc)`,
        { id, pid: l.purchaseVoucherId, kind: d.rule37.kind, igst: l.igst, cgst: l.cgst, sgst: l.sgst, cess: l.cess, date, books, pdc },
      );
    }
  }
}

function clear(db: Db, voucherId: number): void {
  db.run('DELETE FROM gst_advance_lines WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM gst_bill_of_entry WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM gst_stat_lines WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM gst_challans WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM gst_rule37_links WHERE voucher_id = :id', { id: voucherId });
}

/**
 * Delete / cancel: a document reported in a filed GSTR-1 cannot simply disappear (the portal keeps it);
 * an advance already adjusted or refunded cannot be removed while those vouchers stand; the removal of a
 * voucher of a filed GSTR-3B period is logged for the next GSTR-3B (filed3b.ts).
 */
function beforeRemove(ctx: CompanyCtx, row: VoucherRow, action: 'delete' | 'cancel'): void {
  const db = ctx.db;
  if (row.base_type === 'receipt') {
    const users = db.value<number>(`SELECT COUNT(*) FROM gst_advance_lines WHERE receipt_voucher_id = :id AND voucher_id <> :id`, { id: row.id }) ?? 0;
    if (users > 0) {
      throw rule(`This receipt's advance has been adjusted or refunded by ${users} other voucher(s). ${action === 'delete' ? 'Delete' : 'Cancel'} those first, or alter them to drop the adjustment.`);
    }
  }
  if (OUTWARD_BASES.has(row.base_type) && row.affects_books === 1 && reportedNature(row.gst_nature)) {
    const filed1 = filedGstr1Period(db, row.date);
    if (filed1) throw gstr1Refusal(filed1.periodLabel, action);
  }
  // A voucher of a filed GSTR-3B period: its removal is reported in the next GSTR-3B.
  if (row.affects_books === 1) removeFiled3b(ctx, row);
}

function gstr1Refusal(filedPeriodLabel: string, action: 'delete' | 'cancel'): Error {
  return rule(
    `GSTR-1 for ${filedPeriodLabel} was filed with this document, so it cannot be ${action === 'delete' ? 'deleted' : 'cancelled'}. ` +
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

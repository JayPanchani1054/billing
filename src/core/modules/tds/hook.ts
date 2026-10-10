/**
 * TDS/TCS voucher hook (vouchers/hooks.ts). Computes the deduction / collection of a voucher at entry,
 * posts the auto-lines and rebuilds tds_lines / tds_challans with the voucher (same transaction, same
 * books filter as gst_lines).
 *
 * TDS (F11 › TDS on): purchase (any mode), journal and payment vouchers.
 *   - Assessable lines: ledgers with TDS details "applicable" (expense / fixed asset / purchase ledgers).
 *     Invoice modes take the line's taxable value (GST excluded, CBDT Circular 23/2017) — or value + GST
 *     when the nature's rate row says the base includes GST; ledger mode takes the line's Dr amount.
 *     The nature is the ledger's, else the party's default nature, else `input.tds.natureId`.
 *   - `input.tds.natureId` without applicable lines: payment (advance) → the party's Dr amount; journal
 *     → the party's Cr amount; purchase → the invoice's taxable value.
 *   - Deductee: the invoice party; in ledger mode the one party line (Sundry Creditors / Debtors or a
 *     ledger with a deductee type — partner's capital, loan) on the credit side (payment: debit side).
 *     A party is never an expense line itself; a party marked "does not apply" is exempt.
 *   - Advances: a later bill / journal credit is set off against advances of the party under the nature
 *     on which tax was deducted (tds_lines.advance_adjusted); the single limit is tested on the whole bill.
 *   - Posting: Cr 'TDS Payable – <section>' and the deductee gets that much less: purchase / journal →
 *     the party's credit is reduced; payment → the cash/bank credit is reduced (the party is debited
 *     with the gross). Bill-wise allocations typed for the gross are rescaled to the net.
 * TCS (F11 › TCS on): sales invoices (item / accounting mode). Lines whose sales ledger has a TCS
 * nature; Dr party += TCS, Cr 'TCS Payable'; the invoice value includes the TCS.
 * Overrides: `input.tds.overrides` (amount + reason) replace the computed amount per nature; a credit the
 * user typed to the duty ledger is taken as the amount (never posted twice).
 * Challan: `input.tds.challan` on a payment is checked against the voucher and stored in tds_challans.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import { periodRange, taxYearOf } from '../../../shared/tds/rules.ts';
import type { TdsKind, TdsVoucherLine, TdsVoucherPreview, VoucherTdsChallanInput, VoucherTdsInput } from '../../../shared/types/tds.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';
import type { PostingAdjustContext, VoucherHook, VoucherHookWriteContext } from '../vouchers/hooks.ts';
import type { LedgerInfo } from '../vouchers/masters.ts';
import type { PlanEntry } from '../vouchers/posting.ts';
import { computeTds } from './engine.ts';
import { ensurePayableLedger, payableLedgerName, rateFromRow, TdsStore, type Deductee, type NatureRow } from './store.ts';

const TDS_BASES: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['purchase', 'journal', 'payment']);
const inr = (p: Paise): string => formatMoney(p, { symbol: true });

/** What adjust() hands to write() / preview(). */
export interface TdsHookData {
  lines: TdsVoucherLine[];
  challan: VoucherTdsChallanInput | null;
}

function isInvoiceMode(mode: VoucherInput['mode']): boolean {
  return mode === 'item_invoice' || mode === 'accounting_invoice';
}

function wants(features: { tds: boolean; tcs: boolean }, base: VoucherBaseType, mode: VoucherInput['mode']): { tds: boolean; tcs: boolean } {
  return {
    tds: features.tds && TDS_BASES.has(base) && (mode === 'ledger' || isInvoiceMode(mode)),
    tcs: features.tcs && base === 'sales' && isInvoiceMode(mode),
  };
}

// ───────────────────────────── adjust ─────────────────────────────

interface Bucket {
  natureId: number;
  taxable: Paise;
  tax: Paise;
  paths: string[];
}

function adjust(ctx: PostingAdjustContext): void {
  const w = wants(ctx.env.features, ctx.baseType, ctx.mode);
  const challan = ctx.input.tds?.challan ?? null;
  if (ctx.voucherId !== null && (!w.tds || !w.tcs)) warnTurnedOff(ctx, w);
  if (!w.tds && !w.tcs && !challan && !noteKind(ctx)) return;
  const store = new TdsStore(ctx.env.db);
  const lines: TdsVoucherLine[] = [];
  if (w.tds) lines.push(...computeKind(ctx, store, 'tds'));
  if (w.tcs) lines.push(...computeKind(ctx, store, 'tcs'));
  const nk = noteKind(ctx);
  if (nk) lines.push(...reverseOnNote(ctx, store, nk));
  if (challan) checkChallan(ctx, store, challan);
  if (lines.length > 0 || challan) ctx.setData({ lines, challan } satisfies TdsHookData);
}

/**
 * Altering a voucher that carries TDS / TCS while that feature is now off in F11 would drop the tax
 * silently (the hook computes nothing): ask first. One indexed lookup, only on alter.
 */
function warnTurnedOff(ctx: PostingAdjustContext, w: { tds: boolean; tcs: boolean }): void {
  for (const r of ctx.env.db.all<{ kind: TdsKind; amount: number }>(
    'SELECT kind, SUM(amount) AS amount FROM tds_lines WHERE voucher_id = :id GROUP BY kind',
    { id: ctx.voucherId },
  )) {
    if (r.amount <= 0 || w[r.kind]) continue;
    const K = r.kind.toUpperCase();
    ctx.warn(
      'tds',
      `This voucher carries ${K} of ${inr(r.amount)}, but ${K} is now turned off (F11): saving it removes the ${K} from the voucher and the ${K} reports. Turn ${K} on again to keep it.`,
      'confirm',
    );
  }
}

function computeKind(ctx: PostingAdjustContext, store: TdsStore, kind: TdsKind): TdsVoucherLine[] {
  const input = ctx.input;
  const tdsIn: VoucherTdsInput = input.tds ?? {};
  const invoice = isInvoiceMode(ctx.mode);
  const m = ctx.masters;

  // ── Assessable amounts per nature ──
  const buckets = new Map<number, Bucket>();
  const add = (natureId: number, taxable: Paise, tax: Paise, path: string): void => {
    const b = buckets.get(natureId) ?? { natureId, taxable: 0, tax: 0, paths: [] };
    b.taxable += taxable;
    b.tax += tax;
    b.paths.push(path);
    buckets.set(natureId, b);
  };
  const deductee = findDeductee(ctx, store, kind);
  const fallbackNature = deductee.ledger ? (store.deductee(deductee.ledger.id)?.defaultNatureId ?? null) : null;
  const natureOf = (ledgerId: number | null, path: string): number | null => {
    if (ledgerId === null) return null;
    const d = store.detail(ledgerId);
    if (!d || d.applicable !== 1 || d.payable_kind !== null) return null;
    // A party's details (deductee, default nature) never make the party itself an expense line: a
    // transfer between two parties is not a payment for work or services.
    if (isPartyRole(m.ledger(ledgerId), d)) return null;
    const id = d.nature_id ?? fallbackNature ?? tdsIn.natureId ?? null;
    if (id === null) {
      ctx.warn('tds', `${m.ledger(ledgerId).name} is marked ${kind.toUpperCase()} applicable but has no nature of ${kind === 'tds' ? 'payment' : 'goods'}. Set it in TDS/TCS › Ledger details.`, 'info', path);
      return null;
    }
    const n = store.nature(id);
    return n && n.kind === kind && n.is_active === 1 ? id : null;
  };

  if (invoice) {
    store.preloadDetails(ctx.invoiceLines.map((l) => l.ledgerId).filter((x): x is number => x !== null));
    for (const l of ctx.invoiceLines) {
      const path = l.kind === 'item' ? `items[${l.index}]` : `ledgers[${l.index}]`;
      const id = natureOf(l.ledgerId, path);
      if (id !== null) add(id, l.taxableValue, l.tax, path);
    }
  } else {
    store.preloadDetails(ctx.entries.map((e) => e.ledgerId));
    for (const e of ctx.entries) {
      if (e.source.kind !== 'ledger') continue;
      const L = m.ledger(e.ledgerId);
      if (L.isCashBank || (deductee.ledger && L.id === deductee.ledger.id)) continue;
      const id = natureOf(L.id, `ledgers[${e.source.index}].ledgerId`);
      if (id !== null) add(id, e.amount, 0, `ledgers[${e.source.index}].ledgerId`);
    }
  }
  // An explicit nature with nothing applicable: the deductee's gross (advance payment / journal / purchase).
  if (buckets.size === 0 && tdsIn.natureId !== undefined && kind === 'tds') {
    const n = store.nature(tdsIn.natureId);
    if (!n || n.kind !== 'tds') {
      ctx.warn('tds', 'The nature of payment chosen for TDS no longer exists or is a TCS nature. Choose it again.', 'block');
    } else if (invoice) {
      add(n.id, ctx.invoiceLines.reduce((a, l) => a + l.taxableValue, 0), ctx.invoiceLines.reduce((a, l) => a + l.tax, 0), 'tds');
    } else if (deductee.entry) {
      add(n.id, Math.abs(deductee.entry.amount), 0, 'tds');
    }
  }
  // Tax the user credited to the duty ledger by hand on this voucher: it IS the deduction (posting it
  // again would deduct twice). Payable ledger id → amount credited.
  const manual = manualPayableCredits(ctx, store, kind);
  const manualUsed = new Set<number>();
  if (buckets.size === 0) {
    // A TDS journal for a bill booked gross (Dr party / Cr TDS Payable): the credit typed to the duty
    // ledger is the deduction on that bill — recorded for the reports and the statement.
    const gross = kind === 'tds' && ctx.baseType === 'journal' && ctx.mode === 'ledger' && manual.size > 0 ? grossBillJournal(ctx, store, manual, manualUsed) : [];
    warnUnmatchedManual(ctx, kind, manual, manualUsed);
    return gross;
  }

  if (!deductee.ledger) {
    ctx.warn('tds', deductee.problem ?? `No party to ${kind === 'tds' ? 'deduct TDS from' : 'collect TCS from'}.`, deductee.ambiguous ? 'confirm' : 'info');
  }
  // A party marked "TDS / TCS does not apply" (TDS/TCS › Ledger details: s.196, a s.194C(6)
  // declaration, a buyer exempt from TCS …): nothing is computed on its vouchers.
  const partyDetail = deductee.ledger ? store.detail(deductee.ledger.id) : null;
  if (deductee.ledger && partyDetail && partyDetail.applicable !== 1) {
    ctx.warn(
      'tds',
      `${deductee.ledger.name} is marked "${kind.toUpperCase()} does not apply" in its TDS/TCS details: nothing was ${kind === 'tds' ? 'deducted' : 'collected'}.`,
      'info',
    );
    return [];
  }
  const d: Deductee | null = deductee.ledger ? store.deductee(deductee.ledger.id) : null;
  const settings = store.settings();
  const out: TdsVoucherLine[] = [];
  const manualLines = new Set<TdsVoucherLine>();

  for (const b of buckets.values()) {
    const nature = store.nature(b.natureId) as NatureRow;
    const rateRow = store.rateOn(nature.id, ctx.date);
    if (!rateRow) {
      ctx.warn('tds', `${nature.section} ${nature.name}: no rate is in force on this date. Add a rate in TDS/TCS › Natures.`, 'confirm');
      continue;
    }
    if (nature.section === '194Q' && !settings.buyer194Q) continue; // buyer below ₹10 crore: 194Q does not apply.
    // s.194T: payments by a FIRM (partnership firm or LLP) to its partners. Any other deductor (company,
    // individual, …) does not deduct under it (TDS/TCS › Setup › deductor category).
    if (nature.section === '194T' && settings.deductorCategory !== 'firm') {
      ctx.warn(
        'tds',
        `194T applies only when a firm (partnership or LLP) pays its partners; this company is set up as a ${settings.deductorCategory} deductor (TDS/TCS › Setup), so nothing was deducted under 194T.`,
        'info',
        b.paths[0],
      );
      continue;
    }
    const rate = rateFromRow(rateRow);
    const assessable = b.taxable + (rate.baseIncludesGst ? b.tax : 0);
    const payableId = store.payableLedgerId(kind, nature.section);
    const line: TdsVoucherLine = {
      kind,
      natureId: nature.id,
      natureName: nature.name,
      section: nature.section,
      partyLedgerId: d?.ledgerId ?? null,
      partyName: d?.name ?? null,
      deducteeType: d?.type ?? 'others',
      pan: d?.pan ?? null,
      panStatus: d?.panStatus ?? 'missing',
      assessable,
      catchUp: 0,
      base: 0,
      rate: 0,
      computed: 0,
      amount: 0,
      overridden: false,
      reason: null,
      status: 'no_party',
      payableLedgerId: payableId,
      payableLedgerName: payableLedgerName(kind, nature.section),
      note: '',
    };
    if (!d) {
      // The missing party is already reported; a hand-typed duty line is not "unmatched" on top of it.
      if (payableId !== null) manualUsed.add(payableId);
      line.note = 'No deductee: nothing was deducted.';
      out.push(line);
      continue;
    }
    const period =
      rate.aggregatePeriod === 'month'
        ? periodRange(ctx.date.slice(0, 7))
        : { from: taxYearOf(ctx.date).start, to: ctx.date };
    const prior = priorFigures(ctx.env.db, {
      party: d.ledgerId,
      nature: nature.id,
      from: period.from,
      to: ctx.date,
      self: ctx.voucherId ?? 0,
      today: ctx.env.today,
    });
    // A bill / journal credit for which the party was paid an advance under this nature: the advance
    // was counted (and taxed when liable) when it was paid, so only the rest is taken in now.
    let advanceAdjusted = 0;
    if (kind === 'tds' && ctx.baseType !== 'payment' && assessable > 0) {
      const open = advanceOpen(ctx.env.db, { party: d.ledgerId, nature: nature.id, to: ctx.date, self: ctx.voucherId ?? 0, today: ctx.env.today });
      advanceAdjusted = Math.min(assessable, open);
    }
    const netAssessable = assessable - advanceAdjusted;
    line.assessable = netAssessable;
    line.advanceAdjusted = advanceAdjusted;
    const cert = d.certificate && d.certificate.from <= ctx.date && ctx.date <= d.certificate.to && (d.certificate.natureId === null || d.certificate.natureId === nature.id) ? d.certificate : null;
    const certUsed = cert ? certificateUsed(ctx.env.db, d.ledgerId, cert.from, cert.to, ctx.voucherId ?? 0, ctx.env.today) : 0;
    const res = computeTds({
      rate,
      deducteeType: d.type,
      panOk: d.panStatus === 'valid',
      assessable: netAssessable,
      singleBase: assessable,
      prior: prior.prior,
      priorUndeducted: prior.undeducted,
      certificate: cert ? { number: cert.number, rate: cert.rate, remaining: cert.limit === null ? null : Math.max(0, cert.limit - certUsed) } : null,
      roundToRupee: settings.roundToRupee,
      verb: kind === 'tds' ? 'deduct' : 'collect',
    });
    Object.assign(line, { catchUp: res.catchUp, base: res.base, rate: res.rate, computed: res.amount, amount: res.amount, status: res.status, note: res.note });
    if (advanceAdjusted > 0) {
      line.note = `${inr(advanceAdjusted)} of this ${inr(assessable)} is set off against the advance paid earlier under ${nature.section} (counted when it was paid). ${line.note}`;
    }
    if (d.typeAssumed && res.liable) {
      line.note += ` Deductee type not set on ${d.name}: taken as ${d.type}.`;
    }
    const manualAmount = payableId !== null && !manualUsed.has(payableId) ? manual.get(payableId) : undefined;
    if (payableId !== null && manualAmount !== undefined) manualUsed.add(payableId);
    const ov =
      manualAmount !== undefined
        ? { amount: manualAmount, reason: `Entered by hand on the voucher (${payableLedgerName(kind, nature.section)})` }
        : tdsIn.overrides?.find((o) => o.natureId === nature.id);
    if (ov) {
      line.overridden = ov.amount !== res.amount;
      line.reason = ov.reason.trim();
      line.amount = ov.amount;
      if (ov.amount === 0) line.status = res.liable ? 'overridden_nil' : 'below_threshold';
      else {
        if (line.base === 0) line.base = netAssessable;
        if (line.status === 'below_threshold') line.status = 'deducted';
        if (line.overridden && line.base > 0) line.rate = Math.round((ov.amount / line.base) * 100 * 10_000) / 10_000;
      }
      if (line.overridden) line.note += ` Changed from ${inr(res.amount)} to ${inr(ov.amount)}: ${line.reason}`;
      else if (manualAmount !== undefined) line.note += ` Entered by hand on the voucher.`;
    }
    if (manualAmount !== undefined) manualLines.add(line);
    if (d.panStatus !== 'valid' && line.amount > 0) {
      ctx.warn('tds', `${d.name} has ${d.panStatus === 'missing' ? 'no PAN' : `an invalid PAN (${d.pan ?? ''})`}: ${kind.toUpperCase()} u/s ${nature.section} at the higher rate ${line.rate}%.`, 'info', 'partyLedgerId');
    }
    out.push(line);
  }
  for (const o of tdsIn.overrides ?? []) {
    if (!out.some((l) => l.natureId === o.natureId)) {
      const n = store.nature(o.natureId);
      if (n && n.kind === kind) ctx.warn('tds', `${n.section} ${n.name}: nothing on this voucher is subject to it, so its override was ignored.`, 'info');
    }
  }
  warnUnmatchedManual(ctx, kind, manual, manualUsed);
  postLines(ctx, kind, out.filter((l) => !manualLines.has(l)), deductee);
  return out;
}

// ───────────────────────────── TDS journal on a bill booked gross ─────────────────────────────

/**
 * Journal Dr <party> / Cr TDS Payable – <section> with nothing TDS-applicable on it: the tax deducted
 * later on a bill booked gross. The party is the one party DEBITED; the bill is the one its bill-wise
 * "Against" names (else none). The nature is the party's default nature of that section, else the
 * bill's line of that section, else the first active nature of the section. Base: the bill's TDS line
 * (its assessable was already counted — this line then adds nothing to the threshold totals and clears
 * a below-threshold amount), else the bill's taxable value, else the tax grossed up at the rate in force.
 */
function grossBillJournal(ctx: PostingAdjustContext, store: TdsStore, manual: ReadonlyMap<number, Paise>, manualUsed: Set<number>): TdsVoucherLine[] {
  const m = ctx.masters;
  const db = ctx.env.db;
  store.preloadDetails(ctx.entries.map((e) => e.ledgerId));
  const debited = ctx.entries.filter((e) => {
    if (e.source.kind !== 'ledger' || e.amount <= 0) return false;
    const L = m.ledger(e.ledgerId);
    if (L.isCashBank || L.isGstDuty) return false;
    const det = store.detail(L.id);
    return !det?.payable_kind && isPartyRole(L, det);
  });
  const ids = [...new Set(debited.map((e) => e.ledgerId))];
  if (ids.length !== 1) return [];
  const party = m.ledger(ids[0]);
  const d = store.deductee(party.id);
  if (!d) return [];
  const partyDetail = store.detail(party.id);
  if (partyDetail && partyDetail.applicable !== 1) return [];
  // The bill: bill-wise "Against" on the party's line.
  const entry = debited[0];
  const line = entry.source.kind === 'ledger' ? ctx.input.ledgers?.[entry.source.index] : undefined;
  const billName = (line?.billAllocations ?? []).find((a) => a.refType === 'against' && a.billName?.trim())?.billName?.trim() ?? null;
  const bill = billName
    ? (db.get<{ id: number; taxable: number; total: number; label: string }>(
        `SELECT v.id, v.taxable_amount AS taxable, v.total_amount AS total, vt.name || ' ' || COALESCE(v.number, '') AS label
           FROM bill_allocations ba JOIN vouchers v ON v.id = ba.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
          WHERE ba.ledger_id = :party AND ba.bill_name = :name AND ba.ref_type = 'new' AND v.id <> :self
          ORDER BY ba.id LIMIT 1`,
        { party: party.id, name: billName, self: ctx.voucherId ?? 0 },
      ) ?? null)
    : null;
  const out: TdsVoucherLine[] = [];
  for (const [payableId, amount] of manual) {
    const section = store.detail(payableId)?.payable_section ?? null;
    if (!section) continue;
    const def = d.defaultNatureId !== null ? store.nature(d.defaultNatureId) : null;
    const billLine = bill
      ? (db.get<{ nature_id: number; assessable: number; base: number; status: string }>(
          `SELECT nature_id, assessable, base, status FROM tds_lines WHERE voucher_id = :v AND kind = 'tds' AND section = :s ORDER BY line_no LIMIT 1`,
          { v: bill.id, s: section },
        ) ?? null)
      : null;
    const natureId =
      def && def.kind === 'tds' && def.section === section
        ? def.id
        : (billLine?.nature_id ??
          db.value<number>(`SELECT id FROM tds_natures WHERE kind = 'tds' AND section = :s AND is_active = 1 ORDER BY id LIMIT 1`, { s: section }) ??
          null);
    if (natureId === null) continue;
    const nature = store.nature(natureId) as NatureRow;
    let assessable = 0;
    let catchUp = 0;
    let base = 0;
    if (billLine) {
      base = billLine.assessable;
      if (billLine.status === 'below_threshold') catchUp = billLine.assessable;
    } else if (bill) {
      assessable = bill.taxable > 0 ? bill.taxable : Math.abs(bill.total);
      base = assessable;
    } else {
      const rateRow = store.rateOn(natureId, ctx.date);
      const pct = rateRow ? rateFromRow(rateRow) : null;
      const r = pct ? (d.panStatus !== 'valid' ? pct.rateNoPan : d.type === 'company' ? pct.rateCompany : d.type === 'individual' ? pct.rateIndividual : pct.rateOthers) : 0;
      assessable = r > 0 ? Math.round((amount * 100) / r) : 0;
      base = assessable;
    }
    manualUsed.add(payableId);
    out.push({
      kind: 'tds',
      natureId,
      natureName: nature.name,
      section,
      partyLedgerId: d.ledgerId,
      partyName: d.name,
      deducteeType: d.type,
      pan: d.pan,
      panStatus: d.panStatus,
      assessable,
      catchUp,
      base,
      rate: base > 0 ? Math.round((amount / base) * 100 * 10_000) / 10_000 : 0,
      computed: amount,
      amount,
      overridden: false,
      reason: null,
      status: 'deducted',
      payableLedgerId: payableId,
      payableLedgerName: payableLedgerName('tds', section),
      note: bill
        ? `TDS deducted by journal on ${bill.label.trim()} (${billName}), booked gross.`
        : `TDS deducted by journal (Dr ${party.name} / Cr ${payableLedgerName('tds', section)}); no bill named — the base is the tax grossed up at the rate in force.`,
      billVoucherId: bill?.id ?? null,
    });
  }
  if (out.length > 0) {
    ctx.warn('tds', `Recorded as TDS deducted from ${party.name}${bill ? ` on ${billName}` : ''} (a bill booked gross); it is in the TDS reports and the quarterly statement.`, 'info');
  }
  return out;
}

// ───────────────────────────── Debit / credit notes ─────────────────────────────

/** TDS on a debit note to a supplier, TCS on a credit note to a customer (invoice modes). */
function noteKind(ctx: PostingAdjustContext): TdsKind | null {
  if (!isInvoiceMode(ctx.mode) || !ctx.party || ctx.party.isCashBank) return null;
  if (ctx.baseType === 'debit_note' && !ctx.outward && ctx.env.features.tds) return 'tds';
  if (ctx.baseType === 'credit_note' && ctx.outward && ctx.env.features.tcs) return 'tcs';
  return null;
}

/**
 * A debit note (purchase return / reduction) against a bill on which TDS was deducted, or a credit note
 * against a sale on which TCS was collected, reverses that tax in proportion to the note's taxable value
 * (note ÷ bill, never more than what is left of the bill's tax): Dr the duty ledger, and the party is
 * debited (TDS) / credited (TCS) that much less / more. The bill is the one the note's bill-wise
 * "Against" names, else the original invoice number. A reversal the user typed by hand (Dr the duty
 * ledger) is taken as it is. Lines are negative and carry the bill (tds_lines.bill_voucher_id).
 */
function reverseOnNote(ctx: PostingAdjustContext, store: TdsStore, kind: TdsKind): TdsVoucherLine[] {
  const db = ctx.env.db;
  const party = ctx.party as LedgerInfo;
  const billBase = kind === 'tds' ? 'purchase' : 'sales';
  const against = (ctx.input.partyBillAllocations ?? []).find((a) => a.refType === 'against' && a.billName?.trim())?.billName?.trim() ?? null;
  let billId: number | null = null;
  if (against) {
    billId =
      db.value<number>(
        `SELECT v.id FROM bill_allocations ba JOIN vouchers v ON v.id = ba.voucher_id
          WHERE ba.ledger_id = :party AND ba.bill_name = :name AND ba.ref_type = 'new' AND v.base_type = :base ORDER BY ba.id LIMIT 1`,
        { party: party.id, name: against, base: billBase },
      ) ?? null;
  }
  const orig = ctx.input.originalInvoiceNo?.trim();
  if (billId === null && orig) {
    billId =
      db.value<number>(
        `SELECT id FROM vouchers WHERE party_ledger_id = :party AND base_type = :base AND affects_books = 1
            AND (number = :no OR (:base = 'purchase' AND reference_no = :no))
          ORDER BY date DESC, id DESC LIMIT 1`,
        { party: party.id, base: billBase, no: orig },
      ) ?? null;
  }
  if (billId === null) return [];
  const bill = db.get<{ taxable: number; number: string | null; label: string }>(
    `SELECT v.taxable_amount AS taxable, v.number, vt.name || ' ' || COALESCE(v.number, '') AS label FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id`,
    { id: billId },
  );
  if (!bill || bill.taxable <= 0) return [];
  const billLines = db.all<{ nature_id: number; section: string; assessable: number; amount: number; rate: number; payable_ledger_id: number | null }>(
    `SELECT nature_id, section, assessable, amount, rate, payable_ledger_id FROM tds_lines
      WHERE voucher_id = :v AND kind = :kind AND amount > 0 AND affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`,
    { v: billId, kind, today: ctx.env.today },
  );
  if (billLines.length === 0) return [];
  const noteTaxable = ctx.invoiceLines.reduce((a, l) => a + l.taxableValue, 0);
  if (noteTaxable <= 0) return [];
  const settings = store.settings();
  const d = store.deductee(party.id);
  const partyEntry = ctx.entries.find((e) => e.source.kind === 'party') ?? null;
  // Debits the user typed to the duty ledgers (a reversal entered by hand).
  const manualDr = new Map<number, Paise>();
  for (const e of ctx.entries) {
    if (e.source.kind === 'hook' || e.amount <= 0) continue;
    const det = store.detail(e.ledgerId);
    if (det?.payable_kind === kind) manualDr.set(e.ledgerId, (manualDr.get(e.ledgerId) ?? 0) + e.amount);
  }
  const out: TdsVoucherLine[] = [];
  let posted = 0;
  for (const bl of billLines) {
    const done = db.get<{ amount: number; assessable: number }>(
      `SELECT COALESCE(-SUM(amount), 0) AS amount, COALESCE(-SUM(assessable), 0) AS assessable FROM tds_lines
        WHERE bill_voucher_id = :bill AND nature_id = :n AND amount < 0 AND voucher_id <> :self
          AND affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`,
      { bill: billId, n: bl.nature_id, self: ctx.voucherId ?? 0, today: ctx.env.today },
    ) ?? { amount: 0, assessable: 0 };
    const leftTax = Math.max(0, bl.amount - done.amount);
    const leftBase = Math.max(0, bl.assessable - done.assessable);
    if (leftTax === 0) continue;
    let rev = Math.min(leftTax, Math.round((bl.amount * noteTaxable) / bill.taxable));
    if (settings.roundToRupee) rev = Math.min(leftTax, Math.round(rev / 100) * 100);
    const revBase = Math.min(leftBase, Math.round((bl.assessable * noteTaxable) / bill.taxable));
    const handTyped = bl.payable_ledger_id !== null ? manualDr.get(bl.payable_ledger_id) : undefined;
    if (handTyped !== undefined && bl.payable_ledger_id !== null) {
      rev = handTyped;
      manualDr.delete(bl.payable_ledger_id);
    }
    if (rev <= 0) continue;
    const nature = store.nature(bl.nature_id);
    out.push({
      kind,
      natureId: bl.nature_id,
      natureName: nature?.name ?? bl.section,
      section: bl.section,
      partyLedgerId: party.id,
      partyName: d?.name ?? party.name,
      deducteeType: d?.type ?? 'others',
      pan: d?.pan ?? null,
      panStatus: d?.panStatus ?? 'missing',
      assessable: -revBase,
      catchUp: 0,
      base: -revBase,
      rate: bl.rate,
      computed: -rev,
      amount: -rev,
      overridden: handTyped !== undefined,
      reason: handTyped !== undefined ? 'Entered by hand on the note' : null,
      status: 'deducted',
      payableLedgerId: bl.payable_ledger_id,
      payableLedgerName: payableLedgerName(kind, bl.section),
      note: `Reverses ${inr(rev)} of the ${kind.toUpperCase()} on ${bill.label.trim()} in proportion to this note (${inr(noteTaxable)} of ${inr(bill.taxable)}).`,
      billVoucherId: billId,
    });
    if (handTyped === undefined && bl.payable_ledger_id !== null) {
      ctx.addEntry({ ledgerId: bl.payable_ledger_id, amount: rev, role: kind === 'tcs' ? 'charge' : 'other', narration: `${kind.toUpperCase()} u/s ${bl.section} reversed on ${bill.label.trim()}` });
      posted += rev;
    }
  }
  if (posted > 0) {
    if (!partyEntry) {
      ctx.warn('tds', `There is no party entry to adjust the ${kind.toUpperCase()} reversed (${inr(posted)}).`, 'block');
      return out;
    }
    // TDS: the supplier is debited that much less; TCS: the customer is credited that much more.
    ctx.adjustEntry(partyEntry, -posted);
    if (kind === 'tcs') ctx.addToInvoiceValue(posted);
    ctx.warn('tds', `${kind.toUpperCase()} of ${inr(posted)} deducted on ${bill.label.trim()} is reversed in proportion to this note.`, 'info');
  }
  return out;
}

/** Party-role ledger: a debtor / creditor, or any ledger whose TDS details give it a deductee type. */
function isPartyRole(L: LedgerInfo, d: { deductee_type: string | null } | null): boolean {
  if (L.isDebtor || L.isCreditor) return true;
  return (d?.deductee_type ?? null) !== null && L.nature !== 'expenses' && L.nature !== 'income';
}

/** Credits typed by the user (not posted by a hook) to this kind's duty ledgers: ledger id → amount. */
function manualPayableCredits(ctx: PostingAdjustContext, store: TdsStore, kind: TdsKind): Map<number, Paise> {
  const out = new Map<number, Paise>();
  store.preloadDetails(ctx.entries.map((e) => e.ledgerId));
  for (const e of ctx.entries) {
    if (e.source.kind === 'hook' || e.amount >= 0) continue;
    const det = store.detail(e.ledgerId);
    if (!det || det.payable_kind !== kind) continue;
    out.set(e.ledgerId, (out.get(e.ledgerId) ?? 0) - e.amount);
  }
  return out;
}

/** A hand-typed credit to a duty ledger with nothing computed for it would be missing from the TDS reports. */
function warnUnmatchedManual(ctx: PostingAdjustContext, kind: TdsKind, manual: ReadonlyMap<number, Paise>, used: ReadonlySet<number>): void {
  for (const [ledgerId, amount] of manual) {
    if (used.has(ledgerId)) continue;
    ctx.warn(
      'tds',
      `${ctx.masters.ledger(ledgerId).name} is credited with ${inr(amount)} by hand, but nothing on this voucher is ${kind.toUpperCase()}-applicable, so the ${kind.toUpperCase()} reports and the quarterly statement will not show it. Choose the nature (Alt+U) or mark the expense ledger ${kind.toUpperCase()}-applicable.`,
      'confirm',
    );
  }
}

interface DeducteePick {
  ledger: LedgerInfo | null;
  /** Ledger mode: the party's entry the deduction comes from (journal/purchase) or that is grossed up (payment). */
  entry: PlanEntry | null;
  ambiguous: boolean;
  problem: string | null;
}

function findDeductee(ctx: PostingAdjustContext, store: TdsStore, kind: TdsKind): DeducteePick {
  const m = ctx.masters;
  if (isInvoiceMode(ctx.mode)) {
    const p = ctx.party;
    if (!p || p.isCashBank) {
      return { ledger: null, entry: null, ambiguous: false, problem: `A cash ${kind === 'tds' ? 'purchase' : 'sale'} has no party to ${kind === 'tds' ? 'deduct TDS from' : 'collect TCS from'}: select the party ledger instead of Cash.` };
    }
    return { ledger: p, entry: ctx.entries.find((e) => e.source.kind === 'party') ?? null, ambiguous: false, problem: null };
  }
  // Ledger mode: party lines on the side the deductee is paid / credited.
  const wantDr = ctx.baseType === 'payment';
  store.preloadDetails(ctx.entries.map((e) => e.ledgerId));
  const cands = ctx.entries.filter((e) => {
    if (e.source.kind !== 'ledger' || (wantDr ? e.amount <= 0 : e.amount >= 0)) return false;
    const L = m.ledger(e.ledgerId);
    if (L.isCashBank || L.isGstDuty) return false;
    const det = store.detail(L.id);
    if (det?.payable_kind) return false;
    // Debtors / creditors, and ledgers given a deductee type (a partner's capital account for 194T,
    // an unsecured loan for 194A) — whether or not they also carry a default nature.
    return isPartyRole(L, det);
  });
  const ids = [...new Set(cands.map((e) => e.ledgerId))];
  if (ids.length === 1) {
    const entry = cands.reduce((a, e) => (Math.abs(e.amount) > Math.abs(a.amount) ? e : a));
    return { ledger: m.ledger(ids[0]), entry, ambiguous: false, problem: null };
  }
  if (ids.length > 1) {
    return {
      ledger: null,
      entry: null,
      ambiguous: true,
      problem: `TDS was not computed: ${ids.map((id) => m.ledger(id).name).join(', ')} are all ${wantDr ? 'debited' : 'credited'}. Enter one party per voucher.`,
    };
  }
  return { ledger: null, entry: null, ambiguous: false, problem: `TDS-applicable amounts were found but no party is ${wantDr ? 'debited' : 'credited'}: TDS was not computed.` };
}

function postLines(ctx: PostingAdjustContext, kind: TdsKind, lines: TdsVoucherLine[], deductee: DeducteePick): void {
  const total = lines.reduce((a, l) => a + l.amount, 0);
  if (total === 0) return;
  if (lines.some((l) => l.amount > 0 && l.payableLedgerId === null)) {
    // Preview before the first save: the duty ledger is created by the save (hook prepare).
    const names = [...new Set(lines.filter((l) => l.amount > 0 && l.payableLedgerId === null).map((l) => l.payableLedgerName))].join(', ');
    ctx.warn('tds', `${names} will be created when you save; the ${kind.toUpperCase()} of ${inr(total)} is posted then.`, 'info');
    return;
  }
  const m = ctx.masters;
  // Where the amount comes from (TDS) / goes to (TCS).
  let target: PlanEntry | null = null;
  if (kind === 'tcs') target = ctx.entries.find((e) => e.source.kind === 'party') ?? null;
  else if (isInvoiceMode(ctx.mode)) target = ctx.entries.find((e) => e.source.kind === 'party') ?? null;
  else if (ctx.baseType === 'payment') {
    const banks = ctx.entries.filter((e) => e.amount < 0 && m.ledger(e.ledgerId).isCashBank);
    target = banks.reduce<PlanEntry | null>((a, e) => (a === null || e.amount < a.amount ? e : a), null);
  } else target = deductee.entry;
  if (!target) {
    ctx.warn('tds', `There is no ${ctx.baseType === 'payment' ? 'cash/bank credit' : 'party credit'} to deduct ${inr(total)} of TDS from.`, 'block');
    return;
  }
  if (kind === 'tds' && Math.abs(target.amount) < total) {
    ctx.warn('tds', `TDS of ${inr(total)} is more than the ${inr(Math.abs(target.amount))} ${m.ledger(target.ledgerId).name} is credited with. Check the amounts or the override.`, 'block');
    return;
  }
  // TDS reduces a credit (+); TCS increases the party debit (+).
  ctx.adjustEntry(target, total);
  for (const l of lines) {
    if (l.amount <= 0 || l.payableLedgerId === null) continue;
    ctx.addEntry({
      ledgerId: l.payableLedgerId,
      amount: -l.amount,
      role: kind === 'tcs' ? 'charge' : 'other',
      narration: `${kind.toUpperCase()} u/s ${l.section} on ${inr(l.base)} @ ${l.rate}%`,
    });
  }
  if (kind === 'tcs') ctx.addToInvoiceValue(total);
}

/** Earlier credits of the period (party + nature), books filter, excluding this voucher. */
function priorFigures(db: Db, p: { party: number; nature: number; from: string; to: string; self: number; today: string }): { prior: Paise; undeducted: Paise } {
  const r = db.get<{ prior: number; below: number; caught: number }>(
    `SELECT COALESCE(SUM(assessable), 0) AS prior,
            COALESCE(SUM(CASE WHEN status = 'below_threshold' THEN assessable ELSE 0 END), 0) AS below,
            COALESCE(SUM(catch_up), 0) AS caught
       FROM tds_lines
      WHERE party_ledger_id = :party AND nature_id = :nature AND date >= :from AND date <= :to AND voucher_id <> :self
        AND affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`,
    p,
  );
  return { prior: r?.prior ?? 0, undeducted: Math.max(0, (r?.below ?? 0) - (r?.caught ?? 0)) };
}

function certificateUsed(db: Db, party: number, from: string, to: string, self: number, today: string): Paise {
  return (
    db.value<number>(
      `SELECT COALESCE(SUM(base), 0) FROM tds_lines
        WHERE party_ledger_id = :party AND status = 'certificate' AND date >= :from AND date <= :to AND voucher_id <> :self
          AND affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`,
      { party, from, to, self, today },
    ) ?? 0
  );
}

/**
 * Advances paid to the party under the nature on which tax was deducted (TDS lines of Payment vouchers
 * dated up to `to`, with tax or under a certificate) not yet set off by bills / journal credits (any
 * date — an advance is set off once), books filter. An advance below the threshold (nothing deducted)
 * is not set off: the bill is taxed in full when it is liable.
 */
function advanceOpen(db: Db, p: { party: number; nature: number; to: string; self: number; today: string }): Paise {
  const r = db.get<{ paid: number; used: number }>(
    `SELECT COALESCE(SUM(CASE WHEN v.base_type = 'payment' AND tl.date <= :to AND (tl.amount > 0 OR tl.status = 'certificate')
                              THEN tl.assessable ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN v.base_type <> 'payment' THEN tl.advance_adjusted ELSE 0 END), 0) AS used
       FROM tds_lines tl JOIN vouchers v ON v.id = tl.voucher_id
      WHERE tl.party_ledger_id = :party AND tl.nature_id = :nature AND tl.kind = 'tds' AND tl.voucher_id <> :self
        AND tl.affects_books = 1 AND (tl.is_post_dated = 0 OR tl.date <= :today)`,
    p,
  );
  return Math.max(0, (r?.paid ?? 0) - (r?.used ?? 0));
}

function checkChallan(ctx: PostingAdjustContext, store: TdsStore, c: VoucherTdsChallanInput): void {
  if (ctx.baseType !== 'payment' || ctx.mode !== 'ledger') {
    ctx.warn('tds', 'Challan details belong on a Payment voucher (TDS/TCS › Challan).', 'block', 'tds');
    return;
  }
  const payable = store.payableLedgerId(c.kind, c.section);
  const deposited = c.tax + (c.surcharge ?? 0) + (c.cess ?? 0);
  const name = payableLedgerName(c.kind, c.section);
  const dr = payable === null ? 0 : ctx.entries.filter((e) => e.ledgerId === payable && e.amount > 0).reduce((a, e) => a + e.amount, 0);
  if (dr !== deposited) {
    ctx.warn(
      'tds',
      `The challan deposits ${inr(deposited)} of ${c.kind.toUpperCase()} u/s ${c.section}, but this voucher debits ${name} with ${inr(dr)}. Make them equal.`,
      'confirm',
      'tds',
    );
  }
  // BSR code + deposit date + challan serial number is the challan identification number (CIN): the
  // same challan recorded twice would clear the month twice in the reports and the statement.
  const dup = ctx.env.db.get<{ number: string | null; date: string }>(
    `SELECT v.number, v.date FROM tds_challans c JOIN vouchers v ON v.id = c.voucher_id
      WHERE c.bsr_code = :bsr AND c.challan_no = :no AND c.deposit_date = :deposit AND c.voucher_id <> :self LIMIT 1`,
    { bsr: c.bsrCode, no: c.challanNo, deposit: c.depositDate, self: ctx.voucherId ?? 0 },
  );
  if (dup) {
    ctx.warn(
      'tds',
      `Challan ${c.challanNo} (BSR ${c.bsrCode}, deposited ${c.depositDate}) is already recorded on Payment ${dup.number ?? ''} of ${dup.date}. A challan is recorded once.`,
      'confirm',
      'tds',
    );
  }
  if (c.depositDate !== ctx.date) {
    ctx.warn('tds', `The challan's deposit date differs from the voucher date; interest is worked out from the deposit date.`, 'info', 'tds');
  }
}

// ───────────────────────────── prepare / write / clear ─────────────────────────────

export const tdsVoucherHook: VoucherHook = {
  name: 'tds',

  prepare(ctx, { env, input, voucherType }) {
    const w = wants(env.features, voucherType.baseType, input.mode);
    const challan = input.tds?.challan;
    if (!w.tds && !w.tcs && !challan) return;
    const db = env.db;
    if (challan) ensurePayableLedger(ctx, challan.kind, challan.section);
    if (!w.tds && !w.tcs) return;
    // Natures this voucher can touch: its ledgers', the party's default, the one chosen on the voucher.
    const ledgerIds = new Set<number>();
    for (const l of input.ledgers ?? []) ledgerIds.add(l.ledgerId);
    for (const it of input.items ?? []) if (it.ledgerId !== undefined) ledgerIds.add(it.ledgerId);
    if ((input.items?.length ?? 0) > 0) {
      const cfg = voucherType.config.defaultLedgerId;
      if (typeof cfg === 'number') ledgerIds.add(cfg);
      for (const id of db.all<{ id: number }>(`SELECT id FROM ledgers WHERE reserved_code IN ('SALES', 'PURCHASE')`)) ledgerIds.add(id.id);
    }
    if (input.partyLedgerId !== undefined) ledgerIds.add(input.partyLedgerId);
    const natureIds = new Set<number>(
      db
        .all<{ nature_id: number }>(
          `SELECT DISTINCT nature_id FROM tds_ledger_details WHERE nature_id IS NOT NULL AND ledger_id IN (SELECT value FROM json_each(:ids))`,
          { ids: JSON.stringify([...ledgerIds]) },
        )
        .map((r) => r.nature_id),
    );
    if (input.tds?.natureId !== undefined) natureIds.add(input.tds.natureId);
    if (natureIds.size === 0) return;
    const rows = db.all<{ kind: TdsKind; section: string }>(
      `SELECT DISTINCT kind, section FROM tds_natures WHERE id IN (SELECT value FROM json_each(:ids))`,
      { ids: JSON.stringify([...natureIds]) },
    );
    for (const r of rows) if ((r.kind === 'tds' && w.tds) || (r.kind === 'tcs' && w.tcs)) ensurePayableLedger(ctx, r.kind, r.section);
  },

  adjust,

  write(w: VoucherHookWriteContext) {
    const data = w.data as TdsHookData | undefined;
    if (!data) return;
    const books = w.affectsBooks ? 1 : 0;
    const pdc = w.isPostDated ? 1 : 0;
    data.lines.forEach((l, i) => {
      w.db.run(
        `INSERT INTO tds_lines (voucher_id, line_no, kind, nature_id, section, party_ledger_id, deductee_type, pan, pan_status, non_resident,
                assessable, catch_up, base, rate, computed, amount, overridden, reason, status, payable_ledger_id, note, date,
                affects_books, is_post_dated, advance_adjusted, bill_voucher_id)
         VALUES (:vid, :lineNo, :kind, :natureId, :section, :party, :type, :pan, :panStatus,
                 COALESCE((SELECT non_resident FROM tds_ledger_details WHERE ledger_id = :party), 0),
                 :assessable, :catchUp, :base, :rate, :computed, :amount, :overridden, :reason, :status, :payable, :note, :date, :books, :pdc,
                 :advance, :bill)`,
        {
          vid: w.voucherId,
          lineNo: i + 1,
          kind: l.kind,
          natureId: l.natureId,
          section: l.section,
          party: l.partyLedgerId,
          type: l.deducteeType,
          pan: l.pan,
          panStatus: l.panStatus,
          assessable: l.assessable,
          catchUp: l.catchUp,
          base: l.base,
          rate: l.rate,
          computed: l.computed,
          amount: l.amount,
          overridden: l.overridden ? 1 : 0,
          reason: l.reason,
          status: l.status,
          payable: l.payableLedgerId,
          note: l.note,
          date: w.date,
          books,
          pdc,
          advance: l.advanceAdjusted ?? 0,
          bill: l.billVoucherId ?? null,
        },
      );
    });
    const c = data.challan;
    if (c && w.plan.baseType === 'payment') {
      w.db.run(
        `INSERT INTO tds_challans (voucher_id, kind, section, period, bsr_code, challan_no, deposit_date, minor_head, tax, surcharge, cess,
                interest, fee, others, date, affects_books, is_post_dated)
         VALUES (:vid, :kind, :section, :period, :bsr, :no, :deposit, :minor, :tax, :surcharge, :cess, :interest, :fee, :others, :date, :books, :pdc)`,
        {
          vid: w.voucherId,
          kind: c.kind,
          section: c.section,
          period: c.period,
          bsr: c.bsrCode,
          no: c.challanNo,
          deposit: c.depositDate,
          minor: c.minorHead ?? '200',
          tax: c.tax,
          surcharge: c.surcharge ?? 0,
          cess: c.cess ?? 0,
          interest: c.interest ?? 0,
          fee: c.fee ?? 0,
          others: c.others ?? 0,
          date: w.date,
          books,
          pdc,
        },
      );
    }
  },

  clear(db, voucherId) {
    db.run('DELETE FROM tds_lines WHERE voucher_id = :id', { id: voucherId });
    db.run('DELETE FROM tds_challans WHERE voucher_id = :id', { id: voucherId });
  },

  preview(data) {
    const d = data as TdsHookData | undefined;
    if (!d) return {};
    const tds: TdsVoucherPreview = {
      lines: d.lines,
      tds: d.lines.filter((l) => l.kind === 'tds').reduce((a, l) => a + l.amount, 0),
      tcs: d.lines.filter((l) => l.kind === 'tcs').reduce((a, l) => a + l.amount, 0),
      challan: d.challan,
    };
    return { tds };
  },
};

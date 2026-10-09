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
 *     ledger with a deductee type) on the credit side (payment: debit side).
 *   - Posting: Cr 'TDS Payable – <section>' and the deductee gets that much less: purchase / journal →
 *     the party's credit is reduced; payment → the cash/bank credit is reduced (the party is debited
 *     with the gross). Bill-wise allocations typed for the gross are rescaled to the net.
 * TCS (F11 › TCS on): sales invoices (item / accounting mode). Lines whose sales ledger has a TCS
 * nature; Dr party += TCS, Cr 'TCS Payable'; the invoice value includes the TCS.
 * Overrides: `input.tds.overrides` (amount + reason) replace the computed amount per nature.
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
  if (!w.tds && !w.tcs && !challan) return;
  const store = new TdsStore(ctx.env.db);
  const lines: TdsVoucherLine[] = [];
  if (w.tds) lines.push(...computeKind(ctx, store, 'tds'));
  if (w.tcs) lines.push(...computeKind(ctx, store, 'tcs'));
  if (challan) checkChallan(ctx, store, challan);
  if (lines.length > 0 || challan) ctx.setData({ lines, challan } satisfies TdsHookData);
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
  if (buckets.size === 0) return [];

  if (!deductee.ledger) {
    ctx.warn('tds', deductee.problem ?? `No party to ${kind === 'tds' ? 'deduct TDS from' : 'collect TCS from'}.`, deductee.ambiguous ? 'confirm' : 'info');
  }
  const d: Deductee | null = deductee.ledger ? store.deductee(deductee.ledger.id) : null;
  const settings = store.settings();
  const out: TdsVoucherLine[] = [];

  for (const b of buckets.values()) {
    const nature = store.nature(b.natureId) as NatureRow;
    const rateRow = store.rateOn(nature.id, ctx.date);
    if (!rateRow) {
      ctx.warn('tds', `${nature.section} ${nature.name}: no rate is in force on this date. Add a rate in TDS/TCS › Natures.`, 'confirm');
      continue;
    }
    if (nature.section === '194Q' && !settings.buyer194Q) continue; // buyer below ₹10 crore: 194Q does not apply.
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
    const cert = d.certificate && d.certificate.from <= ctx.date && ctx.date <= d.certificate.to && (d.certificate.natureId === null || d.certificate.natureId === nature.id) ? d.certificate : null;
    const certUsed = cert ? certificateUsed(ctx.env.db, d.ledgerId, cert.from, cert.to, ctx.voucherId ?? 0, ctx.env.today) : 0;
    const res = computeTds({
      rate,
      deducteeType: d.type,
      panOk: d.panStatus === 'valid',
      assessable,
      prior: prior.prior,
      priorUndeducted: prior.undeducted,
      certificate: cert ? { number: cert.number, rate: cert.rate, remaining: cert.limit === null ? null : Math.max(0, cert.limit - certUsed) } : null,
      roundToRupee: settings.roundToRupee,
      verb: kind === 'tds' ? 'deduct' : 'collect',
    });
    Object.assign(line, { catchUp: res.catchUp, base: res.base, rate: res.rate, computed: res.amount, amount: res.amount, status: res.status, note: res.note });
    if (d.typeAssumed && res.liable) {
      line.note += ` Deductee type not set on ${d.name}: taken as ${d.type}.`;
    }
    const ov = tdsIn.overrides?.find((o) => o.natureId === nature.id);
    if (ov) {
      line.overridden = ov.amount !== res.amount;
      line.reason = ov.reason.trim();
      line.amount = ov.amount;
      if (ov.amount === 0) line.status = res.liable ? 'overridden_nil' : 'below_threshold';
      else {
        if (line.base === 0) line.base = assessable;
        if (line.status === 'below_threshold') line.status = 'deducted';
        if (line.overridden && line.base > 0) line.rate = Math.round((ov.amount / line.base) * 100 * 10_000) / 10_000;
      }
      if (line.overridden) line.note += ` Changed from ${inr(res.amount)} to ${inr(ov.amount)}: ${line.reason}`;
    }
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
  postLines(ctx, kind, out, deductee);
  return out;
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
    if (det?.applicable === 1 && !L.isDebtor && !L.isCreditor) return false;
    return L.isDebtor || L.isCreditor || (det?.deductee_type ?? null) !== null;
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
                affects_books, is_post_dated)
         VALUES (:vid, :lineNo, :kind, :natureId, :section, :party, :type, :pan, :panStatus,
                 COALESCE((SELECT non_resident FROM tds_ledger_details WHERE ledger_id = :party), 0),
                 :assessable, :catchUp, :base, :rate, :computed, :amount, :overridden, :reason, :status, :payable, :note, :date, :books, :pdc)`,
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

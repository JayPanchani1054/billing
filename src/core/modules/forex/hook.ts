/**
 * Forex voucher hook (vouchers/hooks.ts extension point). Books stay in INR; a ledger kept in a foreign
 * currency is entered in that currency and the INR posted is derived from the rate of exchange.
 *
 *   compose  (preview + save) F11 › Multiple currencies must be on for any forex field. Converts:
 *            - invoice modes with VoucherInput.forex (document currency = the party's currency):
 *              item `forexRate` (default: the typed `rate`, which is then in the document currency) and
 *              `forexAmount` → INR `rate` and `amount` (gross = round(qty × forexRate) in the currency,
 *              then × rate to the paisa); ledger lines `forexAmount` → `amount`. Rates are exclusive of
 *              GST (rateInclusiveOfTax is cleared). exportDetails.currency / exchangeRate are filled.
 *            - ledger mode: every line of a foreign-currency ledger must carry `forexAmount` (0 = an
 *              INR-only exchange adjustment); `amount` = forexAmount × rate (line `exchangeRate`, else
 *              VoucherInput.forex.rate of the same currency, else the master rate of the date).
 *   prepare  (save) creates the system 'Forex Gain/Loss' ledger when needed.
 *   adjust   (preview + save) puts the foreign amount on each foreign-ledger entry (invoice party:
 *            Σ lines in the currency + the INR remainder — GST / TCS payable by the party — at the
 *            rate), and for bill-wise entries with allocations carries every settled bill at the INR
 *            it was booked at: the difference to the voucher's rate is the REALISED exchange
 *            gain / loss, posted in the same voucher to the configured gain/loss ledger (Dr = loss).
 *   write    stores currency / forex amount / rate on ledger_entries, bill_allocations and vouchers.
 *   clear    clears the header columns (child rows are rewritten by the vouchers module).
 */
import { ACCOUNTING_BASE_TYPES } from '../../../shared/constants.ts';
import {
  allocateForex,
  bookedPaise,
  defaultRateType,
  forexToPaise,
  formatExchangeRate,
  formatForex,
  paiseToForex,
  pickRate,
  roundForex,
  roundRate,
  sumForex,
  toMinor,
} from '../../../shared/forex.ts';
import { formatMoney } from '../../../shared/format.ts';
import { taxAt } from '../../../shared/gst/engine.ts';
import { allocate, type Paise } from '../../../shared/money.ts';
import type { ForexCurrency, ForexEntryView, ForexRealisedLine, ForexVoucherPreview } from '../../../shared/types/forex.ts';
import type { BillAllocationInput, ItemLineInput, LedgerLineInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import type { PostingAdjustContext, VoucherHook, VoucherHookWriteContext } from '../vouchers/hooks.ts';
import type { PlanEntry, PostingEnv } from '../vouchers/posting.ts';
import { allCurrencies, ensureForexLedger, foreignLedgerCurrencies, getForexSettings, pendingForexBills, rateRowOn, realisedLedgerId } from './store.ts';

const inr = (p: Paise): string => formatMoney(p, { symbol: true });
const fieldError = (path: string, message: string) => validation([{ path, message }]);
const isInvoiceMode = (mode: VoucherInput['mode']): boolean => mode === 'item_invoice' || mode === 'accounting_invoice';

/** Does the input carry any forex field? */
export function hasForexFields(input: VoucherInput): boolean {
  if (input.forex) return true;
  if ((input.items ?? []).some((i) => i.forexRate !== undefined || i.forexAmount !== undefined)) return true;
  if ((input.partyBillAllocations ?? []).some((a) => a.forexAmount !== undefined)) return true;
  return (input.ledgers ?? []).some(
    (l) => l.forexAmount !== undefined || l.exchangeRate !== undefined || (l.billAllocations ?? []).some((a) => a.forexAmount !== undefined),
  );
}

function firstForexPath(input: VoucherInput): string {
  if (input.forex) return 'forex';
  const i = (input.items ?? []).findIndex((x) => x.forexRate !== undefined || x.forexAmount !== undefined);
  if (i >= 0) return `items[${i}]`;
  const l = (input.ledgers ?? []).findIndex((x) => x.forexAmount !== undefined || x.exchangeRate !== undefined || (x.billAllocations ?? []).some((a) => a.forexAmount !== undefined));
  if (l >= 0) return `ledgers[${l}].forexAmount`;
  return 'partyBillAllocations';
}

function ledgerName(db: Db, id: number): string {
  return db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id }) ?? `ledger ${id}`;
}

function roundAllocations(list: BillAllocationInput[] | undefined, dp: number): BillAllocationInput[] | undefined {
  if (!list) return list;
  return list.map((a) => (a.forexAmount === undefined ? a : { ...a, forexAmount: Math.abs(roundForex(a.forexAmount, dp)) }));
}

// ───────────────────────────── compose ─────────────────────────────

function compose(env: PostingEnv, input: VoucherInput): VoucherInput | undefined {
  const db = env.db;
  if (!env.features.multiCurrency) {
    if (hasForexFields(input)) {
      throw fieldError(firstForexPath(input), 'Multiple currencies is turned off for this company (F11 › Features). Turn it on to enter amounts in a foreign currency.');
    }
    return undefined;
  }
  const currencies = allCurrencies(db);
  let doc: { currency: ForexCurrency; rate: number } | null = null;
  if (input.forex) {
    const cur = currencies.get(input.forex.currencyId);
    if (!cur) throw fieldError('forex.currencyId', 'The selected currency does not exist.');
    if (cur.isBase) throw fieldError('forex.currencyId', `${cur.formalName} is the base currency of the books; choose a foreign currency, or remove the currency from the voucher.`);
    if (!(input.forex.rate > 0)) throw fieldError('forex.rate', `Enter the rate of exchange: rupees for one ${cur.formalName}.`);
    doc = { currency: cur, rate: roundRate(input.forex.rate) };
  }
  const ledgerIds = [...(input.ledgers ?? []).map((l) => l.ledgerId), ...(input.partyLedgerId ? [input.partyLedgerId] : [])];
  const ledgerCur = foreignLedgerCurrencies(db, ledgerIds);

  if (isInvoiceMode(input.mode)) {
    const partyCur = input.partyLedgerId !== undefined ? ledgerCur.get(input.partyLedgerId) : undefined;
    if (partyCur !== undefined) {
      const pc = currencies.get(partyCur) as ForexCurrency;
      if (!doc) {
        throw fieldError('forex', `${ledgerName(db, input.partyLedgerId as number)} is kept in ${pc.formalName}: enter the invoice in ${pc.symbol} with its rate of exchange.`);
      }
      if (doc.currency.id !== partyCur) {
        throw fieldError('forex.currencyId', `${ledgerName(db, input.partyLedgerId as number)} is kept in ${pc.formalName}; this invoice is in ${doc.currency.formalName}. Use the party's currency.`);
      }
    } else if (doc) {
      const who = input.partyLedgerId !== undefined ? ledgerName(db, input.partyLedgerId) : 'The party';
      throw fieldError(
        'forex.currencyId',
        `${who} is kept in rupees. To bill in ${doc.currency.formalName}, set the currency of the party ledger to ${doc.currency.formalName} (Ledger › Currency) first.`,
      );
    }
    if (!doc) {
      if (hasForexFields(input)) throw fieldError(firstForexPath(input), 'Foreign amounts need the invoice currency and rate of exchange.');
      return undefined;
    }
    const { currency, rate } = doc;
    const dp = currency.decimalPlaces;
    const items = input.items?.map((it): ItemLineInput => {
      const forexRate = it.forexRate ?? it.rate ?? 0;
      const qty = it.billedQty ?? it.qty;
      const gross = it.forexAmount !== undefined ? roundForex(it.forexAmount, dp) : roundForex(qty * forexRate, dp);
      return {
        ...it,
        forexRate,
        ...(it.forexAmount !== undefined ? { forexAmount: gross } : {}),
        rate: roundRate(forexRate * rate),
        amount: forexToPaise(gross, dp, rate),
        rateInclusiveOfTax: false,
      };
    });
    const ledgers = input.ledgers?.map((l): LedgerLineInput => {
      const fx = l.forexAmount !== undefined ? roundForex(l.forexAmount, dp) : paiseToForex(l.amount, rate, dp);
      return { ...l, forexAmount: fx, amount: forexToPaise(fx, dp, rate) };
    });
    const out: VoucherInput = { ...input, forex: { ...input.forex, currencyId: currency.id, rate } };
    if (items) out.items = items;
    if (ledgers) out.ledgers = ledgers;
    if (input.partyBillAllocations) out.partyBillAllocations = roundAllocations(input.partyBillAllocations, dp);
    if (input.exportDetails) {
      const code = currency.isoCode ?? (currency.symbol.length <= 3 ? currency.symbol : undefined);
      out.exportDetails = { ...input.exportDetails, ...(code ? { currency: code } : {}), exchangeRate: rate };
    }
    return out;
  }

  if (input.mode !== 'ledger') {
    if (hasForexFields(input)) throw fieldError(firstForexPath(input), 'Foreign-currency amounts apply to accounting vouchers and invoices only.');
    return undefined;
  }

  // Ledger mode: each line of a foreign-currency ledger in its own currency.
  let changed = false;
  const ledgers = (input.ledgers ?? []).map((l, i): LedgerLineInput => {
    const lc = ledgerCur.get(l.ledgerId);
    if (lc === undefined) {
      if (l.forexAmount !== undefined || l.exchangeRate !== undefined || (l.billAllocations ?? []).some((a) => a.forexAmount !== undefined)) {
        throw fieldError(
          `ledgers[${i}].forexAmount`,
          `${ledgerName(db, l.ledgerId)} is kept in rupees; a foreign amount can be entered only for a ledger kept in a foreign currency (Ledger › Currency).`,
        );
      }
      return l;
    }
    const cur = currencies.get(lc) as ForexCurrency;
    if (l.forexAmount === undefined) {
      throw fieldError(
        `ledgers[${i}].forexAmount`,
        `${ledgerName(db, l.ledgerId)} is kept in ${cur.formalName}: enter the amount in ${cur.symbol} (or 0 for an exchange adjustment in rupees only).`,
      );
    }
    changed = true;
    const fx = roundForex(l.forexAmount, cur.decimalPlaces);
    const allocations = roundAllocations(l.billAllocations, cur.decimalPlaces);
    if (fx === 0) {
      // INR-only exchange adjustment: the amount stays as typed.
      const { exchangeRate: _drop, ...rest } = l;
      return { ...rest, forexAmount: 0, ...(allocations ? { billAllocations: allocations } : {}) };
    }
    let rate = l.exchangeRate;
    if (rate === undefined && doc && doc.currency.id === lc) rate = doc.rate;
    if (rate === undefined) {
      const fromMaster = pickRate(rateRowOn(db, lc, input.date), defaultRateType(baseTypeOf(db, input.voucherTypeId)));
      if (fromMaster === null) {
        throw fieldError(`ledgers[${i}].exchangeRate`, `Enter the rate of exchange for ${cur.formalName} (no rate is recorded in Currencies › Rates of Exchange on or before this date).`);
      }
      rate = fromMaster;
    }
    if (!(rate > 0)) throw fieldError(`ledgers[${i}].exchangeRate`, `Enter the rate of exchange: rupees for one ${cur.formalName}.`);
    rate = roundRate(rate);
    return { ...l, forexAmount: fx, exchangeRate: rate, amount: forexToPaise(fx, cur.decimalPlaces, rate), ...(allocations ? { billAllocations: allocations } : {}) };
  });
  if (!changed && !doc) return undefined;
  const out: VoucherInput = { ...input, ledgers };
  if (doc && input.forex) out.forex = { ...input.forex, rate: doc.rate };
  return out;
}

function baseTypeOf(db: Db, voucherTypeId: number): string {
  return db.value<string>('SELECT base_type FROM voucher_types WHERE id = :id', { id: voucherTypeId }) ?? 'journal';
}

// ───────────────────────────── adjust ─────────────────────────────

interface EntryForexData {
  entry: PlanEntry;
  view: ForexEntryView;
}

/** What adjust() hands to write() / preview(). */
export interface ForexHookData {
  currency: ForexCurrency | null;
  rate: number | null;
  documentForex: number | null;
  itemForex: Array<number | null>;
  ledgerForex: Array<number | null>;
  entries: EntryForexData[];
  realised: ForexRealisedLine[];
  gainLoss: Paise;
  gainLossLedger: { id: number; name: string } | null;
  decimals: Map<number, number>;
}

function adjust(ctx: PostingAdjustContext): void {
  if (!ctx.env.features.multiCurrency) return;
  const db = ctx.env.db;
  const input = ctx.input;
  const invoice = isInvoiceMode(ctx.mode);
  if (!invoice && ctx.mode !== 'ledger') return;
  const ledgerCur = foreignLedgerCurrencies(db, ctx.entries.map((e) => e.ledgerId));
  if (ledgerCur.size === 0 && !input.forex) return;
  const currencies = allCurrencies(db);
  const docCur = input.forex ? (currencies.get(input.forex.currencyId) ?? null) : null;
  const data: ForexHookData = {
    currency: docCur,
    rate: input.forex?.rate ?? null,
    documentForex: null,
    itemForex: [],
    ledgerForex: [],
    entries: [],
    realised: [],
    gainLoss: 0,
    gainLossLedger: null,
    decimals: new Map([...currencies.values()].map((c) => [c.id, c.decimalPlaces])),
  };

  const forexEntries: Array<{ entry: PlanEntry; currency: ForexCurrency; amount: number; rate: number | null; typed: BillAllocationInput[] | undefined; path: string; lineIndex: number | null }> = [];

  if (invoice && docCur && input.forex) {
    const dp = docCur.decimalPlaces;
    const rate = input.forex.rate;
    // Lines in the document currency (compose made every line carry its forex value).
    let linesInr = 0;
    const lineForex: number[] = [];
    data.itemForex = (input.items ?? []).map((it) => {
      const gross = it.forexAmount ?? roundForex((it.billedQty ?? it.qty) * (it.forexRate ?? 0), dp);
      const d = it.discountPct ?? 0;
      const net = d ? roundForex((gross * (100 - d)) / 100, dp) : gross;
      const grossInr = it.amount ?? 0;
      linesInr += d ? taxAt(grossInr, 100 - d) : grossInr;
      lineForex.push(net);
      return net;
    });
    data.ledgerForex = (input.ledgers ?? []).map((l) => {
      const fx = l.forexAmount ?? 0;
      linesInr += l.amount;
      lineForex.push(fx);
      return fx;
    });
    const party = ctx.entries.find((e) => e.source.kind === 'party');
    if (party) {
      const sign = party.amount < 0 ? -1 : 1;
      const roundOff = -sign * ctx.entries.filter((e) => e.source.kind === 'round_off').reduce((a, e) => a + e.amount, 0);
      const partyInr = sign * party.amount; // the invoice value G (+ TCS etc.)
      const residualInr = partyInr - roundOff - linesInr; // GST / TCS payable by the party
      const docForex = sumForex([...lineForex, paiseToForex(residualInr, rate, dp)], dp);
      data.documentForex = docForex;
      if (ledgerCur.get(party.ledgerId) === docCur.id) {
        forexEntries.push({ entry: party, currency: docCur, amount: sign * docForex, rate, typed: input.partyBillAllocations, path: 'partyBillAllocations', lineIndex: null });
      }
    } else if (ctx.invoiceValue !== null) {
      // Orders / notes / quotations priced in the currency: no party entry, the document value only.
      data.documentForex = sumForex([...lineForex, paiseToForex(ctx.invoiceValue - linesInr, rate, dp)], dp);
    }
    const other = ctx.entries.filter((e) => e.source.kind !== 'party' && ledgerCur.has(e.ledgerId));
    if (other.length > 0) {
      ctx.warn('forex', `${[...new Set(other.map((e) => ctx.masters.ledger(e.ledgerId).name))].join(', ')} ${other.length === 1 ? 'is' : 'are'} kept in a foreign currency but posted in rupees only on this invoice (only the party is entered in the invoice currency).`, 'info');
    }
  } else if (ctx.mode === 'ledger') {
    for (const e of ctx.entries) {
      if (e.source.kind !== 'ledger') continue;
      const lc = ledgerCur.get(e.ledgerId);
      if (lc === undefined) continue;
      const line = input.ledgers?.[e.source.index];
      if (!line || line.forexAmount === undefined) continue;
      const cur = currencies.get(lc) as ForexCurrency;
      let fx = line.forexAmount;
      // Another hook (TDS) changed the rupee amount: the foreign amount follows in proportion.
      if (e.originalAmount !== undefined && e.originalAmount !== 0 && fx !== 0) {
        fx = roundForex((fx * e.amount) / e.originalAmount, cur.decimalPlaces);
        ctx.warn('forex', `${cur.symbol} amount of ${ctx.masters.ledger(e.ledgerId).name} adjusted to ${formatForex(Math.abs(fx), cur.decimalPlaces, cur.symbol)} after the tax deducted.`, 'info', `ledgers[${e.source.index}].forexAmount`);
      }
      forexEntries.push({
        entry: e,
        currency: cur,
        amount: fx,
        rate: fx === 0 ? null : (line.exchangeRate ?? null),
        typed: line.billAllocations,
        path: `ledgers[${e.source.index}].billAllocations`,
        lineIndex: e.source.index,
      });
    }
  }

  // Bill-wise: carry settled bills at their booked INR; the difference is the realised gain / loss.
  // preset: settled bills at the rupees they are carried at; atRate: every bill at the voucher's rate
  // (used when the difference cannot be posted yet — preview before the gain/loss ledger exists).
  type Plan = { fe: (typeof forexEntries)[number]; preset: BillAllocationInput[]; atRate: BillAllocationInput[]; diff: Paise };
  const plans: Plan[] = [];
  const pendingCache = new Map<number, Map<string, ReturnType<typeof pendingForexBills>[number]>>();
  const pendingFor = (ledgerId: number, dp: number) => {
    let m = pendingCache.get(ledgerId);
    if (!m) {
      m = new Map(pendingForexBills(db, ledgerId, ctx.date, ctx.env.today, dp, ctx.voucherId).map((b) => [b.billName, b]));
      pendingCache.set(ledgerId, m);
    }
    return m;
  };
  for (const fe of forexEntries) {
    ctx.setForex(fe.entry, { currencyId: fe.currency.id, amount: fe.amount, rate: fe.rate });
    const L = ctx.masters.ledger(fe.entry.ledgerId);
    const typed = fe.typed;
    if (!ctx.env.features.billWise || !L.billWise || !typed || typed.length === 0 || fe.amount === 0 || fe.rate === null) continue;
    const dp = fe.currency.decimalPlaces;
    const absF = Math.abs(fe.amount);
    // Foreign amount of each allocation: as typed, else in proportion to the rupees typed.
    let shares: number[];
    if (typed.every((a) => a.forexAmount !== undefined)) {
      shares = typed.map((a) => a.forexAmount as number);
      const sum = sumForex(shares, dp);
      if (toMinor(sum, dp) !== toMinor(absF, dp)) {
        ctx.warn(
          'forex',
          `Bill-wise details of ${L.name} total ${formatForex(sum, dp, fe.currency.symbol)} but its amount is ${formatForex(absF, dp, fe.currency.symbol)}.`,
          'block',
          fe.path,
        );
        continue;
      }
    } else {
      shares = allocateForex(absF, typed.map((a) => a.amount), dp);
      ctx.warn('forex', `Bill-wise ${fe.currency.symbol} amounts of ${L.name} were taken in proportion to the rupee amounts; enter them in ${fe.currency.symbol} to be exact.`, 'info', fe.path);
    }
    const absL = Math.abs(fe.entry.amount);
    const atRate = allocate(absL, shares.map((s) => toMinor(s, dp)));
    const pend = pendingFor(L.id, dp);
    let diff = 0;
    const sign = fe.entry.amount < 0 ? -1 : 1;
    const preset = typed.map((a, k): BillAllocationInput => {
      let amount = atRate[k];
      const name = a.billName?.trim();
      if (a.refType === 'against' && name) {
        const p = pend.get(name);
        // A bill of the other side carrying a foreign amount: settle it at the INR it is carried at.
        if (p && p.forexAmount !== 0 && Math.sign(p.amount || p.forexAmount) === -sign) {
          const booked = Math.abs(bookedPaise(p.amount, p.forexAmount, shares[k], dp));
          if (booked !== amount) {
            const d = amount - booked;
            diff += d;
            data.realised.push({
              ledgerId: L.id,
              ledgerName: L.name,
              billName: name,
              forexAmount: shares[k],
              bookedAmount: booked,
              settledAmount: amount,
              difference: sign * d,
            });
            amount = booked;
          }
        }
      }
      return { ...a, amount, forexAmount: shares[k] };
    });
    plans.push({ fe, preset, atRate: typed.map((a, k) => ({ ...a, amount: atRate[k], forexAmount: shares[k] })), diff });
  }

  const total = plans.reduce((a, p) => a + (p.fe.entry.amount < 0 ? -1 : 1) * p.diff, 0);
  const glId = realisedLedgerId(db);
  if (total !== 0 && glId === undefined) {
    // Preview before the gain/loss ledger exists (it is created by the save, hook prepare).
    ctx.warn('forex', `A realised exchange difference of ${inr(Math.abs(total))} (${total > 0 ? 'loss' : 'gain'}) will be posted to ${'Forex Gain/Loss'}, created when you save.`, 'info');
    // The entry stays at the voucher's rate, so its bills do too (they add up to the entry).
    for (const p of plans) ctx.setBillAllocations(p.fe.entry, p.diff === 0 ? p.preset : p.atRate);
  } else {
    for (const p of plans) {
      const sign = p.fe.entry.amount < 0 ? -1 : 1;
      if (p.diff !== 0) ctx.adjustEntry(p.fe.entry, -sign * p.diff);
      ctx.setBillAllocations(p.fe.entry, p.preset);
    }
    if (total !== 0 && glId !== undefined) {
      const gl = ctx.masters.ledger(glId);
      const bills = [...new Set(data.realised.map((r) => r.billName))].join(', ');
      ctx.addEntry({ ledgerId: glId, amount: total, role: 'other', narration: `Exchange difference on ${bills}` });
      data.gainLoss = total;
      data.gainLossLedger = { id: gl.id, name: gl.name };
      ctx.warn(
        'forex',
        `Realised exchange ${total > 0 ? 'loss' : 'gain'} of ${inr(Math.abs(total))} posted to ${gl.name} (bills settled at ${formatExchangeRate(plans[0].fe.rate ?? 0)} against the rate they were booked at).`,
        'info',
      );
    }
  }

  data.entries = forexEntries.map((fe) => ({
    entry: fe.entry,
    view: {
      source: fe.lineIndex === null ? 'party' : 'line',
      lineIndex: fe.lineIndex,
      ledgerId: fe.entry.ledgerId,
      ledgerName: ctx.masters.ledger(fe.entry.ledgerId).name,
      currencyId: fe.currency.id,
      forexAmount: fe.amount,
      rate: fe.rate,
      amount: fe.entry.amount,
      bills: [],
    },
  }));
  ctx.setData(data);
}

// ───────────────────────────── write / preview / clear ─────────────────────────────

/** Foreign amount of each bill of an entry: as allocated, else in proportion to the rupees. */
function billForex(entry: PlanEntry, dp: number): number[] {
  const fx = entry.forex;
  if (!fx || entry.bills.length === 0) return [];
  if (entry.bills.every((b) => b.forexAmount !== undefined)) return entry.bills.map((b) => b.forexAmount as number);
  if (fx.amount === 0) return entry.bills.map(() => 0);
  const parts = allocateForex(Math.abs(fx.amount), entry.bills.map((b) => Math.abs(b.amount)), dp);
  const sign = fx.amount < 0 ? -1 : 1;
  return parts.map((p) => sign * p);
}

function write(w: VoucherHookWriteContext): void {
  const data = w.data as ForexHookData | undefined;
  const { db, voucherId, plan } = w;
  if (!data) {
    db.run('UPDATE vouchers SET currency_id = NULL, exchange_rate = NULL, forex_amount = NULL WHERE id = :id AND currency_id IS NOT NULL', { id: voucherId });
    return;
  }
  plan.entries.forEach((e, i) => {
    if (!e.forex) return;
    const entryId = db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :v AND line_no = :n', { v: voucherId, n: i + 1 });
    if (entryId === undefined) return;
    db.run('UPDATE ledger_entries SET currency_id = :c, forex_amount = :f, exchange_rate = :r WHERE id = :id', {
      c: e.forex.currencyId,
      f: e.forex.amount,
      r: e.forex.rate,
      id: entryId,
    });
    if (e.bills.length === 0) return;
    const dp = data.decimals.get(e.forex.currencyId) ?? 2;
    const forex = billForex(e, dp);
    const ids = db.all<{ id: number }>('SELECT id FROM bill_allocations WHERE ledger_entry_id = :e ORDER BY id', { e: entryId });
    ids.forEach((row, k) => {
      db.run('UPDATE bill_allocations SET forex_amount = :f, currency_id = :c WHERE id = :id', { f: forex[k] ?? 0, c: e.forex?.currencyId ?? null, id: row.id });
    });
  });
  if (data.currency && data.rate !== null) {
    db.run('UPDATE vouchers SET currency_id = :c, exchange_rate = :r, forex_amount = :f WHERE id = :id', {
      c: data.currency.id,
      r: data.rate,
      f: data.documentForex,
      id: voucherId,
    });
  } else {
    db.run('UPDATE vouchers SET currency_id = NULL, exchange_rate = NULL, forex_amount = NULL WHERE id = :id AND currency_id IS NOT NULL', { id: voucherId });
  }
}

function preview(raw: unknown): { forex?: ForexVoucherPreview } {
  const data = raw as ForexHookData | undefined;
  if (!data) return {};
  const entries = data.entries.map(({ entry, view }) => {
    const dp = data.decimals.get(view.currencyId) ?? 2;
    const fx = billForex(entry, dp);
    return {
      ...view,
      amount: entry.amount,
      bills: entry.bills.map((b, k) => ({ refType: b.refType, billName: b.billName, amount: b.amount, forexAmount: fx[k] ?? 0 })),
    };
  });
  return {
    forex: {
      currency: data.currency,
      rate: data.rate,
      documentForex: data.documentForex,
      itemForex: data.itemForex,
      ledgerForex: data.ledgerForex,
      entries,
      realised: data.realised,
      gainLoss: data.gainLoss,
      gainLossLedger: data.gainLossLedger,
    },
  };
}

export const forexVoucherHook: VoucherHook = {
  name: 'forex',

  compose(env, input) {
    return compose(env, input);
  },

  prepare(ctx, { env, input }) {
    if (!env.features.multiCurrency || !hasForexFields(input)) return;
    const s = getForexSettings(env.db);
    if (s.gainLossLedgerId === null) ensureForexLedger(env.db, ctx.clock.now().toISOString(), ctx.audit);
  },

  adjust,
  write,
  preview,

  clear(db, voucherId) {
    db.run('UPDATE vouchers SET currency_id = NULL, exchange_rate = NULL, forex_amount = NULL WHERE id = :id AND currency_id IS NOT NULL', { id: voucherId });
  },
};

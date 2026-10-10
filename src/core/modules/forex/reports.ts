/**
 * Forex reports: outstanding bills in both currencies (with the closing-rate value and the unrealised
 * difference), a ledger's vouchers in both currencies, and the period-end revaluation (unrealised
 * exchange gain / loss) with the "Forex adjustment" journal helper.
 *
 * Books filter everywhere: affects_books = 1 AND (is_post_dated = 0 OR date <= today), date <= asOf.
 */
import { addDays, diffDays, formatDate } from '../../../shared/dates.ts';
import { forexToPaise, roundForex, sumForex, toMinor, type ForexRateType } from '../../../shared/forex.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  ForexCurrency,
  ForexLedgerInput,
  ForexLedgerStatement,
  ForexOutstandingBill,
  ForexOutstandingInput,
  ForexOutstandingParty,
  ForexOutstandingResult,
  ForexRevaluationInput,
  ForexRevaluationLine,
  ForexRevaluationPostInput,
  ForexRevaluationPostResult,
  ForexRevaluationResult,
} from '../../../shared/types/forex.ts';
import type { BillAllocationInput, LedgerLineInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { getFeatures } from '../company/service.ts';
import { particularsFor } from '../reports/ledger.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { assertForexEnabled } from './service.ts';
import { allCurrencies, ensureForexLedger, getForexSettings, pendingForexBills, rateOn, unrealisedLedgerId } from './store.ts';

const BOOKS = `affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`;

interface ForeignLedger {
  id: number;
  name: string;
  currencyId: number;
  billWise: boolean;
  openingInr: Paise;
  openingForex: number;
  debtor: boolean;
  creditor: boolean;
  /**
   * A monetary item (AS 11 para 7 / Ind AS 21 para 8: money held and assets / liabilities to be
   * received or paid in a fixed number of units of currency): Balance Sheet ledgers outside the
   * non-monetary groups below. Only these are restated at the closing rate.
   */
  monetary: boolean;
}

/** Groups whose ledgers are non-monetary (carried at the historical rate, never revalued). */
const NON_MONETARY_GROUPS = new Set(['FIXED_ASSETS', 'INVESTMENTS', 'STOCK_IN_HAND', 'CAPITAL_ACCOUNT', 'MISC_EXPENSES_ASSET']);

function foreignLedgers(db: Db, filter: { ledgerId?: number; currencyId?: number }): ForeignLedger[] {
  const billWiseOn = getFeatures(db).billWise;
  const rows = db.all<{
    id: number;
    name: string;
    currency_id: number;
    maintain_bill_wise: number;
    opening_balance: number;
    opening_forex_amount: number | null;
    group_codes: string | null;
    nature: string;
  }>(
    `WITH RECURSIVE chain(ledger_id, group_id) AS (
         SELECT l.id, l.group_id FROM ledgers l JOIN currencies c ON c.id = l.currency_id WHERE c.is_base = 0
         UNION ALL
         SELECT chain.ledger_id, g.parent_id FROM chain JOIN groups g ON g.id = chain.group_id WHERE g.parent_id IS NOT NULL
       )
     SELECT l.id, l.name, l.currency_id, l.maintain_bill_wise, l.opening_balance, l.opening_forex_amount,
            (SELECT g.nature FROM groups g WHERE g.id = l.group_id) AS nature,
            (SELECT group_concat(g.reserved_code) FROM chain JOIN groups g ON g.id = chain.group_id
              WHERE chain.ledger_id = l.id AND g.reserved_code IS NOT NULL) AS group_codes
       FROM ledgers l JOIN currencies c ON c.id = l.currency_id
      WHERE c.is_base = 0
      ORDER BY l.name`,
  );
  return rows
    .filter((r) => (filter.ledgerId === undefined || r.id === filter.ledgerId) && (filter.currencyId === undefined || r.currency_id === filter.currencyId))
    .map((r) => {
      const codes = new Set((r.group_codes ?? '').split(','));
      return {
        id: r.id,
        name: r.name,
        currencyId: r.currency_id,
        billWise: billWiseOn && r.maintain_bill_wise === 1,
        openingInr: r.opening_balance,
        openingForex: r.opening_forex_amount ?? 0,
        debtor: codes.has('SUNDRY_DEBTORS'),
        creditor: codes.has('SUNDRY_CREDITORS'),
        monetary: (r.nature === 'assets' || r.nature === 'liabilities') && ![...codes].some((c) => NON_MONETARY_GROUPS.has(c)),
      };
    });
}

/** Ledger balance in both currencies as of a date (opening + vouchers, books filter). */
function balanceAsOf(db: Db, l: ForeignLedger, asOf: string, today: string, dp: number): { inr: Paise; forex: number } {
  const r = db.get<{ inr: number; fx: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS inr, COALESCE(SUM(forex_amount), 0) AS fx
       FROM ledger_entries WHERE ledger_id = :id AND ${BOOKS} AND date <= :asOf`,
    { id: l.id, today, asOf },
  ) ?? { inr: 0, fx: 0 };
  return { inr: l.openingInr + r.inr, forex: roundForex(l.openingForex + r.fx, dp) };
}

interface ClosingRate {
  rate: number | null;
  date: string | null;
  overridden: boolean;
  masterRate: number | null;
  masterDate: string | null;
}

function closingRates(db: Db, asOf: string, type: ForexRateType, overrides: ReadonlyArray<{ currencyId: number; rate: number }> = []): Map<number, ClosingRate> {
  const out = new Map<number, ClosingRate>();
  for (const c of allCurrencies(db).values()) {
    if (c.isBase) continue;
    const { rate, row } = rateOn(db, c.id, asOf, type);
    const master = { masterRate: rate, masterDate: row?.date ?? null };
    const o = overrides.find((x) => x.currencyId === c.id);
    if (o && o.rate > 0) out.set(c.id, { rate: o.rate, date: asOf, overridden: true, ...master });
    else out.set(c.id, { rate, date: row?.date ?? null, overridden: false, ...master });
  }
  return out;
}

// ───────────────────────────── Outstanding ─────────────────────────────

export function forexOutstanding(db: Db, today: string, input: ForexOutstandingInput): ForexOutstandingResult {
  assertForexEnabled(db);
  const rateType = input.rateType ?? getForexSettings(db).revaluationRateType;
  const currencies = allCurrencies(db);
  const rates = closingRates(db, input.asOf, rateType);
  const kind = input.kind ?? 'all';
  const parties: ForexOutstandingParty[] = [];
  const totals = new Map<number, { forex: number; inr: Paise; revalued: Paise | null; difference: Paise | null }>();
  for (const l of foreignLedgers(db, input)) {
    if (input.ledgerId === undefined && !l.debtor && !l.creditor) continue;
    const cur = currencies.get(l.currencyId) as ForexCurrency;
    const dp = cur.decimalPlaces;
    const bal = balanceAsOf(db, l, input.asOf, today, dp);
    if (bal.inr === 0 && toMinor(bal.forex, dp) === 0) continue;
    if (kind === 'receivable' && bal.inr < 0) continue;
    if (kind === 'payable' && bal.inr > 0) continue;
    const rate = rates.get(l.currencyId)?.rate ?? null;
    const bills: ForexOutstandingBill[] = l.billWise
      ? pendingForexBills(db, l.id, input.asOf, today, dp).map((b) => {
          const revalued = rate === null ? null : forexToPaise(b.forexAmount, dp, rate);
          const due = b.dueDate ?? b.billDate;
          return {
            ...b,
            ledgerId: l.id,
            ledgerName: l.name,
            currencyId: l.currencyId,
            overdueDays: due < input.asOf ? diffDays(due, input.asOf) : null,
            closingRate: rate,
            revaluedAmount: revalued,
            difference: revalued === null ? null : revalued - b.amount,
          };
        })
      : [];
    const revaluedBalance = rate === null ? null : forexToPaise(bal.forex, dp, rate);
    const party: ForexOutstandingParty = {
      ledgerId: l.id,
      ledgerName: l.name,
      currencyId: l.currencyId,
      forexBalance: bal.forex,
      inrBalance: bal.inr,
      revaluedBalance,
      difference: revaluedBalance === null ? null : revaluedBalance - bal.inr,
      bills,
    };
    parties.push(party);
    const t = totals.get(l.currencyId) ?? { forex: 0, inr: 0, revalued: 0, difference: 0 };
    t.forex = sumForex([t.forex, bal.forex], dp);
    t.inr += bal.inr;
    t.revalued = t.revalued === null || revaluedBalance === null ? null : t.revalued + revaluedBalance;
    t.difference = t.revalued === null || t.difference === null || party.difference === null ? null : t.difference + party.difference;
    totals.set(l.currencyId, t);
  }
  return {
    asOf: input.asOf,
    rateType,
    currencies: [...currencies.values()].filter((c) => !c.isBase),
    parties,
    totals: [...totals.entries()].map(([currencyId, t]) => ({ currencyId, ...t })),
  };
}

// ───────────────────────────── Ledger in both currencies ─────────────────────────────

export function forexLedgerStatement(db: Db, today: string, input: ForexLedgerInput): ForexLedgerStatement {
  assertForexEnabled(db);
  if (input.from > input.to) throw validation([{ path: 'from', message: 'The period starts after it ends.' }]);
  const l = foreignLedgers(db, { ledgerId: input.ledgerId })[0];
  if (!l) {
    const name = db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: input.ledgerId });
    if (name === undefined) throw notFound('Ledger', input.ledgerId);
    throw rule(`${name} is kept in rupees; open its ledger report instead.`);
  }
  const currency = allCurrencies(db).get(l.currencyId) as ForexCurrency;
  const dp = currency.decimalPlaces;
  const opening = balanceAsOf(db, l, addDays(input.from, -1), today, dp);
  const entries = db.all<{
    voucher_id: number;
    date: string;
    vt: string;
    base_type: string;
    number: string | null;
    narration: string | null;
    amount: number;
    forex_amount: number | null;
    exchange_rate: number | null;
  }>(
    `SELECT le.voucher_id, le.date, t.name AS vt, v.base_type, v.number, v.narration, SUM(le.amount) AS amount,
            SUM(le.forex_amount) AS forex_amount, MAX(le.exchange_rate) AS exchange_rate
       FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id JOIN voucher_types t ON t.id = v.voucher_type_id
      WHERE le.ledger_id = :id AND le.affects_books = 1 AND (le.is_post_dated = 0 OR le.date <= :today)
        AND le.date BETWEEN :from AND :to
      GROUP BY le.voucher_id
      ORDER BY le.date, v.id`,
    { id: l.id, today, from: input.from, to: input.to },
  );
  const others = new Map<number, Array<{ ledgerName: string; amount: number; role: string }>>();
  if (entries.length > 0) {
    for (const r of db.all<{ voucher_id: number; name: string; amount: number; role: string }>(
      `SELECT le.voucher_id, l.name, SUM(le.amount) AS amount, MAX(le.role) AS role
         FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
        WHERE le.voucher_id IN (SELECT value FROM json_each(:vids)) AND le.ledger_id <> :id
        GROUP BY le.voucher_id, le.ledger_id`,
      { vids: JSON.stringify(entries.map((e) => e.voucher_id)), id: l.id },
    )) {
      const list = others.get(r.voucher_id) ?? [];
      list.push({ ledgerName: r.name, amount: r.amount, role: r.role });
      others.set(r.voucher_id, list);
    }
  }
  let fxBal = opening.forex;
  let inrBal = opening.inr;
  const totals = { forexDr: 0, forexCr: 0, inrDr: 0, inrCr: 0 };
  const rows = entries.map((e) => {
    const fx = e.forex_amount === null ? null : roundForex(e.forex_amount, dp);
    fxBal = sumForex([fxBal, fx ?? 0], dp);
    inrBal += e.amount;
    if (fx !== null && fx > 0) totals.forexDr = sumForex([totals.forexDr, fx], dp);
    if (fx !== null && fx < 0) totals.forexCr = sumForex([totals.forexCr, -fx], dp);
    if (e.amount > 0) totals.inrDr += e.amount;
    else totals.inrCr -= e.amount;
    return {
      voucherId: e.voucher_id,
      date: e.date,
      voucherType: e.vt,
      baseType: e.base_type,
      number: e.number,
      particulars: particularsFor(e.amount, others.get(e.voucher_id) ?? []),
      narration: e.narration,
      forexAmount: fx,
      rate: e.exchange_rate,
      amount: e.amount,
      forexBalance: fxBal,
      inrBalance: inrBal,
    };
  });
  const closingRate = rateOn(db, l.currencyId, input.to, getForexSettings(db).revaluationRateType).rate;
  const revaluedInr = closingRate === null ? null : forexToPaise(fxBal, dp, closingRate);
  return {
    ledgerId: l.id,
    ledgerName: l.name,
    currency,
    from: input.from,
    to: input.to,
    openingForex: opening.forex,
    openingInr: opening.inr,
    rows,
    totals,
    closingForex: fxBal,
    closingInr: inrBal,
    closingRate,
    revaluedInr,
    unrealised: revaluedInr === null ? null : revaluedInr - inrBal,
  };
}

// ───────────────────────────── Revaluation ─────────────────────────────

/**
 * Unrealised exchange differences as of `asOf`: every monetary balance kept in a foreign currency
 * (receivables, payables, EEFC / foreign bank accounts, loans) restated at the closing rate (AS 11 /
 * Ind AS 21: monetary items at the closing rate, difference to P&L). Bill-wise ledgers are revalued
 * per pending bill (so a later settlement's realised difference is measured from the revalued
 * amount), plus any on-account remainder; other ledgers on their balance.
 */
export function forexRevaluation(db: Db, today: string, input: ForexRevaluationInput): ForexRevaluationResult {
  assertForexEnabled(db);
  const rateType = input.rateType ?? getForexSettings(db).revaluationRateType;
  const currencies = allCurrencies(db);
  const rates = closingRates(db, input.asOf, rateType, input.rates ?? []);
  const lines: ForexRevaluationLine[] = [];
  const missing = new Set<number>();
  for (const l of foreignLedgers(db, {})) {
    if (!l.monetary) continue;
    const cur = currencies.get(l.currencyId) as ForexCurrency;
    const dp = cur.decimalPlaces;
    const bal = balanceAsOf(db, l, input.asOf, today, dp);
    if (bal.inr === 0 && toMinor(bal.forex, dp) === 0) continue;
    const rate = rates.get(l.currencyId)?.rate ?? null;
    if (rate === null) {
      missing.add(l.currencyId);
      continue;
    }
    const push = (billName: string | null, forex: number, booked: Paise): void => {
      const revalued = forexToPaise(forex, dp, rate);
      const adjustment = revalued - booked;
      if (adjustment === 0) return;
      lines.push({ ledgerId: l.id, ledgerName: l.name, billName, currencyId: l.currencyId, forexAmount: forex, bookedAmount: booked, closingRate: rate, revaluedAmount: revalued, adjustment });
    };
    if (l.billWise) {
      const bills = pendingForexBills(db, l.id, input.asOf, today, dp);
      for (const b of bills) push(b.billName, b.forexAmount, b.amount);
      const restFx = roundForex(bal.forex - sumForex(bills.map((b) => b.forexAmount), dp), dp);
      const restInr = bal.inr - bills.reduce((a, b) => a + b.amount, 0);
      if (restInr !== 0 || toMinor(restFx, dp) !== 0) push(null, restFx, restInr);
    } else {
      push(null, bal.forex, bal.inr);
    }
  }
  const posted = db.all<{ voucher_id: number; number: string | null; date: string; as_of: string }>(
    `SELECT r.voucher_id, v.number, v.date, r.as_of FROM forex_revaluations r JOIN vouchers v ON v.id = r.voucher_id
      WHERE v.is_cancelled = 0 ORDER BY r.as_of DESC, v.id DESC`,
  );
  return {
    asOf: input.asOf,
    rateType,
    rates: [...rates.entries()].map(([currencyId, r]) => {
      const c = currencies.get(currencyId) as ForexCurrency;
      return { currencyId, symbol: c.symbol, formalName: c.formalName, rate: r.rate, rateDate: r.date, overridden: r.overridden, masterRate: r.masterRate, masterDate: r.masterDate };
    }),
    missingRates: [...missing],
    lines,
    net: lines.reduce((a, x) => a + x.adjustment, 0),
    posted: posted.map((p) => ({ voucherId: p.voucher_id, number: p.number, date: p.date, asOf: p.as_of })),
  };
}

/**
 * Post the revaluation as one Journal ("Forex adjustment"): per ledger an INR-only exchange
 * adjustment line (forexAmount 0; bill-wise against each bill — gains and losses on separate lines),
 * and the net to the unrealised gain/loss ledger. Goes through saveVoucher (numbered, audited,
 * period-lock aware) and is recorded in forex_revaluations.
 */
export function postForexRevaluation(ctx: CompanyCtx, input: ForexRevaluationPostInput): ForexRevaluationPostResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  if (input.date !== undefined && input.date < input.asOf) {
    // A journal dated before the balances it restates would move rupees ahead of the vouchers that
    // created them (and could settle bills that do not exist yet on that date).
    throw validation([{ path: 'date', message: `The journal date cannot be before the revaluation date (${formatDate(input.asOf)}).` }]);
  }
  const report = forexRevaluation(db, today, input);
  if (!input.allowRepeat && report.posted.some((p) => p.asOf === input.asOf)) {
    throw rule(`A forex revaluation as of ${formatDate(input.asOf)} is already posted. Alter or delete that journal, or confirm to post another one.`, { needsConfirmation: true });
  }
  if (report.lines.length === 0) throw rule(`Nothing to revalue as of ${formatDate(input.asOf)}: every foreign-currency balance is already carried at the closing rate.`);
  // Every currency with a balance needs its closing rate (AS 11 / Ind AS 21 restate ALL monetary items),
  // whether or not other currencies' rates were typed for this run.
  if (report.missingRates.length > 0) {
    const names = report.rates.filter((r) => report.missingRates.includes(r.currencyId)).map((r) => r.formalName).join(', ');
    throw rule(`No ${report.rateType} rate of exchange on or before ${formatDate(input.asOf)} for ${names}. Enter the closing rate (Currencies › Rates of Exchange) or type it here.`);
  }
  const typeId =
    input.voucherTypeId ??
    db.value<number>(`SELECT id FROM voucher_types WHERE base_type = 'journal' AND is_active = 1 ORDER BY id LIMIT 1`);
  if (typeId === undefined) throw rule('No active Journal voucher type exists. Create one under Masters › Voucher Types.');
  const vtBase = db.value<string>('SELECT base_type FROM voucher_types WHERE id = :id', { id: typeId });
  if (vtBase !== 'journal') throw validation([{ path: 'voucherTypeId', message: 'Choose a Journal voucher type for the forex adjustment.' }]);
  const settings = getForexSettings(db);
  const glId = unrealisedLedgerId(db, settings) ?? ensureForexLedger(db, ctx.clock.now().toISOString(), ctx.audit);

  const ledgers: LedgerLineInput[] = [];
  const byLedger = new Map<number, ForexRevaluationLine[]>();
  for (const line of report.lines) {
    const list = byLedger.get(line.ledgerId) ?? [];
    list.push(line);
    byLedger.set(line.ledgerId, list);
  }
  for (const [ledgerId, list] of byLedger) {
    for (const side of [1, -1]) {
      const part = list.filter((x) => Math.sign(x.adjustment) === side);
      if (part.length === 0) continue;
      const amount = part.reduce((a, x) => a + x.adjustment, 0);
      const bills = part.every((x) => x.billName === null && !isBillWise(db, ledgerId))
        ? undefined
        : part.map((x): BillAllocationInput => (x.billName === null ? { refType: 'on_account', amount: Math.abs(x.adjustment) } : { refType: 'against', billName: x.billName, amount: Math.abs(x.adjustment) }));
      ledgers.push({
        ledgerId,
        amount,
        forexAmount: 0,
        narration: part.map((x) => `${x.billName ?? 'balance'} ${x.forexAmount} @ ${x.closingRate}`).join('; '),
        ...(bills ? { billAllocations: bills } : {}),
      });
    }
  }
  const net = report.net;
  if (net !== 0) ledgers.push({ ledgerId: glId, amount: -net, narration: `Unrealised exchange ${net > 0 ? 'gain' : 'loss'} as of ${formatDate(input.asOf)}` });
  const rateText = report.rates
    .filter((r) => r.rate !== null)
    .map((r) => `${r.symbol} ${r.rate}`)
    .join(', ');
  const saved = saveVoucher(ctx, {
    voucherTypeId: typeId,
    date: input.date ?? input.asOf,
    mode: 'ledger',
    narration: input.narration?.trim() || `Forex adjustment: foreign-currency balances restated at the closing rate as of ${formatDate(input.asOf)} (${rateText}).`,
    ledgers,
    acknowledgeWarnings: true,
  });
  db.run(
    `INSERT INTO forex_revaluations (voucher_id, as_of, rate_type, rates, created_at) VALUES (:v, :asOf, :type, :rates, :ts)`,
    {
      v: saved.id,
      asOf: input.asOf,
      type: report.rateType,
      rates: JSON.stringify(report.rates.filter((r) => r.rate !== null).map((r) => ({ currencyId: r.currencyId, rate: r.rate }))),
      ts: ctx.clock.now().toISOString(),
    },
  );
  ctx.audit({
    action: 'create',
    entityType: 'forex_revaluation',
    entityId: saved.id,
    entityLabel: `Forex revaluation as of ${formatDate(input.asOf)}`,
    after: { voucherId: saved.id, number: saved.number, net, lines: report.lines.length, rateType: report.rateType },
  });
  return { voucherId: saved.id, number: saved.number, lines: report.lines.length, net };
}

function isBillWise(db: Db, ledgerId: number): boolean {
  return getFeatures(db).billWise && db.value<number>('SELECT maintain_bill_wise FROM ledgers WHERE id = :id', { id: ledgerId }) === 1;
}

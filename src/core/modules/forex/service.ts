/**
 * Forex services: settings, entry context, rate suggestion, pending bills in both currencies,
 * opening balances in the currency, and the forex side of a saved voucher (view / print).
 */
import { defaultRateType, roundForex, sumForex, toMinor, type ForexRateType } from '../../../shared/forex.ts';
import type {
  ForexContext,
  ForexCurrency,
  ForexOpeningInput,
  ForexOpeningView,
  ForexPendingBill,
  ForexRateSuggestion,
  ForexSettings,
  ForexSettingsView,
  ForexVoucherDetail,
} from '../../../shared/types/forex.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { formatDate } from '../../../shared/dates.ts';
import { AppError, notFound, rule, validation } from '../../lib/errors.ts';
import { getConfig, getFeatures } from '../company/service.ts';
import { loadVoucherRow, parseMeta } from '../vouchers/service.ts';
import {
  allCurrencies,
  allForeignLedgers,
  currencyById,
  getForexSettings,
  pendingForexBills,
  rateOn,
  realisedLedgerId,
  settingsView,
  writeForexSettings,
} from './store.ts';

/** Multiple currencies (F11) must be on. */
export function assertForexEnabled(db: Db): void {
  if (!getFeatures(db).multiCurrency) {
    throw rule('Multiple currencies is turned off for this company. Turn it on in F11 › Features › Accounting.');
  }
}

// ───────────────────────────── Settings ─────────────────────────────

function checkGainLossLedger(db: Db, id: number | null, path: string): void {
  if (id === null) return;
  const r = db.get<{ name: string; nature: string; bill_wise: number; currency_id: number | null; is_base: number | null }>(
    `SELECT l.name, g.nature, l.maintain_bill_wise AS bill_wise, l.currency_id, c.is_base
       FROM ledgers l JOIN groups g ON g.id = l.group_id LEFT JOIN currencies c ON c.id = l.currency_id
      WHERE l.id = :id`,
    { id },
  );
  if (!r) throw validation([{ path, message: 'The selected ledger does not exist.' }]);
  if (r.nature !== 'income' && r.nature !== 'expenses') {
    throw validation([{ path, message: `${r.name} is not an income or expense ledger. Exchange differences go to the Profit & Loss account (e.g. Forex Gain/Loss under Indirect Expenses).` }]);
  }
  if (r.bill_wise === 1) throw validation([{ path, message: `${r.name} maintains bill-wise details; choose a ledger without them.` }]);
  if (r.currency_id !== null && r.is_base === 0) throw validation([{ path, message: `${r.name} is kept in a foreign currency; the gain/loss ledger must be in rupees.` }]);
}

export function saveForexSettings(ctx: CompanyCtx, input: Partial<ForexSettings>): ForexSettingsView {
  assertForexEnabled(ctx.db);
  const before = getForexSettings(ctx.db);
  const next: ForexSettings = {
    gainLossLedgerId: input.gainLossLedgerId === undefined ? before.gainLossLedgerId : input.gainLossLedgerId,
    unrealisedLedgerId: input.unrealisedLedgerId === undefined ? before.unrealisedLedgerId : input.unrealisedLedgerId,
    revaluationRateType: input.revaluationRateType ?? before.revaluationRateType,
  };
  checkGainLossLedger(ctx.db, next.gainLossLedgerId, 'gainLossLedgerId');
  checkGainLossLedger(ctx.db, next.unrealisedLedgerId, 'unrealisedLedgerId');
  writeForexSettings(ctx.db, next, ctx.clock.now());
  ctx.audit({ action: 'settings', entityType: 'settings', entityLabel: 'Multi-currency (forex) settings', before, after: next });
  return settingsView(ctx.db);
}

// ───────────────────────────── Entry context / rates ─────────────────────────────

export function forexContext(db: Db): ForexContext {
  const enabled = getFeatures(db).multiCurrency;
  const currencies = [...allCurrencies(db).values()];
  return {
    enabled,
    base: currencies.find((c) => c.isBase) ?? null,
    currencies: currencies.filter((c) => !c.isBase),
    ledgers: enabled ? allForeignLedgers(db) : [],
    settings: settingsView(db),
  };
}

export function suggestRate(db: Db, input: { currencyId: number; date: string; rateType?: ForexRateType; baseType?: string }): ForexRateSuggestion {
  const cur = currencyById(db, input.currencyId);
  if (!cur) throw notFound('Currency', input.currencyId);
  const rateType = input.rateType ?? defaultRateType(input.baseType ?? 'journal');
  const { rate, row } = rateOn(db, input.currencyId, input.date, rateType);
  return {
    currencyId: input.currencyId,
    date: input.date,
    rateType,
    rate: cur.isBase ? 1 : rate,
    rateDate: row?.date ?? null,
    standard: row?.standard ?? null,
    selling: row?.selling ?? null,
    buying: row?.buying ?? null,
  };
}

function ledgerCurrency(db: Db, ledgerId: number): { name: string; currency: ForexCurrency } {
  const r = db.get<{ name: string; currency_id: number | null }>('SELECT name, currency_id FROM ledgers WHERE id = :id', { id: ledgerId });
  if (!r) throw notFound('Ledger', ledgerId);
  const cur = r.currency_id === null ? null : currencyById(db, r.currency_id);
  if (!cur || cur.isBase) throw rule(`${r.name} is kept in rupees. Set a foreign currency on the ledger (Ledger › Currency) to keep it in that currency.`);
  return { name: r.name, currency: cur };
}

export function forexPendingBills(db: Db, today: string, input: { ledgerId: number; asOf: string; excludeVoucherId?: number }): ForexPendingBill[] {
  const { currency } = ledgerCurrency(db, input.ledgerId);
  return pendingForexBills(db, input.ledgerId, input.asOf, today, currency.decimalPlaces, input.excludeVoucherId ?? null);
}

// ───────────────────────────── Openings in the currency ─────────────────────────────

export function getForexOpening(db: Db, ledgerId: number): ForexOpeningView {
  const { name, currency } = ledgerCurrency(db, ledgerId);
  const l = db.get<{ opening_balance: number; opening_forex_amount: number | null }>('SELECT opening_balance, opening_forex_amount FROM ledgers WHERE id = :id', { id: ledgerId });
  const bills = db.all<{ bill_name: string; bill_date: string; amount: number; forex_amount: number | null }>(
    'SELECT bill_name, bill_date, amount, forex_amount FROM opening_bills WHERE ledger_id = :id ORDER BY bill_date, bill_name',
    { id: ledgerId },
  );
  return {
    ledgerId,
    ledgerName: name,
    currency,
    openingInr: l?.opening_balance ?? 0,
    openingForex: l?.opening_forex_amount ?? 0,
    bills: bills.map((b) => ({ billName: b.bill_name, billDate: b.bill_date, amount: b.amount, forexAmount: b.forex_amount ?? 0 })),
  };
}

/**
 * Openings are as at the books beginning (like the rupee openings, accounts/ledgers.ts): when the books
 * are locked up to a date on or after it, the foreign amounts of the opening balance and opening bills
 * belong to the locked period — they drive the realised difference of every later settlement — and
 * cannot change.
 */
function assertOpeningUnlocked(db: Db, before: ForexOpeningView, opening: number, bills: ReadonlyArray<{ name: string; fx: number }>): void {
  const lockedUpTo = getConfig(db).lockedUpTo;
  const booksFrom = db.value<string>('SELECT books_from FROM company WHERE id = 1');
  if (!lockedUpTo || !booksFrom || lockedUpTo < booksFrom) return;
  const stored = new Map(before.bills.map((b) => [b.billName, b.forexAmount]));
  const changed = before.openingForex !== opening || bills.some((b) => (stored.get(b.name) ?? 0) !== b.fx);
  if (!changed) return;
  throw new AppError(
    'LOCKED',
    `Books are locked up to ${formatDate(lockedUpTo)}, which includes the opening balances (as at ${formatDate(booksFrom)}). ` +
      `Unlock the period to change the opening of ${before.ledgerName} in ${before.currency.formalName}.`,
    { lockedUpTo },
  );
}

const sameSide = (inr: number, fx: number): boolean => inr === 0 || fx === 0 || Math.sign(inr) === Math.sign(fx);

export function saveForexOpening(ctx: CompanyCtx, input: ForexOpeningInput): ForexOpeningView {
  assertForexEnabled(ctx.db);
  const { db } = ctx;
  const before = getForexOpening(db, input.ledgerId);
  const dp = before.currency.decimalPlaces;
  const opening = roundForex(input.openingForex, dp);
  const issues: Array<{ path: string; message: string }> = [];
  if (!sameSide(before.openingInr, opening)) issues.push({ path: 'openingForex', message: 'The opening balance in the currency must be on the same side (Dr / Cr) as the rupee opening balance.' });
  if (before.openingInr === 0 && opening !== 0) issues.push({ path: 'openingForex', message: 'Enter the rupee opening balance on the ledger first (Ledger › Opening balance).' });
  const byName = new Map(before.bills.map((b) => [b.billName, b]));
  const bills = (input.bills ?? []).map((b, i) => {
    const ob = byName.get(b.billName.trim());
    const fx = roundForex(b.forexAmount, dp);
    if (!ob) issues.push({ path: `bills[${i}].billName`, message: `${b.billName} is not an opening bill of ${before.ledgerName}.` });
    else if (!sameSide(ob.amount, fx)) issues.push({ path: `bills[${i}].forexAmount`, message: `Bill ${ob.billName}: the foreign amount must be on the same side (Dr / Cr) as its rupee amount.` });
    return { name: b.billName.trim(), fx };
  });
  if (bills.length > 0) {
    const total = sumForex(bills.map((b) => b.fx), dp);
    if (toMinor(total, dp) !== toMinor(opening, dp) && before.bills.length === bills.length) {
      issues.push({ path: 'bills', message: `The opening bills total ${total} but the opening balance in the currency is ${opening}.` });
    }
  }
  if (issues.length > 0) throw validation(issues);
  assertOpeningUnlocked(db, before, opening, bills);
  db.run('UPDATE ledgers SET opening_forex_amount = :fx, updated_at = :ts WHERE id = :id', { fx: opening, ts: ctx.clock.now().toISOString(), id: input.ledgerId });
  for (const b of bills) db.run('UPDATE opening_bills SET forex_amount = :fx WHERE ledger_id = :id AND bill_name = :name', { fx: b.fx, id: input.ledgerId, name: b.name });
  const after = getForexOpening(db, input.ledgerId);
  ctx.audit({
    action: 'alter',
    entityType: 'ledger',
    entityId: input.ledgerId,
    entityLabel: `${before.ledgerName} (opening in ${before.currency.formalName})`,
    before: { openingForex: before.openingForex, bills: before.bills.map((b) => [b.billName, b.forexAmount]) },
    after: { openingForex: after.openingForex, bills: after.bills.map((b) => [b.billName, b.forexAmount]) },
  });
  return after;
}

// ───────────────────────────── Saved voucher ─────────────────────────────

/** Item / ledger forex values of a stored foreign-currency invoice input (same rules as the hook). */
export function inputLineForex(input: VoucherInput, dp: number): Pick<ForexVoucherDetail, 'items' | 'ledgers'> {
  if (!input.forex) return { items: [], ledgers: [] };
  return {
    items: (input.items ?? []).map((it) => {
      if (it.forexRate === undefined && it.forexAmount === undefined) return { forexRate: null, forexAmount: null };
      const gross = it.forexAmount ?? roundForex((it.billedQty ?? it.qty) * (it.forexRate ?? 0), dp);
      const d = it.discountPct ?? 0;
      return { forexRate: it.forexRate ?? null, forexAmount: d ? roundForex((gross * (100 - d)) / 100, dp) : gross };
    }),
    ledgers: (input.ledgers ?? []).map((l) => ({ forexAmount: l.forexAmount ?? null })),
  };
}

export function voucherForex(db: Db, voucherId: number): ForexVoucherDetail {
  const row = loadVoucherRow(db, voucherId);
  if (!row) throw notFound('Voucher', voucherId);
  const v = db.get<{ currency_id: number | null; exchange_rate: number | null; forex_amount: number | null }>(
    'SELECT currency_id, exchange_rate, forex_amount FROM vouchers WHERE id = :id',
    { id: voucherId },
  );
  const currencies = allCurrencies(db);
  const currency = v?.currency_id ? (currencies.get(v.currency_id) ?? null) : null;
  const input = parseMeta(row.meta).input;
  const lines = input && currency ? inputLineForex(input, currency.decimalPlaces) : { items: [], ledgers: [] };
  const entries = db.all<{ id: number; line_no: number; ledger_id: number; name: string; amount: number; forex_amount: number; exchange_rate: number | null; currency_id: number }>(
    `SELECT le.id, le.line_no, le.ledger_id, l.name, le.amount, le.forex_amount, le.exchange_rate, le.currency_id
       FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
      WHERE le.voucher_id = :id AND le.currency_id IS NOT NULL ORDER BY le.line_no`,
    { id: voucherId },
  );
  const bills = db.all<{ ledger_entry_id: number; ref_type: string; bill_name: string | null; amount: number; forex_amount: number | null }>(
    'SELECT ledger_entry_id, ref_type, bill_name, amount, forex_amount FROM bill_allocations WHERE voucher_id = :id AND currency_id IS NOT NULL ORDER BY id',
    { id: voucherId },
  );
  const glId = realisedLedgerId(db);
  let gainLoss = 0;
  if (glId !== undefined && entries.length > 0) {
    gainLoss = db.value<number>('SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :gl', { id: voucherId, gl: glId }) ?? 0;
  }
  return {
    voucherId,
    currency,
    rate: v?.exchange_rate ?? null,
    documentForex: v?.forex_amount ?? null,
    items: lines.items,
    ledgers: lines.ledgers,
    entries: entries.map((e) => ({
      lineNo: e.line_no,
      ledgerId: e.ledger_id,
      ledgerName: e.name,
      currency: currencies.get(e.currency_id) as ForexCurrency,
      forexAmount: e.forex_amount ?? 0,
      rate: e.exchange_rate,
      amount: e.amount,
      bills: bills.filter((b) => b.ledger_entry_id === e.id).map((b) => ({ refType: b.ref_type, billName: b.bill_name, amount: b.amount, forexAmount: b.forex_amount ?? 0 })),
    })),
    gainLoss,
    gainLossLedger: gainLoss !== 0 && glId !== undefined ? { id: glId, name: db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: glId }) ?? '' } : null,
  };
}

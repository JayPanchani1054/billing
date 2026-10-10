/**
 * Forex module storage helpers: settings, currencies, ledger currencies, the system 'Forex Gain/Loss'
 * ledger and pending bills in both currencies.
 */
import { randomUUID } from 'node:crypto';
import { FOREX_RATE_TYPES, pickRate, type ForexRateType } from '../../../shared/forex.ts';
import type { ForexCurrency, ForexPendingBill, ForexSettings, ForexSettingsView } from '../../../shared/types/forex.ts';
import { effectiveRate } from '../../../shared/forex.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError } from '../../lib/errors.ts';
import { readSetting, writeSetting } from '../company/service.ts';

/** reserved_code of the system ledger realised / unrealised exchange differences go to by default. */
export const FOREX_LEDGER_CODE = 'FOREX_GAIN_LOSS';
export const FOREX_LEDGER_NAME = 'Forex Gain/Loss';
/** Group of the system ledger (kept under Indirect Expenses, as accountants expect; a net gain shows as a credit). */
const FOREX_LEDGER_GROUP = 'INDIRECT_EXPENSES';

export const DEFAULT_FOREX_SETTINGS: ForexSettings = { gainLossLedgerId: null, unrealisedLedgerId: null, revaluationRateType: 'standard' };

export function getForexSettings(db: Db): ForexSettings {
  const raw = readSetting(db, 'forex');
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<ForexSettings>) : {};
  const out: ForexSettings = { ...DEFAULT_FOREX_SETTINGS };
  if (typeof s.gainLossLedgerId === 'number') out.gainLossLedgerId = s.gainLossLedgerId;
  if (typeof s.unrealisedLedgerId === 'number') out.unrealisedLedgerId = s.unrealisedLedgerId;
  if (typeof s.revaluationRateType === 'string' && (FOREX_RATE_TYPES as readonly string[]).includes(s.revaluationRateType)) out.revaluationRateType = s.revaluationRateType;
  // A configured ledger that was deleted falls back to the system ledger.
  for (const k of ['gainLossLedgerId', 'unrealisedLedgerId'] as const) {
    const id = out[k];
    if (id !== null && db.value('SELECT 1 FROM ledgers WHERE id = :id', { id }) === undefined) out[k] = null;
  }
  return out;
}

export function writeForexSettings(db: Db, s: ForexSettings, now: Date): void {
  writeSetting(db, 'forex', s, now);
}

export function systemForexLedgerId(db: Db): number | undefined {
  return db.value<number>('SELECT id FROM ledgers WHERE reserved_code = :code', { code: FOREX_LEDGER_CODE });
}

/** Ledger realised differences post to (configured, else the system ledger; undefined until created). */
export function realisedLedgerId(db: Db, settings: ForexSettings = getForexSettings(db)): number | undefined {
  return settings.gainLossLedgerId ?? systemForexLedgerId(db);
}

export function unrealisedLedgerId(db: Db, settings: ForexSettings = getForexSettings(db)): number | undefined {
  return settings.unrealisedLedgerId ?? realisedLedgerId(db, settings);
}

/**
 * Create the system 'Forex Gain/Loss' ledger when missing (idempotent; inside a write transaction).
 * A same-named ledger in the same group is adopted. The creation is audited.
 */
export function ensureForexLedger(db: Db, ts: string, audit?: CompanyCtx['audit']): number {
  const existing = systemForexLedgerId(db);
  if (existing !== undefined) return existing;
  const groupId = db.value<number>('SELECT id FROM groups WHERE reserved_code = :g', { g: FOREX_LEDGER_GROUP });
  if (groupId === undefined) throw new AppError('INTERNAL', `Group ${FOREX_LEDGER_GROUP} is missing`);
  const same = db.get<{ id: number; group_id: number; reserved_code: string | null }>('SELECT id, group_id, reserved_code FROM ledgers WHERE name = :name', {
    name: FOREX_LEDGER_NAME,
  });
  if (same && same.group_id === groupId && same.reserved_code === null) {
    db.run('UPDATE ledgers SET reserved_code = :code, is_predefined = 1, updated_at = :ts WHERE id = :id', { code: FOREX_LEDGER_CODE, ts, id: same.id });
    audit?.({ action: 'alter', entityType: 'ledger', entityId: same.id, entityLabel: FOREX_LEDGER_NAME, after: { reservedCode: FOREX_LEDGER_CODE, by: 'forex' } });
    return same.id;
  }
  let name = FOREX_LEDGER_NAME;
  for (let i = 1; same && i < 1000; i++) {
    const candidate = i === 1 ? `${FOREX_LEDGER_NAME} (System)` : `${FOREX_LEDGER_NAME} (System ${i})`;
    if (db.value('SELECT 1 FROM ledgers WHERE name = :name', { name: candidate }) === undefined) {
      name = candidate;
      break;
    }
  }
  const guid = randomUUID();
  const id = db.run(
    `INSERT INTO ledgers (guid, name, group_id, reserved_code, is_predefined, gst_applicable, created_at, updated_at)
     VALUES (:guid, :name, :groupId, :code, 1, 'not_applicable', :ts, :ts)`,
    { guid, name, groupId, code: FOREX_LEDGER_CODE, ts },
  ).lastInsertRowid;
  audit?.({
    action: 'create',
    entityType: 'ledger',
    entityId: id,
    entityGuid: guid,
    entityLabel: name,
    after: { name, group: FOREX_LEDGER_GROUP, reservedCode: FOREX_LEDGER_CODE, createdBy: 'forex' },
  });
  return id;
}

export function settingsView(db: Db): ForexSettingsView {
  const s = getForexSettings(db);
  const named = (id: number | undefined): { id: number; name: string } | null => {
    if (id === undefined) return null;
    const name = db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id });
    return name === undefined ? null : { id, name };
  };
  return { ...s, gainLossLedger: named(realisedLedgerId(db, s)), unrealisedLedger: named(unrealisedLedgerId(db, s)) };
}

// ───────────────────────────── Currencies ─────────────────────────────

interface CurrencyRow {
  id: number;
  symbol: string;
  formal_name: string;
  iso_code: string | null;
  decimal_places: number;
  is_base: number;
}

const toCurrency = (r: CurrencyRow): ForexCurrency => ({
  id: r.id,
  symbol: r.symbol,
  formalName: r.formal_name,
  isoCode: r.iso_code,
  decimalPlaces: r.decimal_places,
  isBase: r.is_base === 1,
});

export function allCurrencies(db: Db): Map<number, ForexCurrency> {
  return new Map(
    db.all<CurrencyRow>('SELECT id, symbol, formal_name, iso_code, decimal_places, is_base FROM currencies ORDER BY is_base DESC, formal_name').map((r) => [r.id, toCurrency(r)]),
  );
}

export function currencyById(db: Db, id: number): ForexCurrency | null {
  const r = db.get<CurrencyRow>('SELECT id, symbol, formal_name, iso_code, decimal_places, is_base FROM currencies WHERE id = :id', { id });
  return r ? toCurrency(r) : null;
}

/** Foreign currency of each of `ledgerIds` that is kept in one (base / null currencies left out). */
export function foreignLedgerCurrencies(db: Db, ledgerIds: Iterable<number>): Map<number, number> {
  const ids = [...new Set(ledgerIds)];
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  // json_each keeps the statement constant (no interpolated id lists).
  for (const r of db.all<{ id: number; currency_id: number }>(
    `SELECT l.id, l.currency_id FROM ledgers l JOIN currencies c ON c.id = l.currency_id
      WHERE c.is_base = 0 AND l.id IN (SELECT value FROM json_each(:ids))`,
    { ids: JSON.stringify(ids) },
  )) {
    out.set(r.id, r.currency_id);
  }
  return out;
}

/** Every ledger kept in a foreign currency. */
export function allForeignLedgers(db: Db): Array<{ ledgerId: number; currencyId: number; ledgerName: string }> {
  return db
    .all<{ id: number; currency_id: number; name: string }>(
      `SELECT l.id, l.currency_id, l.name FROM ledgers l JOIN currencies c ON c.id = l.currency_id WHERE c.is_base = 0 ORDER BY l.name`,
    )
    .map((r) => ({ ledgerId: r.id, currencyId: r.currency_id, ledgerName: r.name }));
}

export interface RateRow {
  date: string;
  standard: number | null;
  selling: number | null;
  buying: number | null;
}

/** Latest master rate row of a currency on or before `date`. */
export function rateRowOn(db: Db, currencyId: number, date: string): RateRow | null {
  return (
    db.get<RateRow>('SELECT date, standard, selling, buying FROM exchange_rates WHERE currency_id = :id AND date <= :date ORDER BY date DESC LIMIT 1', {
      id: currencyId,
      date,
    }) ?? null
  );
}

export function rateOn(db: Db, currencyId: number, date: string, type: ForexRateType): { rate: number | null; row: RateRow | null } {
  const row = rateRowOn(db, currencyId, date);
  return { rate: pickRate(row, type), row };
}

// ───────────────────────────── Pending bills in both currencies ─────────────────────────────

interface PendingRow {
  bill_name: string;
  origin_date: string | null;
  any_date: string;
  due_date: string | null;
  amount: number;
  forex: number | null;
  has_opening: number;
  voucher_id: number | null;
}

/**
 * Open bills of a ledger as of `asOf` with their INR and foreign amounts (same sources and books filter
 * as vouchers/bills.ts › pendingBills). A bill is pending while either amount is not zero (a bill whose
 * foreign amount is settled but whose INR is not — e.g. an INR-only adjustment pending — stays listed).
 */
export function pendingForexBills(db: Db, ledgerId: number, asOf: string, today: string, dp: number, excludeVoucherId?: number | null): ForexPendingBill[] {
  const rows = db.all<PendingRow>(
    `SELECT bill_name,
            MIN(CASE WHEN src IN ('opening', 'new', 'advance') THEN bdate END) AS origin_date,
            MIN(bdate) AS any_date,
            MAX(due_date) AS due_date,
            SUM(amount) AS amount,
            SUM(COALESCE(forex, 0)) AS forex,
            MAX(CASE WHEN src = 'opening' THEN 1 ELSE 0 END) AS has_opening,
            MIN(CASE WHEN src IN ('new', 'advance') THEN voucher_id END) AS voucher_id
       FROM (
             SELECT ob.bill_name AS bill_name, ob.bill_date AS bdate, ob.due_date AS due_date, ob.amount AS amount,
                    ob.forex_amount AS forex, 'opening' AS src, NULL AS voucher_id
               FROM opening_bills ob
              WHERE ob.ledger_id = :ledgerId
             UNION ALL
             SELECT ba.bill_name, ba.date, ba.due_date, ba.amount, ba.forex_amount, ba.ref_type, ba.voucher_id
               FROM bill_allocations ba
              WHERE ba.ledger_id = :ledgerId
                AND ba.affects_books = 1
                AND (ba.is_post_dated = 0 OR ba.date <= :today)
                AND ba.date <= :asOf
                AND ba.voucher_id <> :exclude
                AND ba.ref_type <> 'on_account'
                AND ba.bill_name IS NOT NULL
            )
      GROUP BY bill_name
     HAVING SUM(amount) <> 0 OR ROUND(SUM(COALESCE(forex, 0)), 4) <> 0
      ORDER BY COALESCE(MIN(CASE WHEN src IN ('opening', 'new', 'advance') THEN bdate END), MIN(bdate)), bill_name`,
    { ledgerId, asOf, today, exclude: excludeVoucherId ?? 0 },
  );
  const f = 10 ** dp;
  return rows.map((r) => {
    const forex = Math.round((r.forex ?? 0) * f) / f || 0;
    return {
      billName: r.bill_name,
      billDate: r.origin_date ?? r.any_date,
      dueDate: r.due_date,
      amount: r.amount,
      forexAmount: forex,
      bookedRate: effectiveRate(r.amount, forex),
      source: r.has_opening === 1 ? 'opening' : 'voucher',
      voucherId: r.has_opening === 1 ? null : r.voucher_id,
    };
  });
}

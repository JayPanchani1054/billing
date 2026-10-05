/**
 * Currencies and exchange rates (multi-currency). The base currency (INR, seeded) cannot be deleted
 * and has no exchange rates. Exchange rates are rupees per one unit of the foreign currency, one row
 * per (currency, date) — saving the same date again updates it.
 */
import { randomUUID } from 'node:crypto';
import type {
  CurrencyRow,
  CurrencySaveInput,
  DeleteResult,
  ExchangeRateListInput,
  ExchangeRateRow,
  ExchangeRateSaveInput,
  ListResult,
} from '../../../shared/types/accounts.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule } from '../../lib/errors.ts';
import { Issues, assertRange, cleanText, plural, requirePermission, requireSavePermission } from './common.ts';

interface CurrencyDbRow {
  id: number;
  guid: string;
  symbol: string;
  formal_name: string;
  iso_code: string | null;
  decimal_places: number;
  is_base: number;
  created_at: string;
  updated_at: string;
  ledger_count: number;
}

interface RateDbRow {
  id: number;
  currency_id: number;
  date: string;
  standard: number | null;
  selling: number | null;
  buying: number | null;
}

const toRate = (r: RateDbRow): ExchangeRateRow => ({
  id: r.id,
  currencyId: r.currency_id,
  date: r.date,
  standard: r.standard,
  selling: r.selling,
  buying: r.buying,
});

const CURRENCY_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM ledgers l WHERE l.currency_id = c.id) AS ledger_count FROM currencies c`;

function toCurrency(db: Db, r: CurrencyDbRow): CurrencyRow {
  const latest = db.get<RateDbRow>('SELECT * FROM exchange_rates WHERE currency_id = :id ORDER BY date DESC LIMIT 1', { id: r.id });
  return {
    id: r.id,
    guid: r.guid,
    symbol: r.symbol,
    formalName: r.formal_name,
    isoCode: r.iso_code,
    decimalPlaces: r.decimal_places,
    isBase: r.is_base === 1,
    latestRate: latest ? toRate(latest) : null,
    ledgerCount: r.ledger_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listCurrencies(db: Db): ListResult<CurrencyRow> {
  const rows = db.all<CurrencyDbRow>(`${CURRENCY_SELECT} ORDER BY c.is_base DESC, c.formal_name`).map((r) => toCurrency(db, r));
  return { rows, total: rows.length };
}

export function getCurrency(db: Db, id: number): CurrencyRow {
  const r = db.get<CurrencyDbRow>(`${CURRENCY_SELECT} WHERE c.id = :id`, { id });
  if (!r) throw notFound('Currency', id);
  return toCurrency(db, r);
}

export function saveCurrency(ctx: CompanyCtx, input: CurrencySaveInput): CurrencyRow {
  requireSavePermission(ctx, input.id);
  const { db } = ctx;
  const id = db.transaction(() => {
    const before = input.id !== undefined ? getCurrency(db, input.id) : null;
    const issues = new Issues();
    const symbol = input.symbol === undefined && before ? before.symbol : cleanText(input.symbol);
    const formalName = input.formalName === undefined && before ? before.formalName : cleanText(input.formalName);
    const isoRaw = input.isoCode === undefined ? (before?.isoCode ?? null) : cleanText(input.isoCode);
    const isoCode = isoRaw === null ? null : isoRaw.toUpperCase();
    const decimalPlaces = input.decimalPlaces ?? before?.decimalPlaces ?? 2;

    if (!symbol) issues.add('symbol', 'Currency symbol is required (e.g. $)');
    if (!formalName) issues.add('formalName', 'Formal name is required (e.g. US Dollar)');
    if (isoCode !== null && !/^[A-Z]{3}$/.test(isoCode)) issues.add('isoCode', 'ISO code must be 3 letters (e.g. USD)');
    if (decimalPlaces < 0 || decimalPlaces > 4) issues.add('decimalPlaces', 'Decimal places must be between 0 and 4');
    if (before?.isBase && isoCode !== before.isoCode) issues.add('isoCode', 'The ISO code of the base currency cannot be changed');
    if (symbol) {
      const clash = db.value<string>('SELECT formal_name FROM currencies WHERE symbol = :s AND id <> :id', { s: symbol, id: before?.id ?? 0 });
      if (clash !== undefined) issues.add('symbol', `Symbol '${symbol}' is already used by ${clash}. Choose a different symbol.`);
    }
    if (isoCode) {
      const clash = db.value<string>('SELECT formal_name FROM currencies WHERE iso_code = :c AND id <> :id', { c: isoCode, id: before?.id ?? 0 });
      if (clash !== undefined) issues.add('isoCode', `ISO code ${isoCode} is already used by ${clash}.`);
    }
    issues.throwIfAny();

    const ts = ctx.clock.now().toISOString();
    let cid: number;
    let guid: string;
    if (!before) {
      guid = randomUUID();
      cid = db.run(
        `INSERT INTO currencies (guid, symbol, formal_name, iso_code, decimal_places, is_base, created_at, updated_at)
         VALUES (:guid, :symbol, :formalName, :isoCode, :dp, 0, :ts, :ts)`,
        { guid, symbol, formalName, isoCode, dp: decimalPlaces, ts },
      ).lastInsertRowid;
    } else {
      cid = before.id;
      guid = before.guid;
      db.run(
        `UPDATE currencies SET symbol = :symbol, formal_name = :formalName, iso_code = :isoCode, decimal_places = :dp, updated_at = :ts
          WHERE id = :id`,
        { symbol, formalName, isoCode, dp: decimalPlaces, ts, id: cid },
      );
    }
    ctx.audit({
      action: before ? 'alter' : 'create',
      entityType: 'currency',
      entityId: cid,
      entityGuid: guid,
      entityLabel: formalName ?? '',
      before: before ?? undefined,
      after: getCurrency(db, cid),
    });
    return cid;
  });
  return getCurrency(db, id);
}

export function deleteCurrency(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete');
  const { db } = ctx;
  return db.transaction(() => {
    const before = getCurrency(db, id);
    if (before.isBase) throw rule(`${before.formalName} is the base currency of the company and cannot be deleted.`);
    if (before.ledgerCount > 0) {
      throw rule(`Currency ${before.formalName} cannot be deleted: ${plural(before.ledgerCount, 'ledger')} ${before.ledgerCount === 1 ? 'uses' : 'use'} it.`);
    }
    const rates = db.value<number>('SELECT COUNT(*) FROM exchange_rates WHERE currency_id = :id', { id }) ?? 0;
    db.run('DELETE FROM exchange_rates WHERE currency_id = :id', { id });
    db.run('DELETE FROM currencies WHERE id = :id', { id });
    ctx.audit({
      action: 'delete',
      entityType: 'currency',
      entityId: id,
      entityGuid: before.guid,
      entityLabel: before.formalName,
      before: { ...before, exchangeRatesDeleted: rates },
    });
    return { id, deleted: true };
  });
}

// ───────────────────────────── Exchange rates ─────────────────────────────

export function listExchangeRates(db: Db, input: ExchangeRateListInput): ListResult<ExchangeRateRow> {
  assertRange(input.from, input.to);
  if (db.value('SELECT 1 FROM currencies WHERE id = :id', { id: input.currencyId }) === undefined) throw notFound('Currency', input.currencyId);
  const rows = db
    .all<RateDbRow>(
      `SELECT * FROM exchange_rates WHERE currency_id = :id AND (:from IS NULL OR date >= :from) AND (:to IS NULL OR date <= :to)
        ORDER BY date DESC`,
      { id: input.currencyId, from: input.from ?? null, to: input.to ?? null },
    )
    .map(toRate);
  return { rows, total: rows.length };
}

/** Latest rate on or before `date` (null when none). For vouchers in foreign currency. */
export function exchangeRateOn(db: Db, currencyId: number, date: string): ExchangeRateRow | null {
  const r = db.get<RateDbRow>('SELECT * FROM exchange_rates WHERE currency_id = :id AND date <= :date ORDER BY date DESC LIMIT 1', {
    id: currencyId,
    date,
  });
  return r ? toRate(r) : null;
}

/** Upsert the rates of one currency on one date. Omitted rates keep their stored value; null clears. */
export function saveExchangeRate(ctx: CompanyCtx, input: ExchangeRateSaveInput): ExchangeRateRow {
  const { db } = ctx;
  const existing = db.get<RateDbRow>('SELECT * FROM exchange_rates WHERE currency_id = :id AND date = :date', {
    id: input.currencyId,
    date: input.date,
  });
  requireSavePermission(ctx, existing?.id);
  return db.transaction(() => {
    const cur = getCurrency(db, input.currencyId);
    if (cur.isBase) throw rule(`${cur.formalName} is the base currency; exchange rates are entered for foreign currencies only.`);
    const pick = (v: number | null | undefined, old: number | null | undefined): number | null => (v === undefined ? (old ?? null) : v);
    const standard = pick(input.standard, existing?.standard);
    const selling = pick(input.selling, existing?.selling);
    const buying = pick(input.buying, existing?.buying);
    const issues = new Issues();
    for (const [k, val] of [['standard', standard], ['selling', selling], ['buying', buying]] as const) {
      if (val !== null && !(val > 0)) issues.add(k, 'Exchange rate must be more than zero');
    }
    if (standard === null && selling === null && buying === null) issues.add('standard', 'Enter at least one rate (standard, selling or buying)');
    issues.throwIfAny();

    db.run(
      `INSERT INTO exchange_rates (currency_id, date, standard, selling, buying) VALUES (:id, :date, :standard, :selling, :buying)
       ON CONFLICT (currency_id, date) DO UPDATE SET standard = excluded.standard, selling = excluded.selling, buying = excluded.buying`,
      { id: input.currencyId, date: input.date, standard, selling, buying },
    );
    const after = toRate(
      db.get<RateDbRow>('SELECT * FROM exchange_rates WHERE currency_id = :id AND date = :date', { id: input.currencyId, date: input.date }) as RateDbRow,
    );
    ctx.audit({
      action: existing ? 'alter' : 'create',
      entityType: 'exchange_rate',
      entityId: after.id,
      entityLabel: `${cur.formalName} ${input.date}`,
      before: existing ? toRate(existing) : undefined,
      after,
    });
    return after;
  });
}

export function deleteExchangeRate(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete');
  const { db } = ctx;
  return db.transaction(() => {
    const row = db.get<RateDbRow>('SELECT * FROM exchange_rates WHERE id = :id', { id });
    if (!row) throw notFound('Exchange rate', id);
    const name = db.value<string>('SELECT formal_name FROM currencies WHERE id = :id', { id: row.currency_id }) ?? '';
    db.run('DELETE FROM exchange_rates WHERE id = :id', { id });
    ctx.audit({ action: 'delete', entityType: 'exchange_rate', entityId: id, entityLabel: `${name} ${row.date}`, before: toRate(row) });
    return { id, deleted: true };
  });
}

/**
 * Units of measure: simple units (symbol, formal name, GST UQC, decimal places) and compound units
 * (1 first unit = conversion × second unit, e.g. 1 Box = 12 Nos; both parts simple).
 */
import { isValidUqc, suggestUqc } from '../../../shared/gst/index.ts';
import type {
  CompoundUnitSaveInput,
  DeleteResult,
  ListResult,
  SimpleUnitSaveInput,
  UnitDto,
  UnitListInput,
  UnitSaveInput,
} from '../../../shared/types/inventory.ts';
import { randomUUID } from 'node:crypto';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import {
  assertNameFree,
  assertUnused,
  cleanText,
  countOf,
  likePattern,
  nowIso,
  paging,
  requirePermission,
  requireSavePermission,
  toBool,
} from './common.ts';

interface UnitRow {
  id: number;
  guid: string;
  symbol: string;
  formal_name: string | null;
  uqc: string | null;
  decimal_places: number;
  is_compound: number;
  first_unit_id: number | null;
  conversion: number | null;
  second_unit_id: number | null;
  created_at: string;
  updated_at: string;
  first_symbol: string | null;
  second_symbol: string | null;
  item_count: number;
}

const SELECT_UNIT = /* sql */ `
  SELECT u.*, f.symbol AS first_symbol, s.symbol AS second_symbol,
         (SELECT COUNT(*) FROM stock_items i WHERE i.unit_id = u.id OR i.alt_unit_id = u.id) AS item_count
  FROM units u
  LEFT JOIN units f ON f.id = u.first_unit_id
  LEFT JOIN units s ON s.id = u.second_unit_id`;

function toDto(r: UnitRow): UnitDto {
  return {
    id: r.id,
    guid: r.guid,
    symbol: r.symbol,
    formalName: r.formal_name,
    uqc: r.uqc,
    decimalPlaces: r.decimal_places,
    isCompound: toBool(r.is_compound),
    firstUnitId: r.first_unit_id,
    firstUnitSymbol: r.first_symbol,
    conversion: r.conversion,
    secondUnitId: r.second_unit_id,
    secondUnitSymbol: r.second_symbol,
    itemCount: Number(r.item_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listUnits(db: Db, input: UnitListInput = {}): ListResult<UnitDto> {
  const { limit, offset } = paging(input);
  const params = {
    like: likePattern(input.search),
    compound: input.kind === undefined ? null : input.kind === 'compound' ? 1 : 0,
  };
  const where = `WHERE (:like IS NULL OR u.symbol LIKE :like ESCAPE '\\' OR u.formal_name LIKE :like ESCAPE '\\')
                   AND (:compound IS NULL OR u.is_compound = :compound)`;
  const total = countOf(db, `SELECT COUNT(*) FROM units u ${where}`, params);
  const rows = db.all<UnitRow>(`${SELECT_UNIT} ${where} ORDER BY u.is_compound, u.symbol COLLATE NOCASE LIMIT :limit OFFSET :offset`, {
    ...params,
    limit,
    offset,
  });
  return { rows: rows.map(toDto), total };
}

export function getUnit(db: Db, id: number): UnitDto {
  const row = db.get<UnitRow>(`${SELECT_UNIT} WHERE u.id = :id`, { id });
  if (!row) throw notFound('Unit', id);
  return toDto(row);
}

/** Generated symbol of a compound unit: 'Box of 12 Nos'. */
export function compoundSymbol(first: string, conversion: number, second: string): string {
  return `${first} of ${Number(conversion.toPrecision(12))} ${second}`;
}

function simpleUnit(db: Db, id: number, path: string): { id: number; symbol: string; decimal_places: number; uqc: string | null } {
  const row = db.get<{ id: number; symbol: string; is_compound: number; decimal_places: number; uqc: string | null }>(
    'SELECT id, symbol, is_compound, decimal_places, uqc FROM units WHERE id = :id',
    { id },
  );
  if (!row) throw validation([{ path, message: 'The selected unit does not exist. Choose another unit.' }]);
  if (toBool(row.is_compound))
    throw validation([{ path, message: `'${row.symbol}' is itself a compound unit. A compound unit is made of two simple units.` }]);
  return row;
}

function usageOf(db: Db, id: number): { items: number; compounds: number } {
  return {
    items: countOf(db, 'SELECT COUNT(*) FROM stock_items WHERE unit_id = :id OR alt_unit_id = :id', { id }),
    compounds: countOf(db, 'SELECT COUNT(*) FROM units WHERE first_unit_id = :id OR second_unit_id = :id', { id }),
  };
}

export function saveUnit(ctx: CompanyCtx, input: UnitSaveInput): UnitDto {
  requireSavePermission(ctx, input.id, 'units');
  const { db } = ctx;
  const before = input.id !== undefined ? getUnit(db, input.id) : null;
  const ts = nowIso(ctx);
  const id = input.kind === 'compound' ? saveCompound(db, input, before, ts) : saveSimple(db, input, before, ts);
  const after = getUnit(db, id);
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'unit',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: after.symbol,
    before: before ?? undefined,
    after,
  });
  return after;
}

function saveSimple(db: Db, input: SimpleUnitSaveInput, before: UnitDto | null, ts: string): number {
  if (before?.isCompound) throw rule(`'${before.symbol}' is a compound unit. Save it as a compound unit (first unit, conversion, second unit).`);
  const symbol = input.symbol.trim();
  if (!symbol) throw validation([{ path: 'symbol', message: 'Enter the unit symbol, e.g. Nos or Kg' }]);
  if (/\s/.test(symbol))
    throw validation([{ path: 'symbol', message: 'A unit symbol cannot contain spaces (use the formal name for the full description)' }]);
  assertNameFree(db, 'units', symbol, before?.id ?? null, 'symbol', 'Unit', false);
  const formalName = cleanText(input.formalName) ?? null;
  let uqc = cleanText(input.uqc)?.toUpperCase() ?? null;
  if (uqc === null) {
    uqc = suggestUqc(symbol);
    if (uqc === 'OTH' && formalName) uqc = suggestUqc(formalName);
  } else if (!isValidUqc(uqc)) {
    throw validation([{ path: 'uqc', message: `'${uqc}' is not a GST Unique Quantity Code (UQC). Pick one from the list, e.g. NOS, KGS or OTH.` }]);
  }
  const decimals = input.decimalPlaces ?? 0;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4)
    throw validation([{ path: 'decimalPlaces', message: 'Decimal places must be a whole number from 0 to 4' }]);

  if (before) {
    db.run(
      `UPDATE units SET symbol = :symbol, formal_name = :formal, uqc = :uqc, decimal_places = :dp, updated_at = :ts WHERE id = :id`,
      { id: before.id, symbol, formal: formalName, uqc, dp: decimals, ts },
    );
    // Keep generated symbols of compound units built from this unit in step with the rename.
    if (before.symbol !== symbol) refreshCompoundSymbols(db, before.id, ts);
    return before.id;
  }
  return db.run(
    `INSERT INTO units (guid, symbol, formal_name, uqc, decimal_places, is_compound, created_at, updated_at)
     VALUES (:guid, :symbol, :formal, :uqc, :dp, 0, :ts, :ts)`,
    { guid: randomUUID(), symbol, formal: formalName, uqc, dp: decimals, ts },
  ).lastInsertRowid;
}

function refreshCompoundSymbols(db: Db, simpleId: number, ts: string): void {
  const rows = db.all<{ id: number; conversion: number; f: string; s: string }>(
    `SELECT u.id, u.conversion, f.symbol AS f, s.symbol AS s FROM units u
     JOIN units f ON f.id = u.first_unit_id JOIN units s ON s.id = u.second_unit_id
     WHERE u.is_compound = 1 AND (u.first_unit_id = :id OR u.second_unit_id = :id)`,
    { id: simpleId },
  );
  for (const r of rows) {
    db.run('UPDATE units SET symbol = :symbol, updated_at = :ts WHERE id = :id', { id: r.id, symbol: compoundSymbol(r.f, r.conversion, r.s), ts });
  }
}

function saveCompound(db: Db, input: CompoundUnitSaveInput, before: UnitDto | null, ts: string): number {
  if (before && !before.isCompound) throw rule(`'${before.symbol}' is a simple unit. A simple unit cannot be turned into a compound unit.`);
  const first = simpleUnit(db, input.firstUnitId, 'firstUnitId');
  const second = simpleUnit(db, input.secondUnitId, 'secondUnitId');
  if (first.id === second.id)
    throw validation([{ path: 'secondUnitId', message: 'The first and second units of a compound unit must be different' }]);
  if (!(input.conversion > 0) || !Number.isFinite(input.conversion))
    throw validation([{ path: 'conversion', message: 'Conversion must be more than 0 (e.g. 1 Box = 12 Nos → 12)' }]);
  const symbol = compoundSymbol(first.symbol, input.conversion, second.symbol);
  const dup = db.value<number>(
    `SELECT id FROM units WHERE is_compound = 1 AND first_unit_id = :f AND second_unit_id = :s AND abs(conversion - :c) < 1e-9 AND id IS NOT :exclude`,
    { f: first.id, s: second.id, c: input.conversion, exclude: before?.id ?? null },
  );
  if (dup !== undefined) throw validation([{ path: 'conversion', message: `Compound unit '${symbol}' already exists` }]);
  assertNameFree(db, 'units', symbol, before?.id ?? null, 'conversion', 'Unit', false);

  if (before) {
    const changed = before.firstUnitId !== first.id || before.secondUnitId !== second.id || before.conversion !== input.conversion;
    if (changed && before.itemCount > 0)
      throw rule(
        `Compound unit '${before.symbol}' is used by ${before.itemCount} stock item(s); its units and conversion cannot change because existing quantities would change meaning. Create a new compound unit instead.`,
      );
    db.run(
      `UPDATE units SET symbol = :symbol, first_unit_id = :f, conversion = :c, second_unit_id = :s, decimal_places = :dp, uqc = :uqc,
              updated_at = :ts WHERE id = :id`,
      { id: before.id, symbol, f: first.id, c: input.conversion, s: second.id, dp: second.decimal_places, uqc: first.uqc, ts },
    );
    return before.id;
  }
  return db.run(
    `INSERT INTO units (guid, symbol, formal_name, uqc, decimal_places, is_compound, first_unit_id, conversion, second_unit_id, created_at, updated_at)
     VALUES (:guid, :symbol, NULL, :uqc, :dp, 1, :f, :c, :s, :ts, :ts)`,
    { guid: randomUUID(), symbol, uqc: first.uqc, dp: second.decimal_places, f: first.id, c: input.conversion, s: second.id, ts },
  ).lastInsertRowid;
}

export function deleteUnit(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.delete', 'delete units');
  const { db } = ctx;
  const before = getUnit(db, id);
  const use = usageOf(db, id);
  assertUnused('unit', before.symbol, [
    [use.items, 'stock item(s)'],
    [use.compounds, 'compound unit(s)'],
  ]);
  db.run('DELETE FROM units WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'unit', entityId: id, entityGuid: before.guid, entityLabel: before.symbol, before });
  return { id, deleted: true };
}

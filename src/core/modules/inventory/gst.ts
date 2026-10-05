/**
 * GST details of stock groups and stock items: validation, effective-dated history and the
 * GST profile resolver used by vouchers, the item picker and reports.
 *
 * Resolution precedence for a stock item on a date (resolveItemGstProfile) — the vouchers engine
 * must use exactly this (import it rather than re-implementing):
 *   1. gst_rate_history row of the item with applicable_from ≤ date (the latest one);
 *   2. the item's own columns, when gst_applicable = 'applicable' and the details are complete
 *      (a rate is set, or the taxability is exempt / nil_rated / non_gst);
 *   3. the stock group chain, nearest group first: for each group its history row (≤ date, latest),
 *      then its columns under the same completeness rule;
 *   4. null — the caller falls back to the sales/purchase ledger.
 * A profile always comes from ONE source as a whole (rate, cess, taxability and HSN together).
 */
import { isStandardRate, isValidCessRate, isValidRate, TAXABILITIES } from '../../../shared/gst/index.ts';
import { formatDate } from '../../../shared/dates.ts';
import type { GstFieldsInput, GstHistoryRow, ItemGstProfile, Taxability } from '../../../shared/types/inventory.ts';
import { validateHsnSac } from '../../../shared/validators.ts';
import type { Db } from '../../db/db.ts';
import { rule, validation } from '../../lib/errors.ts';

export type GstEntityType = 'stock_group' | 'stock_item';

/** Normalised GST details as stored on a master row. */
export interface GstDetails {
  applicable: boolean;
  hsnSac: string | null;
  taxability: Taxability;
  rate: number | null;
  cessRate: number | null;
  cessPerUnit: number;
}

interface GstColumns {
  gst_applicable: string;
  gst_taxability: string | null;
  gst_rate: number | null;
  cess_rate: number | null;
  cess_per_unit: number | null;
  hsn_sac: string | null;
}

interface HistoryRow {
  id: number;
  entity_id: number;
  applicable_from: string;
  hsn_sac: string | null;
  taxability: string;
  rate: number;
  cess_rate: number;
  cess_per_unit: number;
}

const asTaxability = (t: string | null | undefined): Taxability =>
  (TAXABILITIES as readonly string[]).includes(t ?? '') ? (t as Taxability) : 'taxable';

export function detailsFromColumns(row: GstColumns): GstDetails {
  return {
    applicable: row.gst_applicable === 'applicable',
    hsnSac: row.hsn_sac,
    taxability: asTaxability(row.gst_taxability),
    rate: row.gst_rate,
    cessRate: row.cess_rate,
    cessPerUnit: Number(row.cess_per_unit ?? 0),
  };
}

const sameDetails = (a: GstDetails, b: GstDetails): boolean =>
  a.applicable === b.applicable &&
  a.hsnSac === b.hsnSac &&
  a.taxability === b.taxability &&
  (a.rate ?? 0) === (b.rate ?? 0) &&
  (a.cessRate ?? 0) === (b.cessRate ?? 0) &&
  a.cessPerUnit === b.cessPerUnit;

/** Normalise an HSN/SAC entry (spaces removed); null when blank. */
export function normalizeHsn(code: string | null | undefined): string | null {
  const c = (code ?? '').replace(/\s+/g, '');
  return c === '' ? null : c;
}

/**
 * Validate and merge GST input over the current details (null for a new master).
 * `kind` decides HSN (goods) vs SAC (services) checks.
 */
export function normalizeGstDetails(input: GstFieldsInput, current: GstDetails | null, kind: 'goods' | 'services' | null): GstDetails {
  const hsnSac = input.hsnSac !== undefined ? normalizeHsn(input.hsnSac) : (current?.hsnSac ?? null);
  const taxability = input.taxability ?? current?.taxability ?? 'taxable';
  let rate = input.gstRate !== undefined ? input.gstRate : (current?.rate ?? null);
  let cessRate = input.cessRate !== undefined ? input.cessRate : (current?.cessRate ?? null);
  let cessPerUnit = input.cessPerUnit !== undefined ? (input.cessPerUnit ?? 0) : (current?.cessPerUnit ?? 0);
  const ownDetailsGiven = (input.gstRate !== undefined && input.gstRate !== null) || (input.taxability !== undefined && input.taxability !== 'taxable');
  const applicable = input.gstApplicable ?? (current?.applicable || ownDetailsGiven);

  if (hsnSac !== null) {
    const err = validateHsnSac(hsnSac, kind ?? undefined);
    if (err) throw validation([{ path: 'hsnSac', message: err }]);
  }
  if (taxability !== 'taxable') {
    const label = taxability === 'nil_rated' ? 'Nil-rated' : taxability === 'exempt' ? 'Exempt' : 'Non-GST';
    if (rate !== null && rate !== 0)
      throw validation([{ path: 'gstRate', message: `${label} goods/services carry no GST: set the GST rate to 0, or change the taxability to Taxable` }]);
    if ((cessRate ?? 0) !== 0 || cessPerUnit !== 0)
      throw validation([{ path: 'cessRate', message: `${label} goods/services carry no cess: set the cess to 0, or change the taxability to Taxable` }]);
    rate = 0;
    cessRate = 0;
    cessPerUnit = 0;
  } else if (applicable && rate === null) {
    throw validation([
      { path: 'gstRate', message: 'Enter the GST rate (e.g. 18), or turn off GST details here to use the stock group / ledger rate' },
    ]);
  }
  if (rate !== null) {
    if (!isValidRate(rate)) throw validation([{ path: 'gstRate', message: 'GST rate must be between 0 and 100' }]);
    if (!isStandardRate(rate) && !input.allowNonStandardRate)
      throw validation([
        {
          path: 'gstRate',
          message: `${rate}% is not a notified GST rate (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28 or 40). Tick 'Allow non-standard rate' if it is correct.`,
        },
      ]);
  }
  if (cessRate !== null && !isValidCessRate(cessRate))
    throw validation([{ path: 'cessRate', message: 'Cess rate must be between 0 and 400' }]);
  if (!Number.isSafeInteger(cessPerUnit) || cessPerUnit < 0)
    throw validation([{ path: 'cessPerUnit', message: 'Cess per unit must be zero or more (in paise)' }]);
  return { applicable, hsnSac, taxability, rate, cessRate, cessPerUnit };
}

export function listGstHistory(db: Db, entityType: GstEntityType, id: number): GstHistoryRow[] {
  return db
    .all<HistoryRow>(
      `SELECT id, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
       WHERE entity_type = :t AND entity_id = :id ORDER BY applicable_from`,
      { t: entityType, id },
    )
    .map((h) => ({
      id: h.id,
      applicableFrom: h.applicable_from,
      hsnSac: h.hsn_sac,
      taxability: asTaxability(h.taxability),
      rate: h.rate,
      cessRate: h.cess_rate,
      cessPerUnit: Number(h.cess_per_unit),
    }));
}

function upsertHistory(db: Db, entityType: GstEntityType, id: number, from: string, d: GstDetails): void {
  db.run(
    `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit)
     VALUES (:t, :id, :from, :hsn, :tax, :rate, :cess, :cpu)
     ON CONFLICT(entity_type, entity_id, applicable_from) DO UPDATE SET
       hsn_sac = excluded.hsn_sac, taxability = excluded.taxability, rate = excluded.rate,
       cess_rate = excluded.cess_rate, cess_per_unit = excluded.cess_per_unit`,
    { t: entityType, id, from, hsn: d.hsnSac, tax: d.taxability, rate: d.rate ?? 0, cess: d.cessRate ?? 0, cpu: d.cessPerUnit },
  );
}

export function deleteGstHistory(db: Db, entityType: GstEntityType, id: number): void {
  db.run('DELETE FROM gst_rate_history WHERE entity_type = :t AND entity_id = :id', { t: entityType, id });
}

/**
 * Keep gst_rate_history in step with a save (call after the master row is written):
 *  - GST details turned off → the master's history is removed (it then inherits again).
 *  - `applicableFrom` given → the details are recorded from that date (row replaced if the date exists).
 *    When this introduces history for a master that already had details from its columns, those
 *    earlier details are first recorded from the books-beginning date so older dates keep them.
 *  - Details changed without a date while dated history exists → refused (the date is needed so
 *    earlier invoices keep the earlier rate).
 */
export function syncGstHistory(
  db: Db,
  entityType: GstEntityType,
  id: number,
  label: string,
  prev: GstDetails | null,
  next: GstDetails,
  applicableFrom: string | undefined,
  booksFrom: string,
): void {
  if (!next.applicable) {
    deleteGstHistory(db, entityType, id);
    return;
  }
  const changed = prev === null || !sameDetails(prev, next);
  const latest = db.value<string>(
    'SELECT MAX(applicable_from) FROM gst_rate_history WHERE entity_type = :t AND entity_id = :id',
    { t: entityType, id },
  );
  if (applicableFrom !== undefined) {
    if (latest === null || latest === undefined) {
      if (prev && prev.applicable && changed && applicableFrom > booksFrom) upsertHistory(db, entityType, id, booksFrom, prev);
    }
    upsertHistory(db, entityType, id, applicableFrom, next);
    return;
  }
  if (changed && latest !== null && latest !== undefined) {
    throw rule(
      `The GST details of '${label}' have dated history (latest change from ${formatDate(latest)}). ` +
        `Enter 'Applicable from' for the new details so that earlier entries keep the earlier rate.`,
    );
  }
}

// ───────────────────────────── Resolution ─────────────────────────────

function columnsComplete(row: GstColumns): boolean {
  if (row.gst_applicable !== 'applicable') return false;
  const tax = asTaxability(row.gst_taxability);
  return row.gst_rate !== null || (row.gst_taxability !== null && tax !== 'taxable');
}

function fromColumns(source: 'item' | 'group', sourceId: number, row: GstColumns): ItemGstProfile {
  const taxability = asTaxability(row.gst_taxability);
  const taxable = taxability === 'taxable';
  return {
    source,
    sourceId,
    applicableFrom: null,
    taxability,
    rate: taxable ? (row.gst_rate ?? 0) : 0,
    cessRate: taxable ? (row.cess_rate ?? 0) : 0,
    cessPerUnit: taxable ? Number(row.cess_per_unit ?? 0) : 0,
    hsnSac: row.hsn_sac,
  };
}

function fromHistory(source: 'item_history' | 'group_history', sourceId: number, h: HistoryRow): ItemGstProfile {
  const taxability = asTaxability(h.taxability);
  const taxable = taxability === 'taxable';
  return {
    source,
    sourceId,
    applicableFrom: h.applicable_from,
    taxability,
    rate: taxable ? h.rate : 0,
    cessRate: taxable ? h.cess_rate : 0,
    cessPerUnit: taxable ? Number(h.cess_per_unit) : 0,
    hsnSac: h.hsn_sac,
  };
}

const HISTORY_AT = /* sql */ `
  SELECT id, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
  WHERE entity_type = :t AND entity_id = :id AND applicable_from <= :date
  ORDER BY applicable_from DESC LIMIT 1`;

const GST_COLS = 'gst_applicable, gst_taxability, gst_rate, cess_rate, cess_per_unit, hsn_sac';

/**
 * GST profile of a stock item on `date` (see the precedence at the top of this file).
 * Returns null when neither the item nor its groups define GST details, or the item does not exist.
 */
export function resolveItemGstProfile(db: Db, itemId: number, date: string): ItemGstProfile | null {
  const h = db.get<HistoryRow>(HISTORY_AT, { t: 'stock_item', id: itemId, date });
  if (h) return fromHistory('item_history', itemId, h);
  const item = db.get<GstColumns & { group_id: number | null }>(`SELECT group_id, ${GST_COLS} FROM stock_items WHERE id = :id`, { id: itemId });
  if (!item) return null;
  if (columnsComplete(item)) return fromColumns('item', itemId, item);
  return resolveGroupGstProfile(db, item.group_id, date);
}

/** GST profile defined by a stock group (or its ancestors) on `date`; null when none. */
export function resolveGroupGstProfile(db: Db, groupId: number | null, date: string): ItemGstProfile | null {
  const seen = new Set<number>();
  let gid = groupId;
  while (gid !== null && !seen.has(gid)) {
    seen.add(gid);
    const gh = db.get<HistoryRow>(HISTORY_AT, { t: 'stock_group', id: gid, date });
    if (gh) return fromHistory('group_history', gid, gh);
    const g = db.get<GstColumns & { parent_id: number | null }>(`SELECT parent_id, ${GST_COLS} FROM stock_groups WHERE id = :id`, { id: gid });
    if (!g) return null;
    if (columnsComplete(g)) return fromColumns('group', gid, g);
    gid = g.parent_id;
  }
  return null;
}

export interface ItemGstSource extends GstColumns {
  id: number;
  group_id: number | null;
}

/**
 * Bulk resolver for many items on one date (item picker, imports): preloads all history rows and
 * groups once. `resolve(item)` gives exactly what resolveItemGstProfile would.
 */
export function createGstResolver(db: Db, date: string): (item: ItemGstSource) => ItemGstProfile | null {
  const latest = (t: GstEntityType): Map<number, HistoryRow> => {
    const out = new Map<number, HistoryRow>();
    const rows = db.all<HistoryRow>(
      `SELECT id, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
       WHERE entity_type = :t AND applicable_from <= :date ORDER BY entity_id, applicable_from`,
      { t, date },
    );
    for (const r of rows) out.set(r.entity_id, r); // ordered ascending → last write is the latest
    return out;
  };
  const itemHistory = latest('stock_item');
  const groupHistory = latest('stock_group');
  const groups = new Map<number, GstColumns & { id: number; parent_id: number | null }>();
  for (const g of db.all<GstColumns & { id: number; parent_id: number | null }>(`SELECT id, parent_id, ${GST_COLS} FROM stock_groups`)) {
    groups.set(g.id, g);
  }
  const groupMemo = new Map<number, ItemGstProfile | null>();
  const resolveGroup = (start: number | null): ItemGstProfile | null => {
    const chain: number[] = [];
    let gid = start;
    let found: ItemGstProfile | null = null;
    const seen = new Set<number>();
    while (gid !== null && !seen.has(gid)) {
      if (groupMemo.has(gid)) {
        found = groupMemo.get(gid) ?? null;
        break;
      }
      seen.add(gid);
      chain.push(gid);
      const gh = groupHistory.get(gid);
      if (gh) {
        found = fromHistory('group_history', gid, gh);
        break;
      }
      const g = groups.get(gid);
      if (!g) break;
      if (columnsComplete(g)) {
        found = fromColumns('group', gid, g);
        break;
      }
      gid = g.parent_id;
    }
    for (const id of chain) groupMemo.set(id, found);
    return found;
  };
  return (item) => {
    const h = itemHistory.get(item.id);
    if (h) return fromHistory('item_history', item.id, h);
    if (columnsComplete(item)) return fromColumns('item', item.id, item);
    return resolveGroup(item.group_id);
  };
}

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
 * Rate, cess and taxability come from the one level that resolved. HSN/SAC comes from that level
 * too; when it has none, from the first non-empty HSN/SAC along the same chain in the same order
 * (item history, item columns — even incomplete ones — then each group's history and columns).
 * This matches vouchers/taxprofile.ts (levels 2–4 of its item precedence).
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

/**
 * Normalised details of a master row. `applicable` is true only when the row's own details are
 * usable for resolution (see columnsComplete): a row marked 'applicable' without a rate (e.g. the
 * stock_items column default) is treated as "no own GST details".
 */
export function detailsFromColumns(row: GstColumns): GstDetails {
  return {
    applicable: columnsComplete(row),
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
 *  - GST details explicitly turned off (gstApplicable: false) → the master's history is removed
 *    (it then inherits from its group / the ledger again).
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
  input: Pick<GstFieldsInput, 'gstApplicable' | 'gstApplicableFrom'>,
  booksFrom: string,
): void {
  const applicableFrom = input.gstApplicableFrom;
  if (!next.applicable) {
    // Only an explicit "GST details: off" removes dated history (never a plain rename).
    if (input.gstApplicable === false) deleteGstHistory(db, entityType, id);
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

/** The row's own GST details are usable: marked applicable AND (a rate is set OR the taxability is not 'taxable'). */
export function columnsComplete(row: GstColumns): boolean {
  if (row.gst_applicable !== 'applicable') return false;
  const tax = asTaxability(row.gst_taxability);
  return row.gst_rate !== null || (row.gst_taxability !== null && tax !== 'taxable');
}

/** Trimmed HSN/SAC; null when blank. */
const hsnOf = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

function fromColumns(source: 'item' | 'group', sourceId: number, row: GstColumns): ItemGstProfile {
  const taxability = asTaxability(row.gst_taxability);
  const taxable = taxability === 'taxable';
  return {
    source,
    sourceId,
    applicableFrom: null,
    taxability,
    rate: taxable ? Number(row.gst_rate ?? 0) : 0,
    cessRate: taxable ? Number(row.cess_rate ?? 0) : 0,
    cessPerUnit: taxable ? Number(row.cess_per_unit ?? 0) : 0,
    hsnSac: hsnOf(row.hsn_sac),
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
    rate: taxable ? Number(h.rate) || 0 : 0,
    cessRate: taxable ? Number(h.cess_rate) || 0 : 0,
    cessPerUnit: taxable ? Number(h.cess_per_unit) || 0 : 0,
    hsnSac: hsnOf(h.hsn_sac),
  };
}

const HISTORY_AT = /* sql */ `
  SELECT id, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
  WHERE entity_type = :t AND entity_id = :id AND applicable_from <= :date
  ORDER BY applicable_from DESC LIMIT 1`;

const GST_COLS = 'gst_applicable, gst_taxability, gst_rate, cess_rate, cess_per_unit, hsn_sac';

/** Same cap as the vouchers engine (a group tree is never this deep; cycles are refused on save). */
const MAX_GROUP_DEPTH = 64;

/** One precedence level: the profile it defines (if complete) and the HSN/SAC it carries (even if incomplete). */
interface Level {
  profile: ItemGstProfile | null;
  hsn: string | null;
}

/**
 * First level that defines a profile; its HSN/SAC, or — when that level has none — the first
 * non-empty HSN/SAC of any level in precedence order (vouchers/taxprofile.ts does the same).
 */
function pickProfile(levels: Iterable<Level>): ItemGstProfile | null {
  let found: ItemGstProfile | null = null;
  let firstHsn: string | null = null;
  for (const l of levels) {
    if (firstHsn === null && l.hsn !== null) firstHsn = l.hsn;
    if (found === null && l.profile !== null) {
      found = l.profile;
      if (found.hsnSac !== null) return found;
    }
    if (found !== null && firstHsn !== null) break;
  }
  if (found === null) return null;
  return { ...found, hsnSac: firstHsn };
}

function* groupLevels(db: Db, groupId: number | null, date: string): Generator<Level> {
  const seen = new Set<number>();
  let gid = groupId;
  for (let depth = 0; gid !== null && depth < MAX_GROUP_DEPTH && !seen.has(gid); depth++) {
    seen.add(gid);
    const gh = db.get<HistoryRow>(HISTORY_AT, { t: 'stock_group', id: gid, date });
    yield { profile: gh ? fromHistory('group_history', gid, gh) : null, hsn: hsnOf(gh?.hsn_sac) };
    const g = db.get<GstColumns & { parent_id: number | null }>(`SELECT parent_id, ${GST_COLS} FROM stock_groups WHERE id = :id`, { id: gid });
    if (!g) return;
    yield { profile: columnsComplete(g) ? fromColumns('group', gid, g) : null, hsn: hsnOf(g.hsn_sac) };
    gid = g.parent_id;
  }
}

function* itemLevels(db: Db, itemId: number, item: GstColumns & { group_id: number | null }, date: string): Generator<Level> {
  const h = db.get<HistoryRow>(HISTORY_AT, { t: 'stock_item', id: itemId, date });
  yield { profile: h ? fromHistory('item_history', itemId, h) : null, hsn: hsnOf(h?.hsn_sac) };
  yield { profile: columnsComplete(item) ? fromColumns('item', itemId, item) : null, hsn: hsnOf(item.hsn_sac) };
  yield* groupLevels(db, item.group_id, date);
}

/**
 * GST profile of a stock item on `date` (see the precedence at the top of this file).
 * HSN/SAC comes from the level that resolved the rate; when that level has none, the first non-empty
 * HSN/SAC along the same chain (item history, item, then each group's history and columns).
 * Returns null when neither the item nor its groups define GST details, or the item does not exist.
 */
export function resolveItemGstProfile(db: Db, itemId: number, date: string): ItemGstProfile | null {
  const item = db.get<GstColumns & { group_id: number | null }>(`SELECT group_id, ${GST_COLS} FROM stock_items WHERE id = :id`, { id: itemId });
  if (!item) return null;
  return pickProfile(itemLevels(db, itemId, item, date));
}

/** GST profile defined by a stock group (or its ancestors) on `date`; null when none. */
export function resolveGroupGstProfile(db: Db, groupId: number | null, date: string): ItemGstProfile | null {
  return pickProfile(groupLevels(db, groupId, date));
}

export interface ItemGstSource extends GstColumns {
  id: number;
  group_id: number | null;
}

interface ChainInfo {
  /** First profile defined along the chain (with its own HSN, possibly null). */
  profile: ItemGstProfile | null;
  /** First non-empty HSN/SAC along the whole chain. */
  firstHsn: string | null;
}

const EMPTY_CHAIN: ChainInfo = { profile: null, firstHsn: null };

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
  const memo = new Map<number, ChainInfo>();
  const chainInfo = (start: number | null): ChainInfo => {
    // Walk up to a memoised group (or the root), then fill the memo top-down.
    const chain: number[] = [];
    const seen = new Set<number>();
    let gid = start;
    let tail: ChainInfo = EMPTY_CHAIN;
    while (gid !== null && !seen.has(gid)) {
      const hit = memo.get(gid);
      if (hit) {
        tail = hit;
        break;
      }
      seen.add(gid);
      chain.push(gid);
      gid = groups.get(gid)?.parent_id ?? null;
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      const id = chain[k];
      const gh = groupHistory.get(id);
      const g = groups.get(id);
      // A missing group ends the chain (as in resolveItemGstProfile): only its history row counts.
      const next = g ? tail : EMPTY_CHAIN;
      const own = gh ? fromHistory('group_history', id, gh) : g && columnsComplete(g) ? fromColumns('group', id, g) : null;
      tail = {
        profile: own ?? next.profile,
        firstHsn: hsnOf(gh?.hsn_sac) ?? hsnOf(g?.hsn_sac) ?? next.firstHsn,
      };
      memo.set(id, tail);
    }
    return tail;
  };
  return (item) => {
    const h = itemHistory.get(item.id);
    const own = h ? fromHistory('item_history', item.id, h) : columnsComplete(item) ? fromColumns('item', item.id, item) : null;
    if (own && own.hsnSac !== null) return own;
    const chain = chainInfo(item.group_id);
    const found = own ?? chain.profile;
    if (!found) return null;
    if (found.hsnSac !== null) return found;
    return { ...found, hsnSac: hsnOf(h?.hsn_sac) ?? hsnOf(item.hsn_sac) ?? chain.firstHsn };
  };
}

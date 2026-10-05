/**
 * GST rate resolution for voucher lines. The inventory pickers implement the SAME precedence — keep it
 * exactly this (documented in README.md):
 *
 * Item line:
 *   1. line gstRateOverride (taxable at that rate; HSN / cess still come from the masters below)
 *   2. latest gst_rate_history row of the stock item with applicable_from ≤ date
 *   3. stock_items columns, when gst_applicable = 'applicable' and the details are complete
 *   4. stock group chain, nearest first: each group's history row, then its columns
 *   5. the line's sales/purchase ledger: history row, then columns
 *   6. taxable at 0% with `missing: true` (the engine reports a 'gst_missing_rate' warning)
 *
 * Ledger line (accounting invoices and additional ledgers):
 *   1. line `gst` override (merged over 2–4)   2. ledger history   3. ledger columns
 *   4. not GST-applicable → taxability 'non_gst'
 *
 * "Complete" column details: gst_applicable = 'applicable' AND (a rate is set OR the taxability is
 * exempt / nil_rated / non_gst). A taxable master without a rate is skipped (items, groups) — for a
 * ledger's own columns it resolves to 0% with `missing: true`.
 * HSN/SAC: from the level that resolved the rate, else the first non-empty HSN along the same chain.
 */
import type { Paise } from '../../../shared/money.ts';
import type { SupplyKind, Taxability } from '../../../shared/types/gst.ts';
import type { LedgerLineGstInput } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';

export type TaxProfileSource =
  | 'override'
  | 'item_history'
  | 'item'
  | 'stock_group_history'
  | 'stock_group'
  | 'ledger_history'
  | 'ledger'
  | 'default'
  | 'not_applicable';

export interface TaxProfile {
  taxability: Taxability;
  /** IGST-equivalent rate percent (0 unless taxable). */
  rate: number;
  cessRate: number;
  /** Specific cess, paise per unit (items only). */
  cessPerUnit: Paise;
  hsnSac: string;
  source: TaxProfileSource;
  /** No rate found anywhere: taxed at 0% (warn the user). */
  missing: boolean;
}

export interface LedgerTaxProfile extends TaxProfile {
  supplyKind: SupplyKind;
}

/** GST columns shared by stock_items / stock_groups / ledgers. */
export interface GstColumns {
  gst_applicable: string | null;
  gst_taxability: string | null;
  gst_rate: number | null;
  cess_rate: number | null;
  hsn_sac: string | null;
  cess_per_unit?: number | null;
}

export interface GstHistoryRow {
  applicable_from: string;
  hsn_sac: string | null;
  taxability: string;
  rate: number;
  cess_rate: number;
  cess_per_unit: number;
}

export interface TaxLookup {
  item(id: number): (GstColumns & { group_id: number | null }) | undefined;
  stockGroup(id: number): (GstColumns & { parent_id: number | null }) | undefined;
  ledger(id: number): (GstColumns & { gst_supply_type: string | null }) | undefined;
  history(entityType: 'stock_item' | 'stock_group' | 'ledger', entityId: number, date: string): GstHistoryRow | undefined;
}

const TAXABILITY_SET: ReadonlySet<string> = new Set(['taxable', 'exempt', 'nil_rated', 'non_gst']);

function asTaxability(s: string | null | undefined): Taxability {
  return s && TAXABILITY_SET.has(s) ? (s as Taxability) : 'taxable';
}

type Resolved = Omit<TaxProfile, 'source' | 'missing'>;

function fromHistory(h: GstHistoryRow | undefined): Resolved | null {
  if (!h) return null;
  const taxability = asTaxability(h.taxability);
  return {
    taxability,
    rate: taxability === 'taxable' ? Number(h.rate) || 0 : 0,
    cessRate: taxability === 'taxable' ? Number(h.cess_rate) || 0 : 0,
    cessPerUnit: taxability === 'taxable' ? Number(h.cess_per_unit) || 0 : 0,
    hsnSac: (h.hsn_sac ?? '').trim(),
  };
}

/** Complete column details, else null (see header). */
function fromColumns(c: GstColumns | undefined): Resolved | null {
  if (!c || c.gst_applicable !== 'applicable') return null;
  const taxability = asTaxability(c.gst_taxability);
  if (taxability === 'taxable' && (c.gst_rate === null || c.gst_rate === undefined)) return null;
  return {
    taxability,
    rate: taxability === 'taxable' ? Number(c.gst_rate) || 0 : 0,
    cessRate: taxability === 'taxable' ? Number(c.cess_rate) || 0 : 0,
    cessPerUnit: taxability === 'taxable' ? Number(c.cess_per_unit) || 0 : 0,
    hsnSac: (c.hsn_sac ?? '').trim(),
  };
}

const MAX_GROUP_DEPTH = 64;

export interface ItemTaxQuery {
  itemId: number;
  date: string;
  /** The line's sales/purchase ledger (level 5). */
  ledgerId?: number | null;
  gstRateOverride?: number | null;
}

/** Resolve the GST profile of an item line (see the precedence in the module header). */
export function resolveItemTaxProfile(lookup: TaxLookup, q: ItemTaxQuery): TaxProfile {
  const item = lookup.item(q.itemId);
  const hsnCandidates: string[] = [];
  const note = (r: Resolved | null, raw?: string | null): void => {
    const h = (r?.hsnSac || raw || '').trim();
    if (h) hsnCandidates.push(h);
  };

  const levels: Array<() => { r: Resolved | null; source: TaxProfileSource }> = [];
  levels.push(() => {
    const r = fromHistory(lookup.history('stock_item', q.itemId, q.date));
    note(r);
    return { r, source: 'item_history' };
  });
  levels.push(() => {
    const r = fromColumns(item);
    note(r, item?.hsn_sac);
    return { r, source: 'item' };
  });
  // Stock group chain, nearest first.
  let gid = item?.group_id ?? null;
  const seen = new Set<number>();
  for (let depth = 0; gid !== null && depth < MAX_GROUP_DEPTH && !seen.has(gid); depth++) {
    seen.add(gid);
    const groupId = gid;
    const group = lookup.stockGroup(groupId);
    levels.push(() => {
      const r = fromHistory(lookup.history('stock_group', groupId, q.date));
      note(r);
      return { r, source: 'stock_group_history' };
    });
    levels.push(() => {
      const r = fromColumns(group);
      note(r, group?.hsn_sac);
      return { r, source: 'stock_group' };
    });
    gid = group?.parent_id ?? null;
  }
  if (q.ledgerId) {
    const ledgerId = q.ledgerId;
    const ledger = lookup.ledger(ledgerId);
    levels.push(() => {
      const r = fromHistory(lookup.history('ledger', ledgerId, q.date));
      note(r);
      return { r, source: 'ledger_history' };
    });
    levels.push(() => {
      const r = fromColumns(ledger);
      note(r, ledger?.hsn_sac);
      return { r, source: 'ledger' };
    });
  }

  let found: { r: Resolved; source: TaxProfileSource } | null = null;
  for (const level of levels) {
    const out = level();
    if (out.r) {
      found = { r: out.r, source: out.source };
      break;
    }
  }
  // HSN fallback: keep walking for an HSN when the resolving level had none.
  if (!found || !found.r.hsnSac) {
    if (hsnCandidates.length === 0) {
      for (const level of levels) {
        level();
        if (hsnCandidates.length > 0) break;
      }
    }
  }
  const hsn = (found?.r.hsnSac || hsnCandidates[0] || item?.hsn_sac || '').trim();

  const override = q.gstRateOverride;
  if (override !== undefined && override !== null && Number.isFinite(override)) {
    const base = found?.r;
    return {
      taxability: 'taxable',
      rate: override,
      cessRate: base && base.taxability === 'taxable' ? base.cessRate : 0,
      cessPerUnit: base && base.taxability === 'taxable' ? base.cessPerUnit : 0,
      hsnSac: hsn,
      source: 'override',
      missing: false,
    };
  }
  if (found) return { ...found.r, hsnSac: hsn, source: found.source, missing: false };
  return { taxability: 'taxable', rate: 0, cessRate: 0, cessPerUnit: 0, hsnSac: hsn, source: 'default', missing: true };
}

function supplyKindOf(explicit: string | null | undefined, hsn: string): SupplyKind {
  if (explicit === 'goods' || explicit === 'services') return explicit;
  return hsn.startsWith('99') ? 'services' : 'goods';
}

/** Resolve the GST profile of a ledger line (see the precedence in the module header). */
export function resolveLedgerTaxProfile(
  lookup: TaxLookup,
  q: { ledgerId: number; date: string; override?: LedgerLineGstInput | null },
): LedgerTaxProfile {
  const ledger = lookup.ledger(q.ledgerId);
  let base: TaxProfile;
  const hist = fromHistory(lookup.history('ledger', q.ledgerId, q.date));
  if (hist) {
    base = { ...hist, hsnSac: hist.hsnSac || (ledger?.hsn_sac ?? '').trim(), source: 'ledger_history', missing: false };
  } else if (ledger && ledger.gst_applicable === 'applicable') {
    const taxability = asTaxability(ledger.gst_taxability);
    const missing = taxability === 'taxable' && (ledger.gst_rate === null || ledger.gst_rate === undefined);
    base = {
      taxability,
      rate: taxability === 'taxable' ? Number(ledger.gst_rate) || 0 : 0,
      cessRate: taxability === 'taxable' ? Number(ledger.cess_rate) || 0 : 0,
      cessPerUnit: 0,
      hsnSac: (ledger.hsn_sac ?? '').trim(),
      source: 'ledger',
      missing,
    };
  } else {
    base = { taxability: 'non_gst', rate: 0, cessRate: 0, cessPerUnit: 0, hsnSac: (ledger?.hsn_sac ?? '').trim(), source: 'not_applicable', missing: false };
  }

  const o = q.override;
  if (o && (o.rate !== undefined || o.taxability !== undefined || o.cessRate !== undefined || o.hsnSac !== undefined || o.supplyKind !== undefined)) {
    const taxability: Taxability = o.taxability ?? (o.rate !== undefined ? 'taxable' : base.taxability);
    const taxable = taxability === 'taxable';
    const rate = taxable ? (o.rate ?? (base.taxability === 'taxable' ? base.rate : 0)) : 0;
    const hsnSac = (o.hsnSac ?? base.hsnSac).trim();
    return {
      taxability,
      rate,
      cessRate: taxable ? (o.cessRate ?? (base.taxability === 'taxable' ? base.cessRate : 0)) : 0,
      cessPerUnit: 0,
      hsnSac,
      source: 'override',
      missing: taxable && o.rate === undefined && base.missing,
      supplyKind: o.supplyKind ?? supplyKindOf(ledger?.gst_supply_type, hsnSac),
    };
  }
  return { ...base, supplyKind: supplyKindOf(ledger?.gst_supply_type, base.hsnSac) };
}

/** Whether a ledger's own GST details make it part of the GST computation. */
export function ledgerIsGstApplicable(lookup: TaxLookup, ledgerId: number, date: string): boolean {
  const ledger = lookup.ledger(ledgerId);
  if (ledger?.gst_applicable === 'applicable') return true;
  return lookup.history('ledger', ledgerId, date) !== undefined;
}

/** TaxLookup over the database with small per-instance caches (create one per voucher computation). */
export function dbTaxLookup(db: Db): TaxLookup {
  const items = new Map<number, (GstColumns & { group_id: number | null }) | undefined>();
  const groups = new Map<number, (GstColumns & { parent_id: number | null }) | undefined>();
  const ledgers = new Map<number, (GstColumns & { gst_supply_type: string | null }) | undefined>();
  const hist = new Map<string, GstHistoryRow | undefined>();
  return {
    item(id) {
      if (!items.has(id)) {
        items.set(
          id,
          db.get<GstColumns & { group_id: number | null }>(
            'SELECT group_id, gst_applicable, gst_taxability, gst_rate, cess_rate, hsn_sac, cess_per_unit FROM stock_items WHERE id = :id',
            { id },
          ),
        );
      }
      return items.get(id);
    },
    stockGroup(id) {
      if (!groups.has(id)) {
        groups.set(
          id,
          db.get<GstColumns & { parent_id: number | null }>(
            'SELECT parent_id, gst_applicable, gst_taxability, gst_rate, cess_rate, hsn_sac FROM stock_groups WHERE id = :id',
            { id },
          ),
        );
      }
      return groups.get(id);
    },
    ledger(id) {
      if (!ledgers.has(id)) {
        ledgers.set(
          id,
          db.get<GstColumns & { gst_supply_type: string | null }>(
            'SELECT gst_applicable, gst_taxability, gst_rate, cess_rate, hsn_sac, gst_supply_type FROM ledgers WHERE id = :id',
            { id },
          ),
        );
      }
      return ledgers.get(id);
    },
    history(entityType, entityId, date) {
      const key = `${entityType}|${entityId}|${date}`;
      if (!hist.has(key)) {
        hist.set(
          key,
          db.get<GstHistoryRow>(
            `SELECT applicable_from, hsn_sac, taxability, rate, cess_rate, cess_per_unit FROM gst_rate_history
              WHERE entity_type = :t AND entity_id = :id AND applicable_from <= :date
              ORDER BY applicable_from DESC LIMIT 1`,
            { t: entityType, id: entityId, date },
          ),
        );
      }
      return hist.get(key);
    },
  };
}

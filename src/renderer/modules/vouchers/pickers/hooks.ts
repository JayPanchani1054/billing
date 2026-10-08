/**
 * Master lists for the voucher screen's pickers (one cached query each, shared by every row):
 *   accounts.ledger.picker  { asOf }                  → every active ledger with its balance on the voucher date
 *   inventory.item.picker   { asOf, priceLevelId? }   → every item with GST profile, prices and stock on the date
 * plus ledger masters loaded on demand (GST profile, cost centres) for the live totals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerDetail, LedgerPickerRow } from '../../../../shared/types/accounts.ts';
import type { GodownDto, ItemPickerRow, PriceLevelDto } from '../../../../shared/types/inventory.ts';
import { api, useApiQuery } from '../../../app/index.ts';

const NO_LEDGERS: readonly LedgerPickerRow[] = [];
const NO_ITEMS: readonly ItemPickerRow[] = [];
const NO_GODOWNS: readonly GodownDto[] = [];
const NO_LEVELS: readonly PriceLevelDto[] = [];

export interface LedgerRows {
  rows: readonly LedgerPickerRow[];
  byId: ReadonlyMap<number, LedgerPickerRow>;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useLedgerRows(asOf: string): LedgerRows {
  const q = useApiQuery('accounts.ledger.picker', { asOf }, { keepPrevious: true, staleTime: 60_000 });
  const rows = q.data ?? NO_LEDGERS;
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const { refetch } = q;
  const re = useCallback(() => void refetch(), [refetch]);
  // One object per list version: the grid context depends on it, and a fresh object every render
  // would re-render every memoised row on every keystroke.
  return useMemo(() => ({ rows, byId, loading: q.loading, error: q.error, refetch: re }), [rows, byId, q.loading, q.error, re]);
}

export interface ItemRows {
  rows: readonly ItemPickerRow[];
  byId: ReadonlyMap<number, ItemPickerRow>;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useItemRows(asOf: string, priceLevelId: number | null, enabled: boolean): ItemRows {
  const input = priceLevelId === null ? { asOf } : { asOf, priceLevelId };
  const q = useApiQuery('inventory.item.picker', input, { keepPrevious: true, enabled, staleTime: 60_000 });
  const rows = q.data ?? NO_ITEMS;
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const { refetch } = q;
  const re = useCallback(() => void refetch(), [refetch]);
  return useMemo(() => ({ rows, byId, loading: q.loading, error: q.error, refetch: re }), [rows, byId, q.loading, q.error, re]);
}

export function useGodowns(enabled: boolean): readonly GodownDto[] {
  const q = useApiQuery('inventory.godown.list', { limit: 1000 }, { enabled, staleTime: 120_000 });
  return q.data?.rows ?? NO_GODOWNS;
}

export function usePriceLevels(enabled: boolean): readonly PriceLevelDto[] {
  const q = useApiQuery('inventory.priceLevel.list', { limit: 200 }, { enabled, staleTime: 120_000 });
  return q.data?.rows ?? NO_LEVELS;
}

/**
 * Ledger masters by id, fetched on demand ('accounts.ledger.get') and kept for the life of the
 * screen. Missing / failed ids are simply absent (the totals then treat the line conservatively and
 * the server recomputes on save).
 */
export function useLedgerDetails(ids: readonly number[]): ReadonlyMap<number, LedgerDetail> {
  const [map, setMap] = useState<ReadonlyMap<number, LedgerDetail>>(() => new Map());
  /** Ids fetched or in flight. A failed fetch is forgotten so a later render retries it. */
  const requested = useRef(new Set<number>());
  // Results are applied for as long as the screen is mounted — NOT only while the same id list is
  // current: picking a second ledger while the first is still loading must not drop the first one's
  // GST profile (it would never be requested again and the live totals would treat it as unknown).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = [...new Set(ids)].sort((a, b) => a - b).join(',');
  useEffect(() => {
    const want = key === '' ? [] : key.split(',').map(Number);
    const missing = want.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    for (const id of missing) {
      api('accounts.ledger.get', { id }).then(
        (d) => {
          if (mounted.current) setMap((cur) => new Map(cur).set(d.id, d));
        },
        () => {
          requested.current.delete(id);
        },
      );
    }
  }, [key]);
  return map;
}

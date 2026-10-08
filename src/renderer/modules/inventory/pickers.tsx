/**
 * Reusable inventory pickers and hooks for other modules (vouchers, stock reports, price lists).
 * See README.md in this folder for the API. All of them are type-ahead Pickers from the UI kit,
 * keyboard-complete, with inline "+ Create" (Alt+C) that opens the master form and comes back with
 * the new record selected.
 */
import { useCallback, useMemo, useState } from 'react';
import type { Ref } from 'react';
import type {
  BatchBalance,
  GodownDto,
  ItemPickerRow,
  PriceForResult,
  StockCategoryDto,
  StockGroupDto,
  UnitDto,
} from '../../../shared/types/inventory.ts';
import { api, formatDate, formatQty, formatRate, useApiQuery, useCan, useNav } from '../../app/index.ts';
import type { ApiQueryResult } from '../../app/index.ts';
import { Picker } from '../../ui/index.ts';
import type { ControlSize } from '../../ui/index.ts';
import { qtyText } from './lib/slabs.ts';
import { orderTree } from './lib/tree.ts';

/** What a master form returns to `pushForResult`. */
export interface CreatedRef {
  id: number;
  name: string;
}

/** Common props of the pickers. */
interface BasePickerProps {
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  size?: ControlSize;
  id?: string;
  'aria-label'?: string;
  /** Offer "+ Create" (Alt+C) — also needs the masters.create permission. Default true. */
  allowCreate?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/**
 * After a master form opened for a result: run `then` with the created record (nothing when the
 * user pressed Esc). A failed follow-up fetch is ignored — the list refetches anyway.
 */
async function createThen(opened: Promise<CreatedRef | undefined>, then: (created: CreatedRef) => Promise<void>): Promise<void> {
  try {
    const created = await opened;
    if (created) await then(created);
  } catch {
    /* the record exists; the picker's list shows it after the refetch */
  }
}

/** Items loaded once for a picker, plus records created from it (shown before the list refetches). */
function useWithExtras<T extends { id: number }>(rows: readonly T[] | undefined): { items: T[]; add: (row: T) => void } {
  const [extras, setExtras] = useState<T[]>([]);
  const items = useMemo(() => {
    const list = rows ? [...rows] : [];
    const have = new Set(list.map((r) => r.id));
    for (const e of extras) if (!have.has(e.id)) list.push(e);
    return list;
  }, [rows, extras]);
  const add = useCallback((row: T) => setExtras((x) => [...x.filter((r) => r.id !== row.id), row]), []);
  return { items, add };
}

// ───────────────────────────── Stock items ─────────────────────────────

/** A selected item: a full picker row, or at least { id, name } (e.g. a saved voucher line). */
export type ItemPickerValue = Pick<ItemPickerRow, 'id' | 'name'> & Partial<ItemPickerRow>;

export interface UseItemPickerOptions {
  /** Date for GST, price level and stock (default: the working date on the server). */
  asOf?: string;
  /** Stock of this godown only (default all godowns). */
  godownId?: number;
  /** Adds the price-level rate for quantity 1 to each row. */
  priceLevelId?: number;
  /** Rows per search (default 50). */
  limit?: number;
  /** Leave services out (e.g. stock journals). */
  goodsOnly?: boolean;
}

export interface ItemPickerSource {
  loadItems: (query: string, signal: AbortSignal) => Promise<readonly ItemPickerValue[]>;
  getKey: (r: ItemPickerValue) => string;
  getLabel: (r: ItemPickerValue) => string;
  getAlias: (r: ItemPickerValue) => string | null | undefined;
  getKeywords: (r: ItemPickerValue) => string[];
  /** "12 Nos" stock text (or "Service"). */
  stockText: (r: ItemPickerValue) => string;
  /** Open the item form for a new item named `typed`; resolves with its picker row (null when cancelled). */
  createItem: (typed: string) => Promise<ItemPickerRow | null>;
  /** Fetch the picker row of one item (e.g. to fill a voucher line from a saved id). */
  fetchRow: (id: number, name?: string) => Promise<ItemPickerRow | null>;
}

const isFullRow = (r: ItemPickerValue | null): r is ItemPickerRow => r !== null && typeof r.unitSymbol === 'string';

/**
 * Building blocks for an item picker (search through 'inventory.item.picker', create-and-return,
 * stock text). `<ItemPicker>` uses it; use it directly to build a custom picker cell.
 */
export function useItemPicker(options: UseItemPickerOptions = {}): ItemPickerSource {
  const nav = useNav();
  const { asOf, godownId, priceLevelId, limit = 50, goodsOnly = false } = options;
  const query = useCallback(
    async (search: string, max: number): Promise<ItemPickerRow[]> => {
      const rows = await api('inventory.item.picker', {
        search: search.trim() || undefined,
        limit: max,
        ...(asOf ? { asOf } : {}),
        ...(godownId !== undefined ? { godownId } : {}),
        ...(priceLevelId !== undefined ? { priceLevelId } : {}),
      });
      return goodsOnly ? rows.filter((r) => !r.isService) : rows;
    },
    [asOf, godownId, priceLevelId, goodsOnly],
  );
  const fetchRow = useCallback(
    async (id: number, name?: string): Promise<ItemPickerRow | null> => {
      // The picker route searches by text, so look the item up by its name (fetched when not
      // given) — never by loading every item. Names starting with the text come first; a wider
      // second search covers many items sharing a prefix.
      const label = name?.trim() || (await api('inventory.item.get', { id })).name;
      for (const max of [25, 1000]) {
        const hit = (await query(label, max)).find((r) => r.id === id);
        if (hit) return hit;
      }
      return null;
    },
    [query],
  );
  return useMemo<ItemPickerSource>(
    () => ({
      loadItems: (q) => query(q, limit),
      getKey: (r) => String(r.id),
      getLabel: (r) => r.name,
      getAlias: (r) => r.alias ?? r.partNo ?? undefined,
      getKeywords: (r) => [r.partNo ?? '', r.barcode ?? '', r.groupName ?? ''].filter(Boolean),
      stockText: (r) => (r.isService ? 'Service' : typeof r.stockQty === 'number' ? formatQty(r.stockQty, r.unitDecimals ?? 0, r.unitSymbol) : ''),
      createItem: async (typed) => {
        const created = await nav.pushForResult<CreatedRef>('inventory.item.form', { initialName: typed.trim(), forResult: true });
        if (!created) return null;
        try {
          return (await fetchRow(created.id, created.name)) ?? null;
        } catch {
          return null;
        }
      },
      fetchRow,
    }),
    [query, limit, nav, fetchRow],
  );
}

export interface ItemPickerProps extends BasePickerProps, UseItemPickerOptions {
  value: ItemPickerValue | null;
  onChange: (item: ItemPickerRow | null) => void;
  /** Called after Enter selects (Enter is then consumed — move focus yourself). */
  onCommit?: (item: ItemPickerRow | null) => void;
  /** Show stock in hand on the right of each row (default true). */
  showStock?: boolean;
}

/**
 * Stock item picker: searches name, alias, part no. and barcode on the server (fast on 20,000+
 * items), shows group, stock in hand and price-level rate, and creates items inline (Alt+C).
 */
export function ItemPicker({ value, onChange, onCommit, showStock = true, allowCreate = true, placeholder, asOf, godownId, priceLevelId, limit, goodsOnly, ...rest }: ItemPickerProps) {
  const canCreate = useCan('masters.create');
  const src = useItemPicker({ asOf, godownId, priceLevelId, limit, goodsOnly });
  const onCreate =
    allowCreate && canCreate
      ? (typed: string) => {
          void src.createItem(typed).then(
            (row) => {
              if (row) {
                onChange(row);
                onCommit?.(row);
              }
            },
            () => undefined,
          );
        }
      : undefined;
  return (
    <Picker<ItemPickerValue>
      {...rest}
      loadItems={src.loadItems}
      getKey={src.getKey}
      getLabel={src.getLabel}
      getAlias={src.getAlias}
      getKeywords={src.getKeywords}
      rightMeta={(r) => {
        const parts: string[] = [];
        if (priceLevelId !== undefined && r.priceLevel) parts.push(`₹${formatRate(r.priceLevel.rate)}`);
        if (showStock) parts.push(src.stockText(r));
        return parts.filter(Boolean).join(' · ');
      }}
      renderItem={(r, state) => (
        <span className="bx-inv-pick">
          <span className="bx-inv-pick__name">{state.highlightedLabel}</span>
          {r.groupName ? <span className="bx-inv-pick__meta">{r.groupName}</span> : null}
        </span>
      )}
      value={value}
      onChange={(r) => {
        if (r === null) onChange(null);
        else if (isFullRow(r)) onChange(r);
      }}
      onCommit={onCommit ? (r) => onCommit(isFullRow(r) ? r : null) : undefined}
      onCreate={onCreate}
      createLabel={(q) => `Create stock item “${q}”`}
      placeholder={placeholder ?? 'Type item name, part no. or barcode'}
      emptyText="No matching item"
    />
  );
}

// ───────────────────────────── Godowns ─────────────────────────────

export interface GodownPickerProps extends BasePickerProps {
  value: number | null;
  onChange: (id: number | null, godown: GodownDto | null) => void;
  onCommit?: (id: number | null) => void;
  /** Godown ids not offered (e.g. a godown and its sub-godowns when choosing its parent). */
  exclude?: ReadonlySet<number>;
}

/** Godown / location picker (tree order; Main Location first). */
export function GodownPicker({ value, onChange, onCommit, exclude, allowCreate = true, placeholder, ...rest }: GodownPickerProps) {
  const nav = useNav();
  const canCreate = useCan('masters.create');
  const q = useApiQuery('inventory.godown.list', { limit: 5000 }, { staleTime: 60_000 });
  const { items: all, add } = useWithExtras<GodownDto>(q.data?.rows);
  const items = useMemo(() => {
    const ordered = orderTree(all);
    return exclude ? ordered.filter((g) => !exclude.has(g.id)) : ordered;
  }, [all, exclude]);
  const selected = items.find((g) => g.id === value) ?? all.find((g) => g.id === value) ?? null;
  const onCreate =
    allowCreate && canCreate
      ? (typed: string) => {
          void createThen(nav.pushForResult<CreatedRef>('inventory.godown.form', { initialName: typed.trim(), forResult: true }), async (created) => {
            const g = await api('inventory.godown.get', { id: created.id });
            add(g);
            onChange(g.id, g);
            onCommit?.(g.id);
          });
        }
      : undefined;
  return (
    <Picker<GodownDto & { level?: number }>
      {...rest}
      items={items}
      getKey={(g) => String(g.id)}
      getLabel={(g) => g.name}
      getAlias={(g) => g.alias}
      rightMeta={(g) => (g.isPredefined ? 'Main' : g.isThirdParty ? 'Third party' : (g.parentName ?? ''))}
      value={selected}
      onChange={(g) => onChange(g?.id ?? null, g)}
      onCommit={onCommit ? (g) => onCommit(g?.id ?? null) : undefined}
      onCreate={onCreate}
      createLabel={(t) => `Create godown “${t}”`}
      placeholder={placeholder ?? 'Choose godown'}
      emptyText="No matching godown"
    />
  );
}

// ───────────────────────────── Units ─────────────────────────────

export interface UnitPickerProps extends BasePickerProps {
  value: number | null;
  onChange: (id: number | null, unit: UnitDto | null) => void;
  onCommit?: (id: number | null) => void;
  /** 'simple' for the parts of a compound unit; default any. */
  kind?: 'simple' | 'compound';
  exclude?: ReadonlySet<number>;
}

/** Unit of measure picker (simple units first, then compound "Box of 12 Nos"). */
export function UnitPicker({ value, onChange, onCommit, kind, exclude, allowCreate = true, placeholder, ...rest }: UnitPickerProps) {
  const nav = useNav();
  const canCreate = useCan('masters.create');
  const q = useApiQuery('inventory.unit.list', { limit: 5000 }, { staleTime: 60_000 });
  const { items: all, add } = useWithExtras<UnitDto>(q.data?.rows);
  const items = useMemo(
    () => all.filter((u) => (kind === undefined || (kind === 'compound') === u.isCompound) && !(exclude?.has(u.id) ?? false)),
    [all, kind, exclude],
  );
  const selected = all.find((u) => u.id === value) ?? null;
  const onCreate =
    allowCreate && canCreate
      ? (typed: string) => {
          void createThen(nav.pushForResult<CreatedRef>('inventory.unit.form', { initialName: typed.trim(), forResult: true, kind: kind ?? 'simple' }), async (created) => {
            const u = await api('inventory.unit.get', { id: created.id });
            add(u);
            onChange(u.id, u);
            onCommit?.(u.id);
          });
        }
      : undefined;
  return (
    <Picker<UnitDto>
      {...rest}
      items={items}
      getKey={(u) => String(u.id)}
      getLabel={(u) => u.symbol}
      getAlias={(u) => u.formalName}
      getKeywords={(u) => [u.uqc ?? '']}
      rightMeta={(u) => (u.isCompound ? 'Compound' : u.uqc ?? '')}
      value={selected}
      onChange={(u) => onChange(u?.id ?? null, u)}
      onCommit={onCommit ? (u) => onCommit(u?.id ?? null) : undefined}
      onCreate={onCreate}
      createLabel={(t) => `Create unit “${t}”`}
      placeholder={placeholder ?? 'e.g. Nos, Kg, Box'}
      emptyText="No matching unit"
    />
  );
}

// ───────────────────────────── Stock groups & categories ─────────────────────────────

interface TreePickerProps extends BasePickerProps {
  value: number | null;
  onCommit?: (id: number | null) => void;
  /** Ids not offered (the record itself and everything under it, when choosing a parent). */
  exclude?: ReadonlySet<number>;
}

export interface StockGroupPickerProps extends TreePickerProps {
  onChange: (id: number | null, group: StockGroupDto | null) => void;
}

/** Stock group picker (tree order). Empty = Primary (top level). */
export function StockGroupPicker({ value, onChange, onCommit, exclude, allowCreate = true, placeholder, ...rest }: StockGroupPickerProps) {
  const nav = useNav();
  const canCreate = useCan('masters.create');
  const q = useApiQuery('inventory.group.list', { limit: 5000 }, { staleTime: 60_000 });
  const { items: all, add } = useWithExtras<StockGroupDto>(q.data?.rows);
  const items = useMemo(() => orderTree(all).filter((g) => !(exclude?.has(g.id) ?? false)), [all, exclude]);
  const selected = all.find((g) => g.id === value) ?? null;
  const onCreate =
    allowCreate && canCreate
      ? (typed: string) => {
          void createThen(nav.pushForResult<CreatedRef>('inventory.group.form', { initialName: typed.trim(), forResult: true }), async (created) => {
            const g = await api('inventory.group.get', { id: created.id });
            add(g);
            onChange(g.id, g);
            onCommit?.(g.id);
          });
        }
      : undefined;
  return (
    <Picker<StockGroupDto>
      {...rest}
      items={items}
      getKey={(g) => String(g.id)}
      getLabel={(g) => g.name}
      getAlias={(g) => g.alias}
      rightMeta={(g) => g.parentName ?? ''}
      value={selected}
      onChange={(g) => onChange(g?.id ?? null, g)}
      onCommit={onCommit ? (g) => onCommit(g?.id ?? null) : undefined}
      onCreate={onCreate}
      createLabel={(t) => `Create stock group “${t}”`}
      placeholder={placeholder ?? 'Primary (no group)'}
      emptyText="No matching group"
    />
  );
}

export interface StockCategoryPickerProps extends TreePickerProps {
  onChange: (id: number | null, category: StockCategoryDto | null) => void;
}

/** Stock category picker (tree order). Empty = none. */
export function StockCategoryPicker({ value, onChange, onCommit, exclude, allowCreate = true, placeholder, ...rest }: StockCategoryPickerProps) {
  const nav = useNav();
  const canCreate = useCan('masters.create');
  const q = useApiQuery('inventory.category.list', { limit: 5000 }, { staleTime: 60_000 });
  const { items: all, add } = useWithExtras<StockCategoryDto>(q.data?.rows);
  const items = useMemo(() => orderTree(all).filter((c) => !(exclude?.has(c.id) ?? false)), [all, exclude]);
  const selected = all.find((c) => c.id === value) ?? null;
  const onCreate =
    allowCreate && canCreate
      ? (typed: string) => {
          void createThen(nav.pushForResult<CreatedRef>('inventory.category.form', { initialName: typed.trim(), forResult: true }), async (created) => {
            const c = await api('inventory.category.get', { id: created.id });
            add(c);
            onChange(c.id, c);
            onCommit?.(c.id);
          });
        }
      : undefined;
  return (
    <Picker<StockCategoryDto>
      {...rest}
      items={items}
      getKey={(c) => String(c.id)}
      getLabel={(c) => c.name}
      getAlias={(c) => c.alias}
      rightMeta={(c) => c.parentName ?? ''}
      value={selected}
      onChange={(c) => onChange(c?.id ?? null, c)}
      onCommit={onCommit ? (c) => onCommit(c?.id ?? null) : undefined}
      onCreate={onCreate}
      createLabel={(t) => `Create stock category “${t}”`}
      placeholder={placeholder ?? 'None'}
      emptyText="No matching category"
    />
  );
}

// ───────────────────────────── Batches ─────────────────────────────

export interface BatchPickerProps extends Omit<BasePickerProps, 'allowCreate'> {
  itemId: number | null;
  godownId?: number | null;
  /** Balances as on this date. */
  asOf: string;
  value: string | null;
  onChange: (batchName: string | null, balance: BatchBalance | null) => void;
  onCommit?: (batchName: string | null) => void;
  /** Allow typing a new batch name (inward entries: purchase, receipt, production). Default false. */
  allowNew?: boolean;
  /** Offer batches with no stock left (default: only when allowNew). */
  showEmpty?: boolean;
  /** The voucher being altered (its own quantities are left out of the balances). */
  excludeVoucherId?: number;
}

/**
 * Batch picker for one item (and godown) — First Expiry First Out order, with balance and expiry.
 * Expired batches are shown but marked. With `allowNew`, Alt+C / "+ Create" takes the typed name as
 * a new batch.
 */
export function BatchPicker({ itemId, godownId, asOf, value, onChange, onCommit, allowNew = false, showEmpty, excludeVoucherId, placeholder, ...rest }: BatchPickerProps) {
  const q = useApiQuery(
    'inventory.batches',
    {
      itemId: itemId ?? 0,
      asOf,
      ...(godownId !== null && godownId !== undefined ? { godownId } : {}),
      ...(excludeVoucherId !== undefined ? { excludeVoucherId } : {}),
    },
    { enabled: itemId !== null, staleTime: 10_000 },
  );
  const [created, setCreated] = useState<BatchBalance[]>([]);
  const items = useMemo(() => {
    const list = (q.data ?? []).filter((b) => (showEmpty ?? allowNew) || b.qty > 0);
    for (const c of created) if (!list.some((b) => b.batchName.toLowerCase() === c.batchName.toLowerCase())) list.push(c);
    return list;
  }, [q.data, created, showEmpty, allowNew]);
  const selected = value === null ? null : (items.find((b) => b.batchName.toLowerCase() === value.toLowerCase()) ?? { batchName: value, mfgDate: null, expiryDate: null, qty: 0 });
  return (
    <Picker<BatchBalance>
      {...rest}
      items={items}
      getKey={(b) => b.batchName.toLowerCase()}
      getLabel={(b) => b.batchName}
      rightMeta={(b) => {
        const parts = [qtyText(b.qty)];
        if (b.expiryDate) parts.push(b.expiryDate < asOf ? `Expired ${formatDate(b.expiryDate)}` : `Exp ${formatDate(b.expiryDate)}`);
        return parts.join(' · ');
      }}
      value={selected}
      onChange={(b) => onChange(b?.batchName ?? null, b && (q.data ?? []).some((x) => x.batchName === b.batchName) ? b : null)}
      onCommit={onCommit ? (b) => onCommit(b?.batchName ?? null) : undefined}
      onCreate={
        allowNew
          ? (typed) => {
              const name = typed.trim();
              if (!name) return;
              const b: BatchBalance = { batchName: name, mfgDate: null, expiryDate: null, qty: 0 };
              setCreated((x) => [...x, b]);
              onChange(name, null);
              onCommit?.(name);
            }
          : undefined
      }
      createLabel={(t) => `New batch “${t}”`}
      placeholder={placeholder ?? (itemId === null ? 'Choose the item first' : 'Batch')}
      disabled={rest.disabled || itemId === null}
      emptyText={allowNew ? 'Type a new batch name and press Alt+C' : 'No batch with stock'}
    />
  );
}

// ───────────────────────────── Price ─────────────────────────────

/**
 * Rate for an item at a price level, date and quantity ('inventory.item.priceFor'): the price-list
 * slab when one applies, else the item's default selling (or purchase) price. Disabled until an item
 * is chosen. `data.rate` is rupees per base unit, exclusive of tax.
 */
export function usePriceFor(
  itemId: number | null | undefined,
  priceLevelId: number | null | undefined,
  date: string,
  qty: number,
  side: 'sales' | 'purchase' = 'sales',
): ApiQueryResult<PriceForResult> {
  const enabled = typeof itemId === 'number' && itemId > 0 && !!date && Number.isFinite(qty) && qty >= 0;
  return useApiQuery(
    'inventory.item.priceFor',
    {
      itemId: enabled ? (itemId as number) : 1,
      date: date || '2000-01-01',
      qty: enabled ? Math.abs(qty) : 0,
      side,
      ...(typeof priceLevelId === 'number' ? { priceLevelId } : {}),
    },
    { enabled, staleTime: 30_000 },
  );
}

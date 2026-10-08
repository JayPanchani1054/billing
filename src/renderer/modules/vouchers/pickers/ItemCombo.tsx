/**
 * Stock item picker (UI kit Combobox over 'inventory.item.picker'), plus small pickers for godown
 * and batch. Alt+C on the item picker opens 'inventory.item.form' for a result with the typed name.
 */
import { memo, useMemo, useState } from 'react';
import type { Ref } from 'react';
import { formatQty } from '../../../../shared/format.ts';
import { formatDate } from '../../../../shared/dates.ts';
import type { BatchBalance, GodownDto, ItemPickerRow } from '../../../../shared/types/inventory.ts';
import { api, useCan, useNav } from '../../../app/index.ts';
import { Combobox } from '../../../ui/index.ts';

const pendingItem = (id: number, name: string): ItemPickerRow => ({
  id,
  name,
  alias: null,
  partNo: null,
  barcode: null,
  unitSymbol: '',
  unitDecimals: 0,
  altUnit: null,
  groupName: null,
  gst: null,
  sellingPrice: null,
  purchasePrice: null,
  mrp: null,
  priceLevel: null,
  stockQty: 0,
  isService: false,
  maintainBatches: false,
});

export interface ItemComboProps {
  rows: readonly ItemPickerRow[];
  value: number | null;
  onChange: (id: number | null, row: ItemPickerRow | null) => void;
  onCommit?: (id: number | null, row: ItemPickerRow | null) => void;
  onRefetch?: () => void;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  invalid?: boolean;
  disabled?: boolean;
  showStock?: boolean;
  /** Open the list when focused (default true). Grids pass false on empty rows so Enter leaves the grid. */
  openOnFocus?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export const ItemCombo = memo(function ItemCombo(props: ItemComboProps) {
  const { rows, value, onChange, onCommit, onRefetch, showStock = true, ref } = props;
  const nav = useNav();
  const canCreate = useCan('masters.create');
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
  const selected = useMemo(() => {
    if (value === null) return null;
    const found = rows.find((r) => r.id === value);
    if (found) return found;
    return created && created.id === value ? pendingItem(created.id, created.name) : pendingItem(value, '…');
  }, [rows, value, created]);

  const create = async (typed: string) => {
    const out = await nav.pushForResult<{ id: number; name: string }>('inventory.item.form', { initialName: typed.trim(), forResult: true });
    if (!out) return;
    setCreated(out);
    onRefetch?.();
    onChange(out.id, rows.find((r) => r.id === out.id) ?? pendingItem(out.id, out.name));
  };

  return (
    <Combobox<ItemPickerRow>
      ref={ref}
      id={props.id}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      items={rows}
      getKey={(r) => String(r.id)}
      getLabel={(r) => r.name}
      getAlias={(r) => r.alias}
      getKeywords={(r) => [r.partNo ?? '', r.barcode ?? '', r.gst?.hsnSac ?? '', r.groupName ?? '']}
      rightMeta={showStock ? (r) => (r.isService ? <span className="bx-muted">Service</span> : <span className="bx-num">{formatQty(r.stockQty, r.unitDecimals, r.unitSymbol)}</span>) : undefined}
      value={selected}
      onChange={(r) => onChange(r?.id ?? null, r)}
      onCommit={onCommit ? (r) => onCommit(r?.id ?? null, r) : undefined}
      onCreate={canCreate ? (q) => void create(q) : undefined}
      createLabel={(q) => (q.trim() ? `Create item “${q.trim()}”` : 'Create a new stock item')}
      placeholder="Type an item name, part no. or HSN"
      emptyText={canCreate ? 'No item matches — press Alt+C to create it' : 'No item matches'}
      invalid={props.invalid}
      disabled={props.disabled}
      size="sm"
      openOnFocus={props.openOnFocus}
      listMinWidth={380}
    />
  );
});

export interface GodownComboProps {
  rows: readonly GodownDto[];
  value: number | null;
  onChange: (id: number | null) => void;
  onCommit?: (id: number | null) => void;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  invalid?: boolean;
  placeholder?: string;
}

export const GodownCombo = memo(function GodownCombo(props: GodownComboProps) {
  const { rows, value, onChange, onCommit } = props;
  const selected = useMemo(() => rows.find((g) => g.id === value) ?? null, [rows, value]);
  return (
    <Combobox<GodownDto>
      id={props.id}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      items={rows}
      getKey={(g) => String(g.id)}
      getLabel={(g) => g.name}
      getAlias={(g) => g.alias}
      groupBy={(g) => g.parentName ?? ''}
      value={selected}
      onChange={(g) => onChange(g?.id ?? null)}
      onCommit={onCommit ? (g) => onCommit(g?.id ?? null) : undefined}
      placeholder={props.placeholder ?? 'Main Location'}
      emptyText="No godown matches"
      invalid={props.invalid}
      size="sm"
      listMinWidth={240}
    />
  );
});

export interface BatchComboProps {
  itemId: number;
  godownId: number | null;
  asOf: string;
  excludeVoucherId: number | null;
  value: string;
  onChange: (name: string, batch: BatchBalance | null) => void;
  onCommit?: (name: string) => void;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  invalid?: boolean;
}

/** Batches of the item in stock on the date; a new batch name can be typed (Alt+C or Enter on no match). */
export const BatchCombo = memo(function BatchCombo(props: BatchComboProps) {
  const { itemId, godownId, asOf, excludeVoucherId, value, onChange, onCommit } = props;
  const [known, setKnown] = useState<readonly BatchBalance[]>([]);
  const selected = useMemo<BatchBalance | null>(() => {
    if (!value) return null;
    return known.find((b) => b.batchName === value) ?? { batchName: value, mfgDate: null, expiryDate: null, qty: 0 };
  }, [known, value]);
  const load = async (query: string, signal: AbortSignal): Promise<readonly BatchBalance[]> => {
    const input: { itemId: number; asOf: string; godownId?: number; excludeVoucherId?: number } = { itemId, asOf };
    if (godownId !== null) input.godownId = godownId;
    if (excludeVoucherId !== null) input.excludeVoucherId = excludeVoucherId;
    const rows = await api('inventory.batches', input);
    if (signal.aborted) return [];
    setKnown(rows);
    const q = query.trim().toLowerCase();
    return q ? rows.filter((b) => b.batchName.toLowerCase().includes(q)) : rows;
  };
  return (
    <Combobox<BatchBalance>
      id={props.id}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
      loadItems={load}
      getKey={(b) => b.batchName}
      getLabel={(b) => b.batchName}
      rightMeta={(b) => (
        <span className="bx-num">
          {formatQty(b.qty, 3)}
          {b.expiryDate ? ` · exp ${formatDate(b.expiryDate, 'D-MMM-YY')}` : ''}
        </span>
      )}
      value={selected}
      onChange={(b) => onChange(b?.batchName ?? '', b)}
      onCommit={onCommit ? (b) => onCommit(b?.batchName ?? '') : undefined}
      onCreate={(q) => {
        onChange(q.trim(), null);
        onCommit?.(q.trim());
      }}
      createLabel={(q) => (q.trim() ? `New batch “${q.trim()}”` : 'Type a new batch name')}
      placeholder="Batch"
      emptyText="No batch in stock — type a new batch name and press Alt+C"
      invalid={props.invalid}
      size="sm"
      listMinWidth={260}
    />
  );
});

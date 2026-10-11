/**
 * 'inventory.item.list' — Stock Items (2.1, SPEC-21 §1.7). Title row "Stock Items · 4 items" with
 * "Create stock item" (Alt+C) and More ▾ (Create several Alt+M / Alt+B, Delete Alt+D or Ctrl+D, Print
 * Alt+P, Export Alt+E). Toolbar row: one search (name, alias, part no., barcode — on the server) and the
 * group filter; the category filter only when categories exist or one was asked for. The table is
 * virtualised (thousands of rows stay smooth) and hides columns that are blank on every row; exports
 * keep every column. Enter alters the item.
 */
import { useMemo, useRef, useState } from 'react';
import type { StockItemListRow } from '../../../shared/types/inventory.ts';
import {
  formatDate,
  formatPercent,
  formatQty,
  ReportScreen,
  useApiMutation,
  useApiQuery,
  useCan,
  useCompany,
  useConfirm,
  useFeatures,
  useNav,
  useWorkingDate,
  userMessage,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Button, DataTable, EmptyState, Field, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { FeatureOff, INVENTORY_INVALIDATES } from './common.tsx';
import { gstSummary } from './lib/itemForm.ts';
import { countText, itemListActions } from './lib/listActions.ts';
import { StockCategoryPicker, StockGroupPicker } from './pickers.tsx';
import './inventory.css';

const LIMIT = 5000;

export function ItemListScreen({ params }: ScreenProps<{ groupId?: number; categoryId?: number }>) {
  const features = useFeatures();
  if (!features.inventory) {
    return (
      <ReportScreen title="Stock Items" periodMode="none">
        <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep stock items." />
      </ReportScreen>
    );
  }
  return <ItemList initialGroupId={typeof params.groupId === 'number' ? params.groupId : null} initialCategoryId={typeof params.categoryId === 'number' ? params.categoryId : null} />;
}

function ItemList({ initialGroupId, initialCategoryId }: { initialGroupId: number | null; initialCategoryId: number | null }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const { date: asOf } = useWorkingDate();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const gstOn = useCompany().gstEnabled;
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState<number | null>(initialGroupId);
  const [categoryId, setCategoryId] = useState<number | null>(initialCategoryId);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const gridRef = useRef<HTMLTableElement | null>(null);
  const debounced = useDebouncedValue(search.trim(), 200);
  const q = useApiQuery(
    'inventory.item.list',
    {
      ...(debounced ? { search: debounced } : {}),
      ...(groupId !== null ? { groupId } : {}),
      ...(categoryId !== null ? { categoryId } : {}),
      withStock: true,
      asOf,
      limit: LIMIT,
    },
    { keepPrevious: true },
  );
  const units = useApiQuery('inventory.unit.list', { limit: 5000 }, { staleTime: 60_000 });
  // Same query as the category picker (shared cache): the filter shows only when there is a category to pick.
  const categories = useApiQuery('inventory.category.list', { limit: 5000 }, { staleTime: 60_000 });
  const showCategory = initialCategoryId !== null || categoryId !== null || (categories.data?.rows.length ?? 0) > 0;
  const decimalsOf = useMemo(() => {
    const m = new Map((units.data?.rows ?? []).map((u) => [u.id, u.decimalPlaces]));
    return (unitId: number) => m.get(unitId) ?? 0;
  }, [units.data]);
  const del = useApiMutation('inventory.item.delete', { invalidates: INVENTORY_INVALIDATES });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const total = q.data?.total ?? 0;
  const filtered = debounced !== '' || groupId !== null || categoryId !== null;
  const current = rows.find((r) => String(r.id) === selected) ?? null;

  const columns = useMemo<Column<StockItemListRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        sortable: true,
        render: (r) => (
          <span className="bx-inv-pick">
            <span className="bx-inv-pick__name">{r.name}</span>
            {r.alias ? <span className="bx-inv-pick__meta">{r.alias}</span> : null}
            {!r.isActive ? <span className="bx-inv-pick__meta">inactive</span> : null}
            {r.isService ? <span className="bx-inv-pick__meta">service</span> : null}
          </span>
        ),
        title: (r) => [r.name, r.alias, r.partNo ? `Part no. ${r.partNo}` : '', r.barcode ? `Barcode ${r.barcode}` : ''].filter(Boolean).join(' · '),
      },
      { key: 'groupName', header: 'Under', width: 180, sortable: true, value: (r) => r.groupName ?? '' },
      { key: 'categoryName', header: 'Category', width: 150, sortable: true, value: (r) => r.categoryName ?? '' },
      {
        // The unit is in the quantity ("996 Nos"); the date is the working date (F2).
        key: 'stockQty',
        header: `In stock (${formatDate(asOf, 'D-MMM-YY')})`,
        headerLabel: `In stock on ${formatDate(asOf)}`,
        kind: 'number',
        width: 160,
        sortable: true,
        sortValue: (r) => r.stockQty ?? 0,
        render: (r) =>
          r.isService ? null : <span className={(r.stockQty ?? 0) < 0 ? 'bx-inv-neg bx-num' : 'bx-num'}>{formatQty(r.stockQty ?? 0, decimalsOf(r.unitId), r.unitSymbol)}</span>,
      },
      {
        key: 'gstRate',
        header: 'GST',
        width: 100,
        align: 'right',
        sortable: true,
        hidden: !gstOn,
        sortValue: (r) => r.gstRate ?? -1,
        render: (r) => (r.gstRate === null ? <span className="bx-muted">Inherited</span> : formatPercent(r.gstRate)),
        title: (r) => (r.gstRate === null ? 'No rate on the item: it comes from its stock group, or else the sales/purchase ledger' : `${r.gstRate}% set on the item`),
      },
      { key: 'sellingPrice', header: 'Selling price', kind: 'amount', width: 130, blankZero: true, sortable: true, value: (r) => r.sellingPrice ?? 0 },
    ],
    [decimalsOf, gstOn, asOf],
  );

  const remove = async (r: StockItemListRow | null): Promise<void> => {
    if (!r || !canDelete || del.pending) return;
    const ok = await confirm({
      title: `Delete stock item “${r.name}”?`,
      message: 'Its opening stock and price lists are removed too. Items used in vouchers cannot be deleted — mark them inactive instead.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await del.mutate({ id: r.id });
      toast.success(`Stock item “${r.name}” deleted`);
      const i = rows.findIndex((x) => x.id === r.id);
      const next = rows[i + 1] ?? rows[i - 1];
      setSelected(next ? String(next.id) : undefined);
    } catch (err) {
      toast.error('Not deleted', { message: userMessage(err) });
    }
  };

  const create = (): void => {
    nav.push('inventory.item.form', groupId !== null ? { groupId, initialName: search.trim() || undefined } : { initialName: search.trim() || undefined });
  };

  return (
    <ReportScreen
      title="Stock Items"
      subtitle={q.data ? countText(rows.length, 'item', 'items', total) : undefined}
      periodMode="none"
      outputInMore
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Type to Search · Enter Alter · Alt+C Create Stock Item · Alt+M Create several · Alt+D Delete · Alt+E Export"
      actions={itemListActions(
        { canCreate, canDelete, hasCurrent: current !== null, busy: del.pending },
        { create, createSeveral: () => nav.push('inventory.item.bulk', groupId !== null ? { groupId } : {}), remove: () => void remove(current) },
      )}
      filters={
        <div className="bx-inv-filters">
          <Field label="Search" hideLabel>
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              leadingIcon="search"
              placeholder="Name, alias, part no. or barcode"
              aria-label="Search stock items"
              data-autofocus=""
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  gridRef.current?.focus();
                }
              }}
            />
          </Field>
          <Field label="Under" hideLabel>
            <StockGroupPicker value={groupId} onChange={(id) => setGroupId(id)} allowCreate={false} placeholder="All groups" aria-label="Filter by stock group" />
          </Field>
          {showCategory ? (
            <Field label="Category" hideLabel>
              <StockCategoryPicker value={categoryId} onChange={(id) => setCategoryId(id)} allowCreate={false} placeholder="All categories" aria-label="Filter by category" />
            </Field>
          ) : null}
        </div>
      }
      exportDef={() => ({
        subtitle: `Stock as on ${formatDate(asOf)}`,
        columns: [
          { header: 'Name' },
          { header: 'Alias' },
          { header: 'Part no.' },
          { header: 'Under' },
          { header: 'Category' },
          ...(gstOn ? [{ header: 'HSN/SAC' }, { header: 'GST' }] : []),
          { header: 'In stock', kind: 'qty', decimals: 3 },
          { header: 'Unit' },
          { header: 'Selling price', kind: 'amount' },
        ],
        rows: rows.map((r) => [
          r.name,
          r.alias ?? '',
          r.partNo ?? '',
          r.groupName ?? '',
          r.categoryName ?? '',
          ...(gstOn ? [r.hsnSac ?? '', r.gstRate === null ? 'Inherited' : gstSummary({ taxability: 'taxable', rate: r.gstRate })] : []),
          r.isService ? null : (r.stockQty ?? 0),
          r.unitSymbol,
          r.sellingPrice,
        ]),
        landscape: true,
      })}
      footer={
        total > rows.length ? (
          // The context run already says "5,000 of 12,345 items": only the way out is added here.
          <p className="bx-inv-note">Only the first {rows.length.toLocaleString('en-IN')} are listed — type in Search to narrow the list.</p>
        ) : null
      }
    >
      <DataTable
        aria-label="Stock items"
        gridRef={gridRef}
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={selected}
        onSelect={(k) => setSelected(k ?? undefined)}
        onRowActivate={(r) => nav.push('inventory.item.form', { id: r.id })}
        loading={q.loading}
        virtualize="auto"
        typeToJump
        hideEmptyColumns
        empty={
          filtered ? (
            <EmptyState title="No items match" body="Change the search or the filters." />
          ) : (
            <EmptyState
              title="No stock items yet"
              body="Create the goods and services you buy and sell — one at a time, or several at once (Alt+M)."
              action={canCreate ? <Button onClick={create}>Create stock item</Button> : undefined}
            />
          )
        }
      />
    </ReportScreen>
  );
}

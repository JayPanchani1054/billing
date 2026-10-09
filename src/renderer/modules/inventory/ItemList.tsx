/**
 * 'inventory.item.list' — Stock Items. Search (name, alias, part no., barcode) and group /
 * category filters run on the server; the table is virtualised (thousands of rows stay smooth).
 * Enter alters the item, Alt+C creates, Alt+D (or Ctrl+D) deletes, Alt+M opens multiple creation,
 * Alt+E exports, Alt+P prints.
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
import { Badge, Button, DataTable, EmptyState, Field, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { FeatureOff, INVENTORY_INVALIDATES } from './common.tsx';
import { gstSummary } from './lib/itemForm.ts';
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
            {!r.isActive ? (
              <Badge size="sm" tone="neutral">
                Inactive
              </Badge>
            ) : null}
            {r.isService ? (
              <Badge size="sm" tone="info">
                Service
              </Badge>
            ) : null}
          </span>
        ),
        title: (r) => [r.name, r.alias, r.partNo ? `Part no. ${r.partNo}` : '', r.barcode ? `Barcode ${r.barcode}` : ''].filter(Boolean).join(' · '),
      },
      { key: 'groupName', header: 'Under', width: 180, sortable: true, value: (r) => r.groupName ?? '' },
      { key: 'categoryName', header: 'Category', width: 150, sortable: true, value: (r) => r.categoryName ?? '' },
      {
        key: 'stockQty',
        header: 'In stock',
        kind: 'number',
        width: 140,
        sortable: true,
        sortValue: (r) => r.stockQty ?? 0,
        render: (r) =>
          r.isService ? (
            <span className="bx-muted">—</span>
          ) : (
            <span className={(r.stockQty ?? 0) < 0 ? 'bx-inv-neg bx-num' : 'bx-num'}>{formatQty(r.stockQty ?? 0, decimalsOf(r.unitId), r.unitSymbol)}</span>
          ),
      },
      { key: 'unitSymbol', header: 'Unit', width: 80 },
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
    [decimalsOf, gstOn],
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
      subtitle={`Stock as on ${formatDate(asOf)} (working date, F2)`}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Type to Search · Enter Alter · Alt+C Create Stock Item · Alt+D Delete · Alt+E Export"
      actions={[
        { key: 'Alt+C', label: 'Create stock item', icon: 'plus', primary: true, onClick: create, hidden: !canCreate },
        { key: 'Alt+M', label: 'Multiple items', icon: 'layers', onClick: () => nav.push('inventory.item.bulk', groupId !== null ? { groupId } : {}), hidden: !canCreate },
        { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', onClick: () => void remove(current), hidden: !canDelete, disabled: !current, group: 'danger' },
      ]}
      filters={
        <div className="bx-inv-filters">
          <Field label="Search" hideLabel>
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              leadingIcon="search"
              placeholder="Search name, alias, part no. or barcode"
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
          <Field label="Category" hideLabel>
            <StockCategoryPicker value={categoryId} onChange={(id) => setCategoryId(id)} allowCreate={false} placeholder="All categories" aria-label="Filter by category" />
          </Field>
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
          <p className="bx-inv-note">
            Showing the first {rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} items. Type in Search to narrow the list.
          </p>
        ) : rows.length ? (
          <p className="bx-inv-note">
            {rows.length.toLocaleString('en-IN')} item{rows.length === 1 ? '' : 's'}
          </p>
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
        empty={
          filtered ? (
            <EmptyState icon="search" title="No items match" body="Change the search or the filters." />
          ) : (
            <EmptyState
              icon="box"
              title="No stock items yet"
              body="Create the goods and services you buy and sell. Press Alt+C, or Alt+M to create many at once."
              action={
                canCreate ? (
                  <Button variant="primary" icon="plus" shortcut="Alt+C" onClick={create}>
                    Create stock item
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
    </ReportScreen>
  );
}

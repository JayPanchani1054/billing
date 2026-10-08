/**
 * 'stock.summary' — Stock Summary (stock groups → items) and 'stock.categories' — the same by stock
 * category. Condensed shows the closing quantity, rate and value; Alt+F1 Detailed adds opening,
 * inward and outward. Enter drills a group / category into its own summary and an item into its
 * vouchers. Alt+V hides values (quantities only), Alt+Z lists items with nothing in the period,
 * Alt+X expands or collapses every group.
 */
import { useMemo, useState } from 'react';
import type { StockSummaryInput, StockSummaryResult, StockSummaryRow } from '../../../shared/types/stock.ts';
import { ReportScreen, useApiQuery, useFeatures } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { DataTable, Field, Inline } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { GodownPicker, StockCategoryPicker } from '../inventory/pickers.tsx';
import { amountColumn, NothingHere, qtyColumn, rateColumn, useDrill, useExpansion, useStockPeriod } from './components.tsx';
import { filterSubtitle, paramId, summaryDrill, summaryExport, visibleRows } from './lib/model.ts';

export interface StockSummaryParams {
  from?: string;
  to?: string;
  groupId?: number;
  categoryId?: number;
  godownId?: number;
}

type Mode = 'group' | 'category';

function SummaryReport({ mode, params }: { mode: Mode; params: StockSummaryParams | undefined }) {
  const p = useStockPeriod(params);
  const features = useFeatures();
  const drill = useDrill();
  const groupId = mode === 'group' ? paramId(params?.groupId) : undefined;
  const [categoryId, setCategoryId] = useState<number | undefined>(mode === 'group' ? paramId(params?.categoryId) : undefined);
  const [godownId, setGodownId] = useState<number | undefined>(paramId(params?.godownId));
  const [detailed, setDetailed] = useState(false);
  const [showValues, setShowValues] = useState(true);
  const [showZero, setShowZero] = useState(false);

  const input: StockSummaryInput = { from: p.from, to: p.to, groupId, categoryId, godownId, showValues, showZero };
  const byGroup = useApiQuery('stock.summary', input, { keepPrevious: true, enabled: mode === 'group' });
  const byCategory = useApiQuery('stock.categorySummary', { from: p.from, to: p.to, godownId, showValues, showZero }, { keepPrevious: true, enabled: mode === 'category' });
  const q = mode === 'group' ? byGroup : byCategory;
  const data: StockSummaryResult | undefined = q.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const expansion = useExpansion(rows, groupId !== undefined ? 1 : 99);
  const group = useApiQuery('inventory.group.get', { id: groupId ?? 0 }, { enabled: groupId !== undefined, staleTime: 60_000 });
  const valuesShown = data?.valuesShown ?? showValues;

  const columns = useMemo<Column<StockSummaryRow>[]>(() => {
    const unit = (r: StockSummaryRow) => r.unit;
    const hideDetail = !detailed;
    return [
      { key: 'name', header: 'Particulars', tree: true, minWidth: 240 },
      qtyColumn<StockSummaryRow>('openQty', 'Opening qty', (r) => r.opening.qty, unit, { hidden: hideDetail, blankZero: true }),
      amountColumn<StockSummaryRow>('openValue', 'Opening value', (r) => r.opening.value, { hidden: hideDetail || !valuesShown }),
      qtyColumn<StockSummaryRow>('inQty', 'Inward qty', (r) => r.inward.qty, unit, { hidden: hideDetail, blankZero: true }),
      amountColumn<StockSummaryRow>('inValue', 'Inward value', (r) => r.inward.value, { hidden: hideDetail || !valuesShown }),
      qtyColumn<StockSummaryRow>('outQty', 'Outward qty', (r) => r.outward.qty, unit, { hidden: hideDetail, blankZero: true }),
      amountColumn<StockSummaryRow>('outValue', 'Outward value', (r) => r.outward.value, { hidden: hideDetail || !valuesShown }),
      qtyColumn<StockSummaryRow>('closeQty', 'Closing qty', (r) => r.closing.qty, unit),
      rateColumn<StockSummaryRow>('rate', 'Rate', (r) => r.closing.rate, { hidden: !valuesShown }),
      { ...amountColumn<StockSummaryRow>('closeValue', 'Closing value', (r) => r.closing.value, { hidden: !valuesShown }), blankZero: false },
    ];
  }, [detailed, valuesShown]);

  const footer = useMemo<FooterRow[]>(() => {
    if (!data || rows.length === 0 || !valuesShown) return [];
    const t = data.totals;
    return [{ key: 'total', tone: 'total', cells: { name: 'Grand Total', openValue: t.openingValue, inValue: t.inwardValue, outValue: t.outwardValue, closeValue: t.closingValue } }];
  }, [data, rows.length, valuesShown]);

  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: 'columns', onClick: () => setDetailed(!detailed), group: 'view', hint: 'Show opening, inward and outward columns' },
    { key: 'Alt+V', label: showValues ? 'Quantities only' : 'Show values', icon: 'rupee', onClick: () => setShowValues(!showValues), group: 'view' },
    { key: 'Alt+Z', label: showZero ? 'Hide idle items' : 'Show all items', icon: 'eye', onClick: () => setShowZero(!showZero), group: 'view', hint: 'Include items with no stock and no movement in the period' },
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.toggleAll, group: 'view' },
  ];

  const title = mode === 'group' ? (groupId !== undefined && group.data ? `Stock Summary — ${group.data.name}` : 'Stock Summary') : 'Stock Categories';
  const subtitle = filterSubtitle([detailed ? 'Detailed' : null, valuesShown ? null : 'Quantities only']);

  return (
    <ReportScreen
      title={title}
      subtitle={subtitle}
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Open · →/← Expand/collapse · Alt+F1 Detailed · Alt+V Values · Alt+Z All items · Alt+E Export · Alt+P Print"
      filters={
        <Inline gap={2}>
          {features.multipleGodowns ? (
            <Field label="Godown" layout="inline" labelWidth={64}>
              <GodownPicker size="sm" value={godownId ?? null} onChange={(id) => setGodownId(id ?? undefined)} allowCreate={false} placeholder="All godowns" aria-label="Godown" />
            </Field>
          ) : null}
          {mode === 'group' ? (
            <Field label="Category" layout="inline" labelWidth={72}>
              <StockCategoryPicker size="sm" value={categoryId ?? null} onChange={(id) => setCategoryId(id ?? undefined)} allowCreate={false} placeholder="All categories" aria-label="Stock category" />
            </Field>
          ) : null}
        </Inline>
      }
      exportDef={() => ({
        subtitle,
        ...summaryExport(visibleRows(rows, expansion.expandedKeys), { detailed, valuesShown, totals: data?.totals ?? { openingValue: 0, inwardValue: 0, outwardValue: 0, closingValue: 0 } }),
      })}
    >
      <DataTable<StockSummaryRow>
        aria-label={title}
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level}
        isGroupRow={(r) => r.kind !== 'item'}
        expandable
        expandedKeys={expansion.expandedKeys}
        onExpandedChange={expansion.onExpandedChange}
        onRowActivate={(r) => drill(summaryDrill(r, { from: p.from, to: p.to, godownId }))}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={
          <NothingHere
            title="No stock to show for this period"
            body={showZero ? 'There are no stock items yet. Create items under Masters › Stock Items.' : 'Nothing was in stock or moved in this period. Change the period with Alt+F2, or press Alt+Z to list every item.'}
          />
        }
      />
    </ReportScreen>
  );
}

export function StockSummaryScreen({ params }: ScreenProps<StockSummaryParams>) {
  return <SummaryReport mode="group" params={params} />;
}

export function StockCategoriesScreen({ params }: ScreenProps<StockSummaryParams>) {
  return <SummaryReport mode="category" params={params} />;
}

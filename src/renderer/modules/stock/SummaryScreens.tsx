/**
 * 'stock.summary' — Stock Summary (stock groups → items) and 'stock.categories' — the same by stock
 * category. Condensed shows the closing quantity, rate and value; Alt+F1 Detailed adds opening,
 * inward and outward. Enter drills a group / category into its own summary and an item into its
 * vouchers. Alt+V hides values (quantities only), Alt+Z lists items with nothing in the period,
 * Alt+X expands or collapses every group.
 *
 * 2.1 graph (SPEC-21 §5): "Where money is locked in stock" — the level-0 rows by closing value, drawn
 * as 4 px bars under the Closing value cells when there are ≤ 7 of them, else a Top 6 + Other strip;
 * none in Quantities only. The toolbar row holds the Category select (and the Godown one, behind
 * "Filters ▾", when there are godowns).
 */
import { useCallback, useMemo, useState } from 'react';
import type { StockSummaryInput, StockSummaryResult, StockSummaryRow } from '../../../shared/types/stock.ts';
import { ReportScreen, useApiQuery, useFeatures } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { DataTable } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { GodownPicker, StockCategoryPicker } from '../inventory/pickers.tsx';
import { amountColumn, NothingHere, qtyColumn, rateColumn, StockFilters, useDrill, useExpansion, useStockPeriod, withBar } from './components.tsx';
import type { StockFilter } from './components.tsx';
import { stockSummaryChart, stockSummaryInline, summaryBarValue } from './lib/charts.ts';
import { filterSubtitle, paramId, signedAmountText, summaryDrill, summaryExport, visibleRows } from './lib/model.ts';

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

  const open = useCallback((r: StockSummaryRow) => drill(summaryDrill(r, { from: p.from, to: p.to, godownId, categoryId })), [drill, p.from, p.to, godownId, categoryId]);
  const spec = useMemo(() => (data ? stockSummaryChart(data, mode, open) : null), [data, mode, open]);
  const inline = useMemo(() => (data ? stockSummaryInline(data, spec) : false), [data, spec]);

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
      withBar(
        amountColumn<StockSummaryRow>('closeValue', 'Closing value', (r) => r.closing.value, { hidden: !valuesShown, blankZero: false }),
        inline,
        summaryBarValue,
      ),
    ];
  }, [detailed, valuesShown, inline]);

  const footer = useMemo<FooterRow[]>(() => {
    if (!data || rows.length === 0 || !valuesShown) return [];
    const t = data.totals;
    return [{ key: 'total', tone: 'total', cells: { name: 'Grand Total', openValue: signedAmountText(t.openingValue, true), inValue: signedAmountText(t.inwardValue, true), outValue: signedAmountText(t.outwardValue, true), closeValue: signedAmountText(t.closingValue) } }];
  }, [data, rows.length, valuesShown]);

  const actions: ScreenActionItem[] = [
    { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: 'columns', onClick: () => setDetailed(!detailed), group: 'view', hint: 'Show opening, inward and outward columns' },
    { key: 'Alt+V', label: showValues ? 'Quantities only' : 'Show values', icon: 'rupee', onClick: () => setShowValues(!showValues), group: 'view' },
    { key: 'Alt+Z', label: showZero ? 'Hide idle items' : 'Show all items', icon: 'eye', onClick: () => setShowZero(!showZero), group: 'view', hint: 'Include items with no stock and no movement in the period' },
    { key: 'Alt+X', label: expansion.allOpen ? 'Collapse all' : 'Expand all', icon: 'chevrons-up-down', onClick: expansion.toggleAll, group: 'view' },
  ];

  const title = mode === 'group' ? (groupId !== undefined && group.data ? `Stock Summary — ${group.data.name}` : 'Stock Summary') : 'Stock Categories';
  const subtitle = filterSubtitle([detailed ? 'Detailed' : null, valuesShown ? null : 'Quantities only']);
  const filters: StockFilter[] = [
    ...(mode === 'group'
      ? [{ key: 'category', label: 'Category', active: categoryId !== undefined, clear: () => setCategoryId(undefined), node: <StockCategoryPicker size="sm" value={categoryId ?? null} onChange={(id) => setCategoryId(id ?? undefined)} allowCreate={false} placeholder="All categories" aria-label="Stock category" /> }]
      : []),
    ...(features.multipleGodowns
      ? [{ key: 'godown', label: 'Godown', active: godownId !== undefined, clear: () => setGodownId(undefined), node: <GodownPicker size="sm" value={godownId ?? null} onChange={(id) => setGodownId(id ?? undefined)} allowCreate={false} placeholder="All godowns" aria-label="Godown" /> }]
      : []),
  ];

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
      graph={reportGraph(spec, { inline })}
      filters={filters.length > 0 ? <StockFilters filters={filters} /> : undefined}
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
        onRowActivate={open}
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

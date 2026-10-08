/**
 * 'stock.item' { itemId, from?, to?, godownId? } — Stock Item Vouchers: opening balance, every
 * voucher that moved the item (inward / outward quantity and value at cost) with the running
 * closing balance, totals and closing. Enter opens the voucher. Another item can be chosen in the
 * toolbar; Alt+M opens the item master.
 */
import { useMemo, useState } from 'react';
import type { StockItemVoucherRow } from '../../../shared/types/stock.ts';
import { formatDate, ReportScreen, useApiQuery, useCan, useFeatures, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState, Field, Inline } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { GodownPicker, ItemPicker } from '../inventory/pickers.tsx';
import { amountColumn, NothingHere, qtyColumn, useStockPeriod } from './components.tsx';
import { costingLabel, filterSubtitle, itemVouchersExport, paramId, qtyText } from './lib/model.ts';

export interface StockItemParams {
  itemId?: number;
  from?: string;
  to?: string;
  godownId?: number;
}

export function StockItemScreen({ params }: ScreenProps<StockItemParams>) {
  const p = useStockPeriod(params);
  const nav = useNav();
  const features = useFeatures();
  const canViewVouchers = useCan('vouchers.view');
  const [itemId, setItemId] = useState<number | undefined>(paramId(params?.itemId));
  const [godownId, setGodownId] = useState<number | undefined>(paramId(params?.godownId));
  const q = useApiQuery('stock.itemVouchers', { itemId: itemId ?? 0, from: p.from, to: p.to, godownId }, { keepPrevious: true, enabled: itemId !== undefined });
  const d = q.data;
  const rows = useMemo(() => d?.rows ?? [], [d]);
  const unit = d?.item.unit ?? '';

  const columns = useMemo<Column<StockItemVoucherRow>[]>(() => {
    const u = () => unit;
    return [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'particulars', header: 'Particulars', minWidth: 200 },
      { key: 'voucherTypeName', header: 'Vch type', width: 130 },
      { key: 'number', header: 'Vch no.', width: 90 },
      { key: 'godowns', header: 'Godown', width: 140, hidden: !features.multipleGodowns },
      qtyColumn<StockItemVoucherRow>('inQty', 'Inward qty', (r) => r.inward.qty, u, { blankZero: true }),
      amountColumn<StockItemVoucherRow>('inValue', 'Inward value', (r) => r.inward.value),
      qtyColumn<StockItemVoucherRow>('outQty', 'Outward qty', (r) => r.outward.qty, u, { blankZero: true }),
      amountColumn<StockItemVoucherRow>('outValue', 'Outward value', (r) => r.outward.value),
      qtyColumn<StockItemVoucherRow>('closeQty', 'Closing qty', (r) => r.closing.qty, u),
      { ...amountColumn<StockItemVoucherRow>('closeValue', 'Closing value', (r) => r.closing.value), blankZero: false },
    ];
  }, [unit, features.multipleGodowns]);

  const footer = useMemo<FooterRow[]>(() => {
    if (!d) return [];
    return [
      { key: 'opening', tone: 'subtle', cells: { particulars: `Opening balance on ${formatDate(d.from)}`, closeQty: qtyText(d.opening.qty, unit), closeValue: d.opening.value } },
      { key: 'total', tone: 'subtle', cells: { particulars: 'Total for the period', inQty: qtyText(d.totals.inwardQty, unit, { blankZero: true }), inValue: d.totals.inwardValue, outQty: qtyText(d.totals.outwardQty, unit, { blankZero: true }), outValue: d.totals.outwardValue } },
      { key: 'closing', tone: 'total', cells: { particulars: `Closing balance on ${formatDate(d.to)}`, closeQty: qtyText(d.closing.qty, unit), closeValue: d.closing.value } },
    ];
  }, [d, unit]);

  const actions: ScreenActionItem[] = [
    { key: 'Alt+M', label: 'Item master', icon: 'box', onClick: () => itemId !== undefined && nav.push('inventory.item.form', { id: itemId }), disabled: itemId === undefined, group: 'go' },
  ];

  const title = d ? d.item.name : 'Stock Item Vouchers';
  const subtitle = d ? filterSubtitle([d.item.groupName ? `Under ${d.item.groupName}` : null, `Valued at ${costingLabel(d.item.costingMethod).toLowerCase()}`]) : undefined;

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
      hint="Enter Open voucher · Alt+M Item master · Alt+F2 Period · Alt+E Export · Alt+P Print · Esc Back"
      filters={
        <Inline gap={2}>
          <Field label="Item" layout="inline" labelWidth={40}>
            <ItemPicker size="sm" value={d ? { id: d.item.id, name: d.item.name } : null} onChange={(row) => row && setItemId(row.id)} allowCreate={false} goodsOnly aria-label="Stock item" />
          </Field>
          {features.multipleGodowns ? (
            <Field label="Godown" layout="inline" labelWidth={64}>
              <GodownPicker size="sm" value={godownId ?? null} onChange={(id) => setGodownId(id ?? undefined)} allowCreate={false} placeholder="All godowns" aria-label="Godown" />
            </Field>
          ) : null}
        </Inline>
      }
      exportDef={d ? () => ({ title: `Stock Item Vouchers — ${d.item.name}`, ...itemVouchersExport(d) }) : undefined}
    >
      {itemId === undefined ? (
        <EmptyState icon="box" title="Choose a stock item" body="Type the item's name in the Item box above to see its vouchers." />
      ) : (
        <DataTable<StockItemVoucherRow>
          aria-label={`Vouchers of ${title}`}
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          onRowActivate={(r) => {
            if (canViewVouchers) nav.push('vouchers.view', { id: r.voucherId });
          }}
          footerRows={footer}
          loading={q.loading}
          empty={<NothingHere title="No movement in this period" body="This item was not bought, sold or moved in the period. Change the period with Alt+F2." />}
        />
      )}
    </ReportScreen>
  );
}

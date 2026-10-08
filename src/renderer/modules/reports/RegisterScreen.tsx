/**
 * 'reports.register' {baseType? | voucherTypeId?, from?, to?, view?} — voucher register (Sales,
 * Purchase, Payment …): month-wise count and value; Enter on a month lists its vouchers (Alt+V
 * toggles), Enter on a voucher opens it, Alt+A alters it. Cancelled vouchers are listed (marked) but
 * not totalled; optional vouchers are in Exception Reports.
 */
import { useMemo, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { RegisterMonth, RegisterVoucher } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, DataTable, EmptyState, Inline, Select, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { REGISTERS, currentRow, monthLabel, voucherTarget } from './lib/model.ts';

export interface RegisterParams {
  baseType?: VoucherBaseType;
  voucherTypeId?: number;
  from?: string;
  to?: string;
  view?: 'months' | 'vouchers';
}

type View = 'months' | 'vouchers';

export function RegisterScreen({ params }: ScreenProps<RegisterParams>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const voucherTypeId = typeof params?.voucherTypeId === 'number' ? params.voucherTypeId : undefined;
  const [baseType, setBaseType] = useState<VoucherBaseType>(params?.baseType ?? 'sales');
  const [view, setView] = useState<View>(params?.view ?? 'months');
  const [cursor, setCursor] = useState<RegisterVoucher | null>(null);
  const subject = voucherTypeId !== undefined ? { voucherTypeId } : { baseType };
  const q = useApiQuery('reports.register', { ...subject, from: p.from, to: p.to, includeVouchers: view === 'vouchers' }, { keepPrevious: true });
  const d = q.data;
  const current = view === 'vouchers' ? currentRow(cursor, d?.vouchers, (r) => r.id) : null;

  const monthColumns = useMemo<Column<RegisterMonth>[]>(
    () => [
      { key: 'month', header: 'Month', minWidth: 160, render: (r) => monthLabel(r.month), value: (r) => monthLabel(r.month) },
      { key: 'count', header: 'Vouchers', kind: 'number', width: 110, total: true },
      { key: 'cancelled', header: 'Cancelled', kind: 'number', width: 110, total: true },
      { key: 'taxable', header: 'Taxable value', kind: 'amount', width: 160, blankZero: true, total: true },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 140, blankZero: true, total: true },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 170, total: true },
    ],
    [],
  );
  const voucherColumns = useMemo<Column<RegisterVoucher>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      {
        key: 'partyName',
        header: 'Particulars',
        minWidth: 200,
        value: (r) => r.partyName ?? r.narration ?? '',
        render: (r) => (
          <Inline gap={1} wrap={false}>
            <span className="bx-truncate">{r.partyName ?? r.narration ?? ''}</span>
            {r.isCancelled ? (
              <Badge size="sm" tone="danger">
                Cancelled
              </Badge>
            ) : null}
            {r.isPostDated ? (
              <Badge size="sm" tone="info">
                Post-dated
              </Badge>
            ) : null}
          </Inline>
        ),
      },
      { key: 'voucherType', header: 'Vch Type', width: 140 },
      { key: 'number', header: 'Vch No.', width: 120 },
      { key: 'referenceNo', header: 'Ref. No.', width: 120 },
      { key: 'taxable', header: 'Taxable value', kind: 'amount', width: 150, blankZero: true },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 130, blankZero: true },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 160 },
    ],
    [],
  );
  const vFooter: FooterRow[] = d ? [{ key: 'total', tone: 'total', cells: { partyName: `Total (${d.totals.count} vouchers)`, taxable: d.totals.taxable, tax: d.totals.tax, amount: d.totals.amount } }] : [];

  const actions: ScreenActionItem[] = [
    { key: 'Alt+V', label: view === 'months' ? 'Voucher list' : 'Monthly view', icon: 'list', onClick: () => setView(view === 'months' ? 'vouchers' : 'months'), group: 'view' },
    { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', onClick: () => current && !current.isCancelled && drill(voucherTarget(current.id, current.baseType, true)), hidden: view !== 'vouchers', disabled: !current || current.isCancelled, group: 'voucher' },
  ];
  const title = d?.title ?? (voucherTypeId === undefined ? (REGISTERS.find((r) => r.baseType === baseType)?.label ?? 'Register') : 'Register');

  return (
    <ReportScreen
      title={title}
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint={view === 'months' ? 'Enter Vouchers of the month · Alt+V Voucher list' : 'Enter Open voucher · Alt+A Alter · Alt+V Monthly view'}
      filters={
        voucherTypeId === undefined ? (
          <Select<VoucherBaseType>
            aria-label="Register"
            size="sm"
            value={baseType}
            onChange={setBaseType}
            options={REGISTERS.map((r) => ({ value: r.baseType, label: r.label }))}
          />
        ) : undefined
      }
      exportDef={() =>
        view === 'months'
          ? {
              columns: [{ header: 'Month' }, { header: 'Vouchers', kind: 'number' }, { header: 'Cancelled', kind: 'number' }, { header: 'Taxable value', kind: 'amount' }, { header: 'Tax', kind: 'amount' }, { header: 'Amount', kind: 'amount' }],
              rows: (d?.months ?? []).map((m) => [monthLabel(m.month), m.count, m.cancelled, m.taxable, m.tax, m.amount]),
              totals: d ? ['Total', d.totals.count, d.totals.cancelled, d.totals.taxable, d.totals.tax, d.totals.amount] : undefined,
            }
          : {
              columns: [{ header: 'Date', kind: 'date' }, { header: 'Particulars' }, { header: 'Vch Type' }, { header: 'Vch No.' }, { header: 'Ref. No.' }, { header: 'Status' }, { header: 'Taxable value', kind: 'amount' }, { header: 'Tax', kind: 'amount' }, { header: 'Amount', kind: 'amount' }],
              rows: (d?.vouchers ?? []).map((v) => [v.date, v.partyName ?? v.narration ?? '', v.voucherType, v.number ?? '', v.referenceNo ?? '', v.isCancelled ? 'Cancelled' : v.isPostDated ? 'Post-dated' : '', v.taxable, v.tax, v.amount]),
              totals: d ? ['', 'Total', '', '', '', '', d.totals.taxable, d.totals.tax, d.totals.amount] : undefined,
              landscape: true,
            }
      }
    >
      {view === 'months' ? (
        <DataTable<RegisterMonth>
          aria-label={`${title} by month`}
          className="bx-rep-fill"
          columns={monthColumns}
          rows={d?.months ?? []}
          getRowKey={(r) => r.month}
          onRowActivate={(r) => drill({ screen: 'reports.register', params: { ...subject, from: r.from, to: r.to, view: 'vouchers' } })}
          loading={q.loading}
          empty={<EmptyState icon="calendar" title="No months in this period" body="Change the period with Alt+F2." />}
          autoFocus
        />
      ) : (
        <Stack gap={2} grow>
          <DataTable<RegisterVoucher>
            aria-label={`${title} vouchers`}
            className="bx-rep-fill"
            columns={voucherColumns}
            rows={d?.vouchers ?? []}
            getRowKey={(r) => String(r.id)}
            onRowActivate={(r) => drill(voucherTarget(r.id, r.baseType))}
            onSelect={(_k, r) => setCursor(r)}
            getRowClassName={(r) => (r.isCancelled ? 'bx-muted' : undefined)}
            footerRows={vFooter}
            loading={q.loading}
            empty={<EmptyState icon="receipt" title="No vouchers in this period" body="Change the period with Alt+F2, or enter one from the Gateway." />}
            autoFocus
          />
          {d?.truncated ? <p className="bx-rep-note">Only the first {d.vouchers?.length.toLocaleString('en-IN')} vouchers are listed; the totals include all of them.</p> : null}
        </Stack>
      )}
    </ReportScreen>
  );
}

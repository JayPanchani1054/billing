/**
 * 'reports.statistics' — voucher counts by type for the period (regular / optional / cancelled /
 * post-dated) and the number of masters. Enter on a voucher type opens its register.
 */
import { useMemo } from 'react';
import type { VoucherStatRow } from '../../../shared/types/reports.ts';
import { ReportScreen, useApiQuery } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';

interface MasterRow {
  key: string;
  label: string;
  count: number;
}

export function StatisticsScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const p = useReportPeriod(params);
  const drill = useDrill();
  const q = useApiQuery('reports.statistics', { from: p.from, to: p.to }, { keepPrevious: true });
  const d = q.data;
  const columns = useMemo<Column<VoucherStatRow>[]>(
    () => [
      { key: 'name', header: 'Voucher Type', minWidth: 180, sortable: true },
      { key: 'regular', header: 'Regular', kind: 'number', width: 110, sortable: true },
      { key: 'optional', header: 'Optional', kind: 'number', width: 110, sortable: true },
      { key: 'cancelled', header: 'Cancelled', kind: 'number', width: 110, sortable: true },
      { key: 'postDated', header: 'Post-dated', kind: 'number', width: 110, sortable: true },
      { key: 'total', header: 'Total', kind: 'number', width: 110, sortable: true },
    ],
    [],
  );
  const masterColumns = useMemo<Column<MasterRow>[]>(
    () => [
      { key: 'label', header: 'Masters', minWidth: 180 },
      { key: 'count', header: 'Count', kind: 'number', width: 110 },
    ],
    [],
  );
  const footer: FooterRow[] = d ? [{ key: 'total', tone: 'total', cells: { name: 'Total', ...d.voucherTotals } }] : [];
  return (
    <ReportScreen
      title="Statistics"
      period={p.period}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Register of the voucher type · Tab Masters"
      exportDef={() => ({
        columns: [{ header: 'Particulars' }, { header: 'Regular', kind: 'number' }, { header: 'Optional', kind: 'number' }, { header: 'Cancelled', kind: 'number' }, { header: 'Post-dated', kind: 'number' }, { header: 'Total', kind: 'number' }],
        rows: d ? [...d.vouchers.map((v) => [v.name, v.regular, v.optional, v.cancelled, v.postDated, v.total]), ...d.masters.map((m) => [m.label, null, null, null, null, m.count])] : [],
        totals: d ? ['Total vouchers', d.voucherTotals.regular, d.voucherTotals.optional, d.voucherTotals.cancelled, d.voucherTotals.postDated, d.voucherTotals.total] : undefined,
      })}
    >
      {d ? (
        <div className="bx-rep-sides">
          <section className="bx-rep-side" aria-label="Vouchers">
            <div className="bx-rep-side__title">Vouchers</div>
            <DataTable<VoucherStatRow>
              aria-label="Voucher counts by type"
              columns={columns}
              rows={d.vouchers}
              getRowKey={(r) => String(r.voucherTypeId)}
              onRowActivate={(r) => drill({ screen: 'reports.register', params: { voucherTypeId: r.voucherTypeId, from: p.from, to: p.to } })}
              footerRows={footer}
              virtualize={false}
              autoFocus
            />
          </section>
          <section className="bx-rep-side" aria-label="Masters">
            <div className="bx-rep-side__title">Masters</div>
            <DataTable<MasterRow> aria-label="Master counts" columns={masterColumns} rows={d.masters} getRowKey={(r) => r.key} virtualize={false} />
          </section>
        </div>
      ) : (
        <EmptyState icon="chart" title="No statistics yet" body="Change the period with Alt+F2." />
      )}
    </ReportScreen>
  );
}

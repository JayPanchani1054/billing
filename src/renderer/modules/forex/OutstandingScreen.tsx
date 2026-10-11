/**
 * 'forex.outstanding' { kind? } — Outstanding bills in foreign currencies, as on the period's end:
 * per party the balance in the currency and in rupees as carried in the books, the closing rate and the
 * rupee value at that rate (unrealised gain / loss), with the pending bills below (booked rate,
 * overdue days). Enter drills to the party's ledger in both currencies (or the bill's voucher);
 * Alt+V period-end revaluation; Alt+O opening balance in the currency; Ctrl+1/2/3 all / receivable /
 * payable; Alt+E export; Alt+P print.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { ReportScreen, useApiQuery, useFeatures, useNav, usePeriod } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { DataTable, EmptyState, SegmentedControl, StatLine } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { ForexOff } from './components.tsx';
import { outstandingChart, outstandingStat } from './lib/charts.ts';
import { currencyMap, fxDrCr, outstandingExport, outstandingRows, rateText, RATE_TYPE_LABEL, type OutstandingRow } from './lib/model.ts';

type Kind = 'all' | 'receivable' | 'payable';

export function OutstandingScreen({ params }: ScreenProps<{ kind?: Kind; ledgerId?: number }>) {
  const nav = useNav();
  const features = useFeatures();
  const { to } = usePeriod();
  const [kind, setKind] = useState<Kind>(params?.kind ?? 'all');
  // Opened from a party (outstanding.party Alt+Y): that party only, until Ctrl+1/2/3 picks a side.
  const [ledgerId, setLedgerId] = useState<number | null>(typeof params?.ledgerId === 'number' ? params.ledgerId : null);
  const q = useApiQuery('forex.outstanding', ledgerId !== null ? { asOf: to, kind, ledgerId } : { asOf: to, kind }, { enabled: features.multiCurrency, keepPrevious: true });
  const d = q.data;
  const cur = useMemo(() => currencyMap(d?.currencies ?? []), [d]);
  const rows = useMemo(() => (d ? outstandingRows(d) : []), [d]);
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => r.key === cursor) ?? null;
  // One side only: "All" mixes what is owed to you with what you owe (no graph).
  const spec = useMemo(() => (d ? outstandingChart(d, kind) : null), [d, kind]);
  const stat = d ? outstandingStat(d) : [];

  const columns = useMemo<Column<OutstandingRow>[]>(
    () => [
      { key: 'name', header: 'Party / bill', tree: true, minWidth: 220 },
      { key: 'date', header: 'Bill date', kind: 'date', width: 110, value: (r) => r.date ?? '' },
      {
        key: 'due',
        header: 'Due',
        width: 140,
        value: (r) => r.dueDate ?? '',
        render: (r) =>
          r.dueDate ? (
            <span>
              {formatDate(r.dueDate, 'D-MMM-YY')} {r.overdueDays ? <span className="bx-muted">· {r.overdueDays} d</span> : null}
            </span>
          ) : null,
      },
      { key: 'forex', header: 'Foreign amount', width: 160, align: 'right', value: (r) => r.forex, render: (r) => <span className="bx-num">{fxDrCr(r.forex, cur.get(r.currencyId))}</span> },
      { key: 'booked', header: 'Booked rate', width: 110, align: 'right', value: (r) => r.bookedRate ?? 0, render: (r) => <span className="bx-num">{rateText(r.bookedRate)}</span> },
      { key: 'inr', header: 'In books (₹)', kind: 'drcr', width: 150 },
      { key: 'closing', header: 'Closing rate', width: 110, align: 'right', value: (r) => r.closingRate ?? 0, render: (r) => <span className="bx-num">{rateText(r.closingRate)}</span> },
      { key: 'revalued', header: 'At closing rate (₹)', kind: 'drcr', width: 160, value: (r) => r.revalued ?? 0 },
      {
        key: 'difference',
        header: 'Unrealised (₹)',
        width: 150,
        align: 'right',
        value: (r) => r.difference ?? 0,
        render: (r) =>
          r.difference === null ? <span className="bx-muted">no rate</span> : r.difference === 0 ? null : <span className="bx-num">{`${formatMoney(Math.abs(r.difference))} ${r.difference > 0 ? 'gain' : 'loss'}`}</span>,
      },
    ],
    [cur],
  );

  if (!features.multiCurrency) return <ForexOff title="Forex Outstanding" />;
  const kindActions = (['all', 'receivable', 'payable'] as const).map((k, i) => ({
    key: `Ctrl+${i + 1}`,
    label: k === 'all' ? 'All parties' : k === 'receivable' ? 'Receivables' : 'Payables',
    onClick: () => {
      setKind(k);
      setLedgerId(null);
    },
    group: 'view',
  }));
  return (
    <ReportScreen
      title="Forex Outstanding"
      periodMode="asOn"
      graph={reportGraph(spec)}
      stat={stat.length ? <StatLine items={stat} /> : undefined}
      about={
        <p>
          Bills still pending in a foreign currency: the amount in the currency, the rate each was booked at and the rupees in the books, then the closing rate
          {d ? ` (the ${RATE_TYPE_LABEL[d.rateType].toLowerCase()} rate on or before ${formatDate(d.asOf)})` : ''}, what the bill is worth at it and the unrealised gain or loss. Enter the
          closing rate in Currencies › Rates of Exchange; Alt+V posts the revaluation.
        </p>
      }
      loading={q.loading && !d}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={
        <SegmentedControl<Kind>
          aria-label="Parties"
          size="sm"
          value={kind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'receivable', label: 'Receivables' },
            { value: 'payable', label: 'Payables' },
          ]}
          onChange={(k) => {
            setKind(k);
            setLedgerId(null);
          }}
        />
      }
      exportDef={() => (d ? { ...outstandingExport(d), subtitle: `As on ${formatDate(d.asOf)}` } : { columns: [], rows: [] })}
      actions={[
        ...kindActions,
        { key: 'Alt+L', label: 'Ledger in both currencies', icon: 'ledger', disabled: !current, onClick: () => current && nav.push('forex.ledger', { ledgerId: current.ledgerId }) },
        { key: 'Alt+O', label: 'Opening in currency', icon: 'edit', disabled: !current, onClick: () => current && nav.push('forex.opening', { ledgerId: current.ledgerId }) },
        { key: 'Alt+V', label: 'Revaluation', icon: 'refresh', onClick: () => nav.push('forex.revaluation', { asOf: to }) },
      ]}
      hint="Enter Ledger / voucher · Ctrl+1 All · Ctrl+2 Receivables · Ctrl+3 Payables · Alt+V Revaluation · Alt+E Export · Esc Back"
    >
      <DataTable<OutstandingRow>
        aria-label="Outstanding in foreign currencies"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        getRowLevel={(r) => r.level}
        isGroupRow={(r) => r.isGroup}
        expandable
        defaultExpanded="all"
        selectedKey={cursor}
        onSelect={(k) => setCursor(k)}
        onRowActivate={(r) => {
          if (r.level === 0) return void nav.push('forex.ledger', { ledgerId: r.ledgerId });
          const bill = d?.parties.find((p) => p.ledgerId === r.ledgerId)?.bills.find((b) => b.billName === r.name);
          if (bill?.voucherId) nav.push('vouchers.view', { id: bill.voucherId });
          else nav.push('forex.ledger', { ledgerId: r.ledgerId });
        }}
        empty={<EmptyState title="Nothing outstanding in a foreign currency" body="Parties kept in a foreign currency (Ledger › Currency) with a balance appear here." />}
      />
    </ReportScreen>
  );
}

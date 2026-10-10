/**
 * 'vouchers.daybook' {from?, to?} — every voucher of a day or period (Day Book).
 *
 * Defaults to the working date (and follows F2 until the range is changed here). Filters: type chips,
 * search (number / party / narration / exact amount), optional and cancelled toggles.
 * Enter / Alt+A alter, Alt+Enter views, Ctrl+P prints the voucher, Alt+D deletes, Alt+2 duplicates;
 * Alt+T today, Alt+E export, Alt+P print (the Day Book itself).
 */
import { useEffect, useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { VoucherListInput } from '../../../shared/types/vouchers.ts';
import { ReportScreen, useApiQuery, useFeatures, usePeriod, useWorkingDate } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Button, Checkbox, DateInput, EmptyState, Inline, TextInput, useDebouncedValue } from '../../ui/index.ts';
import { baseTypesOf, DAYBOOK_CHIPS, dayBookExportRows, dayBookExportTotals, SEARCH_MAX, searchText, toDayBookRow, toggleChip } from './lib/daybook.ts';
import { useVoucherTable, VoucherTable } from './VoucherTable.tsx';

const LIMIT = 1000;

export function DayBookScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const working = useWorkingDate();
  const period = usePeriod();
  const features = useFeatures();
  const [range, setRange] = useState(() => ({ from: params.from ?? working.date, to: params.to ?? params.from ?? working.date, custom: params.from !== undefined }));
  // Follow the working date (F2) until the user picks a range here.
  useEffect(() => {
    if (!range.custom) setRange({ from: working.date, to: working.date, custom: false });
  }, [working.date, range.custom]);
  const [chips, setChips] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(searchText(search), 250);
  const [includeOptional, setIncludeOptional] = useState(true);
  const [includeCancelled, setIncludeCancelled] = useState(true);

  const input = useMemo<VoucherListInput>(() => {
    const i: VoucherListInput = { from: range.from, to: range.to < range.from ? range.from : range.to, includeOptional, includeCancelled, limit: LIMIT, sort: 'date_asc' };
    const b = baseTypesOf(chips);
    if (b) i.baseTypes = b;
    if (debounced) i.search = debounced;
    return i;
  }, [range, chips, debounced, includeOptional, includeCancelled]);
  const q = useApiQuery('vouchers.list', input, { keepPrevious: true });
  const rows = useMemo(() => (q.data?.rows ?? []).map(toDayBookRow), [q.data]);
  const table = useVoucherTable(rows);

  const visibleChips = DAYBOOK_CHIPS.filter((c) => (c.id === 'orders' ? features.orderProcessing : c.id === 'stock' ? features.inventory : true));
  const single = range.from === range.to;
  const subtitle = single ? formatDate(range.from) : `${formatDate(range.from)} to ${formatDate(range.to)}`;
  const setFrom = (d: string | null) => d && setRange((r) => ({ from: d, to: r.to < d ? d : r.to, custom: true }));
  const setTo = (d: string | null) => d && setRange((r) => ({ from: r.from > d ? d : r.from, to: d, custom: true }));
  const total = q.data?.total ?? 0;

  return (
    <ReportScreen
      title="Day Book"
      subtitle={subtitle}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+Enter View · Ctrl+P Print Voucher · Alt+F2 Period · Alt+T Today · Alt+D Delete · Alt+2 Duplicate · Alt+E Export"
      actions={[
        { key: 'Alt+F2', label: 'Period', icon: 'calendar', onClick: () => document.getElementById('vch-db-from')?.focus(), group: 'period' },
        { key: 'Alt+T', label: 'Today', icon: 'clock', onClick: () => setRange({ from: working.date, to: working.date, custom: false }), group: 'period' },
        ...table.actions,
      ]}
      exportDef={() => ({
        title: 'Day Book',
        subtitle: chips.length > 0 ? visibleChips.filter((c) => chips.includes(c.id)).map((c) => c.label).join(', ') : 'All vouchers',
        period: { from: input.from, to: input.to },
        columns: [{ header: 'Date', kind: 'date' }, { header: 'Particulars' }, { header: 'Vch Type' }, { header: 'Vch No.' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }],
        rows: dayBookExportRows(rows),
        totals: rows.length > 0 ? dayBookExportTotals(rows) : undefined,
      })}
      filters={
        <div className="bx-vch-filters">
          <Inline gap={2} align="center">
            <DateInput id="vch-db-from" aria-label="From date" size="sm" value={range.from} referenceDate={working.date} onChange={setFrom} />
            <span className="bx-muted">to</span>
            <DateInput aria-label="To date" size="sm" value={range.to} referenceDate={working.date} minDate={range.from} onChange={setTo} />
            <Button size="sm" variant="ghost" onClick={() => setRange({ from: period.from, to: period.to, custom: true })}>
              {period.label}
            </Button>
            <TextInput size="sm" leadingIcon="search" aria-label="Search vouchers" placeholder="Number, party, narration or amount" maxLength={SEARCH_MAX} value={search} onValueChange={setSearch} />
          </Inline>
          <Inline gap={1} align="center" aria-label="Voucher types">
            {visibleChips.map((c) => (
              <Button key={c.id} size="sm" variant={chips.includes(c.id) ? 'primary' : 'secondary'} aria-pressed={chips.includes(c.id)} onClick={() => setChips((s) => toggleChip(s, c.id))}>
                {c.label}
              </Button>
            ))}
            <Checkbox checked={includeOptional} onChange={setIncludeOptional} label="Optional" />
            <Checkbox checked={includeCancelled} onChange={setIncludeCancelled} label="Cancelled" />
          </Inline>
        </div>
      }
      footer={total > rows.length ? <p className="bx-muted">Showing the first {rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} vouchers — choose a shorter period or a voucher type.</p> : undefined}
    >
      <VoucherTable
        label="Day Book"
        rows={rows}
        state={table}
        loading={q.loading}
        empty={
          <EmptyState
            icon="book"
            title={debounced || chips.length > 0 ? 'No vouchers match' : single ? `No vouchers on ${formatDate(range.from)}` : 'No vouchers in this period'}
            body={debounced || chips.length > 0 ? 'Clear the search or the type filters.' : 'Change the date (Alt+F2) or create one: F8 Sales, F9 Purchase, F6 Receipt, F5 Payment.'}
          />
        }
      />
    </ReportScreen>
  );
}

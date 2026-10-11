/**
 * 'vouchers.daybook' {from?, to?} — every voucher of a day or period (Day Book).
 *
 * 2.1 (SPEC-21 §1.6): the date lives in the title row — one quiet date while the Day Book shows one day
 * (the working date, following F2 until the range is changed here), From – To once it spans more than a
 * day (Alt+F2, More › "Date range…" or "Whole period"). The toolbar row holds the "Voucher types: …"
 * menu (multi-select), one search (Ctrl+F) and the count. Optional and cancelled vouchers are keyless
 * checkable More items (both shown by default, as in 2.0).
 * Enter / Alt+A alter, Alt+Enter views, Ctrl+P prints the voucher, Alt+D deletes, Alt+2 duplicates;
 * Alt+T today, Alt+E export, Alt+P print (the Day Book itself).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { VoucherListInput } from '../../../shared/types/vouchers.ts';
import { ReportScreen, useApiQuery, useFeatures, usePeriod, useWorkingDate } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Button, DateInput, DropdownMenu, EmptyState, Inline, NO_KEY, TextInput, useDebouncedValue } from '../../ui/index.ts';
import type { MenuEntry } from '../../ui/index.ts';
import {
  baseTypesOf,
  DAYBOOK_CHIPS,
  dayBookDates,
  dayBookEmpty,
  dayBookExportRows,
  dayBookExportTotals,
  isWholePeriod,
  SEARCH_MAX,
  searchText,
  toDayBookRow,
  toggleChip,
  typesLabel,
  voucherCount,
} from './lib/daybook.ts';
import { useVoucherTable, VoucherTable } from './VoucherTable.tsx';

const LIMIT = 1000;

export function DayBookScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const working = useWorkingDate();
  const period = usePeriod();
  const features = useFeatures();
  const [range, setRange] = useState(() => ({ from: params.from ?? working.date, to: params.to ?? params.from ?? working.date, custom: params.from !== undefined }));
  // From – To asked for (Alt+F2 / Date range…), or shown once the range spanned several days: it stays
  // until Alt+T, so narrowing a range to one day never removes the To field that has the focus.
  const [rangeMode, setRangeMode] = useState(false);
  useEffect(() => {
    if (range.from !== range.to) setRangeMode(true);
  }, [range.from, range.to]);
  // Follow the working date (F2) until the user picks a range here.
  useEffect(() => {
    if (!range.custom) setRange({ from: working.date, to: working.date, custom: false });
  }, [working.date, range.custom]);
  const [chips, setChips] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
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
  const types = typesLabel(chips, visibleChips);
  const dates = dayBookDates(range, rangeMode);
  const whole = isWholePeriod(range, period);
  const setFrom = (d: string | null) => d && setRange((r) => ({ from: d, to: dates === 'single' ? d : r.to < d ? d : r.to, custom: true }));
  const setTo = (d: string | null) => d && setRange((r) => ({ from: r.from > d ? d : r.from, to: d, custom: true }));
  const today = () => {
    setRangeMode(false);
    setRange({ from: working.date, to: working.date, custom: false });
  };
  // Focus after the frame: chosen from More ▾, the closing menu first returns the focus to its button.
  const askRange = () => {
    setRangeMode(true);
    requestAnimationFrame(() => document.getElementById('vch-db-from')?.focus());
  };
  const focusSearch = () => requestAnimationFrame(() => searchRef.current?.focus());
  const wholePeriod = () => setRange({ from: period.from, to: period.to, custom: true });
  const total = q.data?.total ?? 0;
  const filtered = !!debounced || chips.length > 0;
  const empty = dayBookEmpty({ filtered, range, wholePeriod: whole });

  const typeItems: MenuEntry[] = [
    { key: 'all', label: 'All vouchers', checked: chips.length === 0, keepOpen: true, onSelect: () => setChips([]) },
    { type: 'separator', key: 'sep' },
    ...visibleChips.map((c) => ({ key: c.id, label: c.label, checked: chips.includes(c.id), keepOpen: true, onSelect: () => setChips((s) => toggleChip(s, c.id)) })),
  ];

  const actions: ScreenActionItem[] = [
    { key: NO_KEY, label: 'Show optional vouchers', onClick: () => setIncludeOptional((v) => !v), group: 'view', checked: includeOptional },
    { key: NO_KEY, label: 'Show cancelled vouchers', onClick: () => setIncludeCancelled((v) => !v), group: 'view', checked: includeCancelled },
    { key: NO_KEY, label: `Whole period (${formatDate(period.from, 'D-MMM-YY')} – ${formatDate(period.to, 'D-MMM-YY')})`, onClick: whole ? today : wholePeriod, group: 'view', checked: whole },
    { key: NO_KEY, label: 'Date range…', onClick: askRange, group: 'view' },
    ...table.actions,
    { key: 'Alt+T', label: 'Today', icon: 'clock', onClick: today, group: 'period' },
    { key: 'Alt+F2', label: 'Period', icon: 'calendar', onClick: askRange, group: 'period' },
    { key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: focusSearch, group: 'view' },
  ];

  return (
    <ReportScreen
      title="Day Book"
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+Enter View · Ctrl+P Print Voucher · Alt+F2 Period · Alt+T Today · Ctrl+F Search · Alt+D Delete · Alt+2 Duplicate · Alt+E Export"
      actions={actions}
      exportDef={() => ({
        title: 'Day Book',
        subtitle: chips.length > 0 ? visibleChips.filter((c) => chips.includes(c.id)).map((c) => c.label).join(', ') : 'All vouchers',
        period: { from: input.from, to: input.to },
        columns: [{ header: 'Date', kind: 'date' }, { header: 'Particulars' }, { header: 'Vch Type' }, { header: 'Vch No.' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }],
        rows: dayBookExportRows(rows),
        totals: rows.length > 0 ? dayBookExportTotals(rows) : undefined,
      })}
      context={
        <Inline gap={1} wrap={false} className="bx-vch-db__dates">
          <DateInput id="vch-db-from" aria-label={dates === 'single' ? 'Date' : 'From date'} size="sm" quiet value={range.from} referenceDate={working.date} onChange={setFrom} />
          {dates === 'range' ? (
            <>
              <span aria-hidden="true">–</span>
              <DateInput id="vch-db-to" aria-label="To date" size="sm" quiet value={range.to} referenceDate={working.date} minDate={range.from} onChange={setTo} />
            </>
          ) : null}
        </Inline>
      }
      filters={
        <>
          <DropdownMenu items={typeItems} label={types} variant="ghost" size="sm" aria-label={`Voucher types: ${types}`} />
          <TextInput
            ref={searchRef}
            size="sm"
            leadingIcon="search"
            aria-label="Search vouchers"
            title="Search · Ctrl+F"
            aria-keyshortcuts="Control+F"
            placeholder="Number, party, narration or amount"
            maxLength={SEARCH_MAX}
            value={search}
            onValueChange={setSearch}
          />
        </>
      }
      // The count; an empty Day Book says so once, in the empty line.
      stat={total > 0 ? <span className="bx-muted">{voucherCount(total)}</span> : undefined}
      footer={total > rows.length ? <p className="bx-muted">Showing the first {rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} vouchers — choose a shorter period or a voucher type.</p> : undefined}
    >
      <VoucherTable
        label="Day Book"
        rows={rows}
        state={table}
        loading={q.loading}
        empty={
          <EmptyState
            title={empty.title}
            action={
              empty.link === 'clear' ? (
                <Button
                  onClick={() => {
                    setSearch('');
                    setChips([]);
                  }}
                >
                  Clear the filters
                </Button>
              ) : empty.link === 'whole' ? (
                <Button onClick={wholePeriod}>Show the whole period</Button>
              ) : undefined
            }
          />
        }
      />
    </ReportScreen>
  );
}

/**
 * 'vouchers.list' — generic voucher register for drill-downs from other modules.
 *
 *   nav.push('vouchers.list', { partyLedgerId: 12, title: 'Sharma & Sons' })
 *   nav.push('vouchers.list', { ledgerId: 5, from: '2026-04-01', to: '2026-09-30' })
 *   nav.push('vouchers.list', { baseTypes: ['sales'], title: 'Sales register' })
 *
 * Params (all optional): from, to (default: the current period), voucherTypeIds, baseTypes,
 * partyLedgerId, ledgerId, search, includeOptional, includeCancelled, onlyPostDated, title.
 *
 * 2.1: the Day Book's toolbar pattern — one search (Ctrl+F) left, the count right; Print and Export in
 * the title row, the row actions in More ▾.
 */
import { useMemo, useRef, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { VoucherListInput } from '../../../shared/types/vouchers.ts';
import { ReportScreen, useApiQuery, usePeriod } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Button, EmptyState, TextInput, useDebouncedValue } from '../../ui/index.ts';
import { dayBookExportRows, dayBookExportTotals, SEARCH_MAX, searchText, toDayBookRow, voucherCount } from './lib/daybook.ts';
import { useVoucherTable, VoucherTable } from './VoucherTable.tsx';

export interface VoucherListParams {
  from?: string;
  to?: string;
  voucherTypeIds?: number[];
  baseTypes?: VoucherBaseType[];
  partyLedgerId?: number;
  ledgerId?: number;
  search?: string;
  includeOptional?: boolean;
  includeCancelled?: boolean;
  onlyPostDated?: boolean;
  /** Heading, e.g. the party or ledger name. */
  title?: string;
}

const LIMIT = 1000;

export function VoucherListScreen({ params }: ScreenProps<VoucherListParams>) {
  const period = usePeriod();
  const from = params.from ?? period.from;
  const to = params.to ?? period.to;
  const [search, setSearch] = useState(params.search ?? '');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const debounced = useDebouncedValue(searchText(search), 250);
  const input = useMemo<VoucherListInput>(() => {
    const i: VoucherListInput = { from, to, limit: LIMIT, sort: 'date_asc' };
    if (params.voucherTypeIds?.length) i.voucherTypeIds = params.voucherTypeIds;
    if (params.baseTypes?.length) i.baseTypes = params.baseTypes;
    if (params.partyLedgerId !== undefined) i.partyLedgerId = params.partyLedgerId;
    if (params.ledgerId !== undefined) i.ledgerId = params.ledgerId;
    if (params.includeOptional !== undefined) i.includeOptional = params.includeOptional;
    if (params.includeCancelled !== undefined) i.includeCancelled = params.includeCancelled;
    if (params.onlyPostDated) i.onlyPostDated = true;
    if (debounced) i.search = debounced;
    return i;
  }, [from, to, params, debounced]);
  const q = useApiQuery('vouchers.list', input, { keepPrevious: true });
  const rows = useMemo(() => (q.data?.rows ?? []).map(toDayBookRow), [q.data]);
  const table = useVoucherTable(rows);
  const title = params.title ? `Vouchers — ${params.title}` : params.onlyPostDated ? 'Post-dated Vouchers' : 'Vouchers';
  const total = q.data?.total ?? 0;
  // Focus after the frame: chosen from More ▾, the closing menu first returns the focus to its button.
  const focusSearch = () => requestAnimationFrame(() => searchRef.current?.focus());
  const actions: ScreenActionItem[] = [...table.actions, { key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: focusSearch, group: 'view' }];
  return (
    <ReportScreen
      title={title}
      period={{ from, to }}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      actions={actions}
      hint="Enter Alter · Alt+Enter View · Ctrl+P Print Voucher · Ctrl+F Search · Alt+D Delete · Alt+2 Duplicate · Alt+E Export · Esc Back"
      exportDef={() => ({
        title,
        period: { from, to },
        columns: [{ header: 'Date', kind: 'date' }, { header: 'Particulars' }, { header: 'Vch Type' }, { header: 'Vch No.' }, { header: 'Debit', kind: 'amount' }, { header: 'Credit', kind: 'amount' }],
        rows: dayBookExportRows(rows),
        totals: rows.length > 0 ? dayBookExportTotals(rows) : undefined,
      })}
      filters={
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
      }
      stat={total > 0 ? <span className="bx-muted">{voucherCount(total)}</span> : undefined}
      footer={total > rows.length ? <p className="bx-muted">Showing the first {rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} vouchers — narrow the period or search.</p> : undefined}
    >
      <VoucherTable
        label={title}
        rows={rows}
        state={table}
        loading={q.loading}
        empty={<EmptyState title={debounced ? 'No vouchers match' : 'No vouchers in this period'} action={debounced ? <Button onClick={() => setSearch('')}>Clear the search</Button> : undefined} />}
      />
    </ReportScreen>
  );
}

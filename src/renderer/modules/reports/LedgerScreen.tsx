/**
 * 'reports.ledger' {ledgerId, from?, to?} — Tally Ledger Vouchers: opening balance, one line per
 * voucher (particulars = the other ledger or "(as per details)"), running balance, current total and
 * closing balance. Alt+L (or the picker) switches ledger, Alt+F1 adds narration and reference
 * columns, Alt+M opens the monthly summary, Enter opens the voucher and Alt+A alters it.
 */
import { useMemo, useRef, useState } from 'react';
import type { LedgerPickerRow } from '../../../shared/types/accounts.ts';
import type { LedgerReportRow } from '../../../shared/types/reports.ts';
import { ReportScreen, formatDrCr, useApiQuery, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, DataTable, EmptyState, Field, Inline, Picker, Stack } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { useDrill, useReportPeriod } from './components.tsx';
import { voucherTarget } from './lib/model.ts';

export interface LedgerParams {
  ledgerId?: number;
  from?: string;
  to?: string;
}

export function LedgerScreen({ params }: ScreenProps<LedgerParams>) {
  const nav = useNav();
  const drill = useDrill();
  const p = useReportPeriod(params);
  const [ledgerId, setLedgerId] = useState<number | null>(typeof params?.ledgerId === 'number' ? params.ledgerId : null);
  const [detailed, setDetailed] = useState(false);
  const [cursor, setCursor] = useState<LedgerReportRow | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const ledgers = useApiQuery('accounts.ledger.picker', { includeInactive: true }, { staleTime: 60_000 });
  const q = useApiQuery('reports.ledger', { ledgerId: ledgerId ?? 0, from: p.from, to: p.to }, { keepPrevious: true, enabled: ledgerId !== null });
  const d = ledgerId !== null ? q.data : undefined;
  const items = useMemo(() => ledgers.data ?? [], [ledgers.data]);
  const selected = items.find((l) => l.id === ledgerId) ?? null;

  const columns = useMemo<Column<LedgerReportRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'particulars', header: 'Particulars', minWidth: 220 },
      { key: 'narration', header: 'Narration', minWidth: 200, hidden: !detailed },
      { key: 'referenceNo', header: 'Ref. No.', width: 120, hidden: !detailed },
      {
        key: 'voucherType',
        header: 'Vch Type',
        width: 140,
        render: (r) =>
          r.isPostDated ? (
            <Inline gap={1} wrap={false}>
              <span className="bx-truncate">{r.voucherType}</span>
              <Badge size="sm" tone="info">
                Post-dated
              </Badge>
            </Inline>
          ) : (
            r.voucherType
          ),
      },
      { key: 'number', header: 'Vch No.', width: 110 },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 140, blankZero: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 140, blankZero: true },
      { key: 'balance', header: 'Balance', kind: 'drcr', width: 160 },
    ],
    [detailed],
  );
  const footer: FooterRow[] = d
    ? [
        { key: 'opening', tone: 'subtle', cells: { particulars: 'Opening Balance', balance: d.opening } },
        { key: 'current', tone: 'subtle', cells: { particulars: 'Current Total', debit: d.totals.debit, credit: d.totals.credit } },
        { key: 'closing', tone: 'total', cells: { particulars: 'Closing Balance', balance: d.closing } },
      ]
    : [];

  const actions: ScreenActionItem[] = [
    { key: 'Alt+L', label: 'Change ledger', icon: 'ledger', onClick: () => pickerRef.current?.focus(), group: 'ledger' },
    { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', icon: 'layers', onClick: () => setDetailed(!detailed), group: 'view' },
    { key: 'Alt+M', label: 'Monthly summary', icon: 'calendar', onClick: () => ledgerId !== null && drill({ screen: 'reports.monthlySummary', params: { ledgerId, from: p.from, to: p.to } }), disabled: ledgerId === null, group: 'view' },
    { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', onClick: () => cursor && drill(voucherTarget(cursor.voucherId, cursor.baseType, true)), disabled: !cursor, group: 'voucher' },
    { key: 'Alt+R', label: 'Ledger master', icon: 'edit', onClick: () => ledgerId !== null && nav.push('accounts.ledger.form', { id: ledgerId }), disabled: ledgerId === null, group: 'ledger' },
  ];

  const title = d ? d.ledger.name : 'Ledger';
  return (
    <ReportScreen
      title={title}
      subtitle={d ? `Ledger · ${d.ledger.groupName}${d.ledger.isActive ? '' : ' · inactive'}` : 'Ledger Vouchers'}
      period={p.period}
      loading={ledgerId !== null && q.loading}
      refreshing={q.refreshing}
      error={ledgerId !== null ? q.error : null}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Open voucher · Alt+A Alter · Alt+L Change ledger · Alt+F1 Narration · Alt+M Monthly"
      filters={
        <Field label="Ledger" layout="inline" labelWidth={64}>
          <Picker<LedgerPickerRow>
            ref={pickerRef}
            aria-label="Ledger"
            items={items}
            getKey={(l) => String(l.id)}
            getLabel={(l) => l.name}
            getAlias={(l) => l.alias}
            getKeywords={(l) => [l.groupName, l.gstin ?? '']}
            groupBy={(l) => l.groupName}
            rightMeta={(l) => formatDrCr(l.balance)}
            value={selected}
            onChange={(l) => l && setLedgerId(l.id)}
            clearable={false}
            placeholder={ledgers.loading ? 'Loading ledgers…' : 'Type a ledger name'}
            disabled={ledgers.loading && items.length === 0}
            listMinWidth={360}
            autoFocus={ledgerId === null}
          />
        </Field>
      }
      exportDef={() => ({
        subtitle: d ? `${d.ledger.name} (${d.ledger.groupName})` : undefined,
        columns: [
          { header: 'Date', kind: 'date' },
          { header: 'Particulars' },
          ...(detailed ? [{ header: 'Narration' }, { header: 'Ref. No.' }] : []),
          { header: 'Vch Type' },
          { header: 'Vch No.' },
          { header: 'Debit', kind: 'amount' as const },
          { header: 'Credit', kind: 'amount' as const },
          { header: 'Balance', kind: 'drcr' as const },
        ],
        rows: d
          ? [
              ['', 'Opening Balance', ...(detailed ? ['', ''] : []), '', '', null, null, d.opening],
              ...d.rows.map((r) => [r.date, r.particulars, ...(detailed ? [r.narration ?? '', r.referenceNo ?? ''] : []), r.voucherType, r.number ?? '', r.debit || null, r.credit || null, r.balance]),
            ]
          : [],
        totals: d ? ['', 'Closing Balance', ...(detailed ? ['', ''] : []), '', '', d.totals.debit, d.totals.credit, d.closing] : undefined,
        landscape: detailed,
      })}
    >
      {ledgerId === null ? (
        <EmptyState icon="ledger" title="Choose a ledger" body="Type a ledger name above, or open one from the Trial Balance or a group summary." />
      ) : (
        <Stack gap={2} grow>
          <DataTable<LedgerReportRow>
            aria-label={`Ledger vouchers of ${title}`}
            className="bx-rep-fill"
            columns={columns}
            rows={d?.rows ?? []}
            getRowKey={(r) => String(r.voucherId)}
            onRowActivate={(r) => drill(voucherTarget(r.voucherId, r.baseType))}
            onSelect={(_k, r) => setCursor(r)}
            footerRows={footer}
            loading={q.loading}
            typeToJump={(r) => r.particulars}
            empty={<EmptyState icon="receipt" title="No vouchers for this ledger in the period" body="The opening and closing balances are shown below. Change the period with Alt+F2." />}
            autoFocus={ledgerId !== null}
          />
          {d?.truncated ? (
            <p className="bx-rep-note">
              Showing the first {d.rows.length.toLocaleString('en-IN')} of {d.count.toLocaleString('en-IN')} vouchers; totals and the closing balance include all of them.
            </p>
          ) : null}
        </Stack>
      )}
    </ReportScreen>
  );
}

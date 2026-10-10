/**
 * 'outstanding.party' { ledgerId } — "Ledger Outstandings": the party's pending bills, each
 * expandable (→ / +) into its history (new / against / advance lines; Enter opens the voucher), and
 * the On Account entries. Actions: Statement of Account, Interest, Reminder letter, Ledger.
 * As on = the period's end date (Alt+F2). Amounts are ledger-signed (Dr / Cr).
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../shared/format.ts';
import type { OnAccountLine } from '../../../shared/types/outstanding.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenActionItem } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Badge, Banner, DataTable, EmptyState, Grid, Inline, KpiCard, SegmentedControl, Switch } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { OverdueBadge, VGap } from './components.tsx';
import { partyEmptyBody, partyTreeRows, refTypeLabel } from './lib/model.ts';
import { useForexContext } from '../forex/hooks.ts';
import type { PartyTreeRow } from './lib/model.ts';

type Section = 'bills' | 'onAccount';

const ON_ACCOUNT_KIND: Readonly<Record<OnAccountLine['kind'], string>> = {
  opening: 'Opening balance',
  on_account: 'On account',
  unallocated: 'Not allocated',
};

const overdueCaption = (n: number): string => (n === 0 ? 'Nothing overdue' : `${n} overdue ${n === 1 ? 'bill' : 'bills'}`);

export function PartyScreen({ params }: ScreenProps<{ ledgerId: number }>) {
  const nav = useNav();
  const { to: asOf } = usePeriod();
  const ledgerId = Number(params?.ledgerId);
  const [includeSettled, setIncludeSettled] = useState(false);
  const [fifo, setFifo] = useState(true);
  const [section, setSection] = useState<Section>('bills');
  const q = useApiQuery(
    'outstanding.ledgerBills',
    { ledgerId, asOf, includeSettled: includeSettled || undefined, nonBillWise: fifo ? 'fifo' : 'on_account' },
    { keepPrevious: true, enabled: Number.isSafeInteger(ledgerId) && ledgerId > 0 },
  );
  const d = q.data;
  // (forex group) A party kept in a foreign currency: Alt+Y shows its bills in that currency too.
  const fxCurrency = useForexContext().currencyOfLedger(ledgerId);
  const rows = useMemo(() => (d ? partyTreeRows(d) : []), [d]);
  const onAccountRows = d?.onAccount.lines ?? [];

  const billColumns = useMemo<Column<PartyTreeRow>[]>(
    () => [
      {
        key: 'label',
        header: 'Bill / entry',
        tree: true,
        minWidth: 220,
        render: (r) =>
          r.isBill && r.refType && r.refType !== 'new' ? (
            <Inline gap={1} wrap={false}>
              <span className="bx-truncate">{r.label}</span>
              <Badge size="sm" tone={r.refType === 'advance' ? 'info' : 'neutral'}>
                {refTypeLabel(r.refType)}
              </Badge>
            </Inline>
          ) : (
            r.label
          ),
      },
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'voucher', header: 'Voucher', width: 180, value: (r) => (r.isBill ? '' : [r.voucherType, r.voucherNumber].filter(Boolean).join(' ')) },
      { key: 'dueDate', header: 'Due date', kind: 'date', width: 110 },
      { key: 'overdueDays', header: 'Overdue', width: 110, align: 'right', render: (r) => (r.isBill ? <OverdueBadge days={r.overdueDays} notDueText={r.dueDate ? 'Not due' : ''} /> : null) },
      { key: 'amount', header: 'Amount', kind: 'drcr', width: 150 },
      { key: 'pending', header: 'Pending', kind: 'drcr', width: 150 },
    ],
    [],
  );

  const onAccountColumns = useMemo<Column<OnAccountLine>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'kind', header: 'Type', width: 140, value: (r) => ON_ACCOUNT_KIND[r.kind] },
      { key: 'voucher', header: 'Voucher', width: 180, value: (r) => [r.voucherType, r.voucherNumber].filter(Boolean).join(' ') },
      { key: 'narration', header: 'Narration', minWidth: 160 },
      { key: 'amount', header: 'Amount', kind: 'drcr', width: 150, total: true },
    ],
    [],
  );

  const footerRows: FooterRow[] = d
    ? [
        { key: 'bills', tone: 'subtle', cells: { label: 'Bills pending', pending: d.totals.billsPending } },
        ...(d.totals.advance !== 0 ? [{ key: 'advance', tone: 'subtle' as const, cells: { label: 'Advances', pending: d.totals.advance } }] : []),
        ...(d.totals.onAccount !== 0 ? [{ key: 'onAccount', tone: 'subtle' as const, cells: { label: 'On account', pending: d.totals.onAccount } }] : []),
        { key: 'balance', tone: 'total', cells: { label: `Balance as on ${formatDate(asOf)}`, pending: d.balance } },
      ]
    : [];

  const isReceivable = d?.ledger.side === 'receivable';
  // On Account entries are listed for bill-wise ledgers only (see partyEmptyBody).
  const billWise = d?.ledger.billWise ?? true;
  const shown: Section = billWise ? section : 'bills';
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Bills', onClick: () => setSection('bills'), group: 'view', disabled: shown === 'bills' },
    { key: 'Ctrl+2', label: 'On account entries', onClick: () => setSection('onAccount'), group: 'view', disabled: section === 'onAccount' || !billWise },
    // Alt+F1 (detailed / condensed): settled bills are the detailed view. Alt+H is reserved for edit
    // history in every module (CONVENTION_SHORTCUTS); the TDS reports toggle settled lines the same way.
    { key: 'Alt+F1', label: includeSettled ? 'Hide settled bills' : 'Show settled bills', icon: 'eye', onClick: () => setIncludeSettled((x) => !x), group: 'view' },
    {
      key: 'Alt+N',
      label: fifo ? 'Show as one On Account line' : 'Break down FIFO',
      onClick: () => setFifo((x) => !x),
      hidden: !d || d.ledger.billWise,
      group: 'view',
    },
    { key: 'Alt+S', label: 'Statement of Account', icon: 'file', onClick: () => nav.push('outstanding.statement', { ledgerId }), group: 'party', primary: true },
    { key: 'Alt+I', label: 'Interest', icon: 'percent', onClick: () => nav.push('outstanding.interest', { ledgerId }), group: 'party' },
    { key: 'Alt+R', label: 'Reminder letter', icon: 'mail', onClick: () => nav.push('outstanding.reminders', { ledgerId }), hidden: !isReceivable, group: 'party' },
    { key: 'Alt+L', label: 'Ledger', icon: 'ledger', onClick: () => nav.push('reports.ledger', { ledgerId }), group: 'party' },
    { key: 'Alt+Y', label: `Bills in ${fxCurrency?.isoCode ?? fxCurrency?.symbol ?? 'currency'}`, icon: 'rupee', hidden: !fxCurrency, onClick: () => nav.push('forex.outstanding', { ledgerId }), group: 'party' },
  ];

  const exportDef = () => ({
    subtitle: d ? `${d.ledger.name} — ${d.ledger.groupName}` : undefined,
    columns: [
      { header: 'Bill no.' },
      { header: 'Bill date', kind: 'date' as const },
      { header: 'Due date', kind: 'date' as const },
      { header: 'Overdue (days)', kind: 'number' as const },
      { header: 'Bill amount', kind: 'drcr' as const },
      { header: 'Pending', kind: 'drcr' as const },
    ],
    rows: [
      ...(d?.bills ?? []).map((b) => [b.billName, b.billDate, b.dueDate, b.overdueDays || null, b.originalAmount, b.pendingAmount]),
      ...(d && d.onAccount.total !== 0 ? [['On Account', null, null, null, null, d.onAccount.total]] : []),
    ],
    totals: ['Balance', null, null, null, null, d?.balance ?? 0],
  });

  const title = d?.ledger.name ?? 'Party Outstanding';
  const limitUsed = d && d.ledger.creditLimit && d.balance * (d.ledger.side === 'payable' ? -1 : 1) > 0 ? Math.round((Math.abs(d.balance) / d.ledger.creditLimit) * 100) : null;

  return (
    <ReportScreen
      title={title}
      subtitle={d ? `${d.ledger.groupName}${d.method === 'fifo' ? ' · not bill-wise (FIFO)' : d.method === 'on_account' ? ' · not bill-wise' : ''}` : undefined}
      periodMode="asOn"
      exportDef={exportDef}
      loading={q.loading && !d}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      actions={actions}
      hint="→ / + Show history · Enter Open voucher · Alt+S Statement · Alt+R Reminder · Esc Back"
      filters={
        <Inline gap={3}>
          <SegmentedControl<Section>
            aria-label="Section"
            size="sm"
            value={shown}
            onChange={setSection}
            options={[
              { value: 'bills', label: `Bills${d ? ` (${d.bills.length})` : ''}` },
              { value: 'onAccount', label: `On account${d ? ` (${d.onAccount.lines.length})` : ''}`, disabled: !!d && !d.ledger.billWise },
            ]}
          />
          <Switch size="sm" checked={includeSettled} onChange={setIncludeSettled} label="Show settled bills" showState={false} />
        </Inline>
      }
    >
      {d ? (
        <>
          <Grid minItemWidth={170} gap={3}>
            <KpiCard label="Balance" value={formatDrCr(d.balance, { keepZero: true })} icon="rupee" caption={d.ledger.side === 'receivable' ? 'Receivable' : d.ledger.side === 'payable' ? 'Payable' : 'Settled'} />
            <KpiCard label="Overdue" value={formatDrCr(d.totals.overdue, { keepZero: true })} icon="clock" caption={overdueCaption(d.bills.filter((b) => b.overdueDays > 0).length)} />
            <KpiCard
              label="Advances & on account"
              value={formatDrCr(d.totals.advance + d.totals.onAccount, { keepZero: true })}
              icon="wallet"
              caption={d.totals.advance + d.totals.onAccount === 0 ? 'Nothing unadjusted' : 'Not yet adjusted against bills'}
            />
            <KpiCard
              label="Credit terms"
              value={d.ledger.creditDays !== null ? `${d.ledger.creditDays} days` : '—'}
              icon="calendar"
              caption={d.ledger.creditLimit ? `Limit ${formatMoney(d.ledger.creditLimit, { symbol: true })}${limitUsed !== null ? ` · ${limitUsed}% used` : ''}` : 'No credit limit'}
            />
          </Grid>
          <VGap />
          {d.method !== 'bill_wise' ? (
            <>
              <Banner tone="info" inline title="Not maintained bill-wise">
                {d.method === 'fifo'
                  ? 'The balance is matched first-in-first-out: receipts and payments settle the oldest entries first, so the open items below are the latest ones. Alt+N shows the balance as one line.'
                  : 'The balance is shown as one On Account amount. Alt+N breaks it down FIFO by the latest entries.'}
              </Banner>
              <VGap />
            </>
          ) : null}
          {shown === 'bills' ? (
            <DataTable<PartyTreeRow>
              aria-label={`Pending bills of ${d.ledger.name}`}
              autoFocus
              columns={billColumns}
              rows={rows}
              getRowKey={(r) => r.key}
              getRowLevel={(r) => r.level}
              isGroupRow={(r) => r.isBill}
              expandable
              defaultExpanded="none"
              footerRows={footerRows}
              onRowActivate={(r) => {
                if (r.voucherId !== null) nav.push('vouchers.view', { id: r.voucherId });
              }}
              typeToJump={(r) => r.label}
              empty={
                <EmptyState
                  icon="check-circle"
                  title={`No pending bills as on ${formatDate(asOf)}`}
                  body={partyEmptyBody(d, includeSettled)}
                />
              }
            />
          ) : (
            <DataTable<OnAccountLine>
              aria-label={`On account entries of ${d.ledger.name}`}
              autoFocus
              columns={onAccountColumns}
              rows={onAccountRows}
              getRowKey={(r, i) => `${i}|${r.voucherId ?? 'o'}|${r.kind}`}
              onRowActivate={(r) => {
                if (r.voucherId !== null) nav.push('vouchers.view', { id: r.voucherId });
              }}
              empty={<EmptyState icon="check-circle" title="Nothing on account" body="Every receipt and payment is allocated to a bill." />}
            />
          )}
        </>
      ) : (
        <EmptyState icon="alert" title="No party selected" body="Open a party from Receivables or Payables." />
      )}
    </ReportScreen>
  );
}

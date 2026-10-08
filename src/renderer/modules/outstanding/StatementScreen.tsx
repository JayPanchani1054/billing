/**
 * 'outstanding.statement' { ledgerId?, from?, to? } — printable statement of account: party details,
 * opening balance, every voucher with running balance, closing balance, and the pending bills aged
 * as on the end date. Print (Alt+P) and PDF use a dedicated A4 layout (lib/printHtml.ts, every value
 * HTML-escaped); Excel/CSV export the transactions. Without a ledgerId, pick the party first.
 */
import { useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../shared/format.ts';
import type { StatementBillRow, StatementLine } from '../../../shared/types/outstanding.ts';
import { exportTable, showInFolder } from '../../app/export.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenActionItem } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ExportDialog, ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import { Card, DataTable, EmptyState, Grid, Inline, KeyValueList, SegmentedControl, useToast } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { OverdueBadge, PartyPicker, VGap, printedOn, useDocumentOutput, usePartyOptions } from './components.tsx';
import { refTypeLabel, statementExport } from './lib/model.ts';
import { buildStatementHtml, pdfName } from './lib/printHtml.ts';

export interface StatementParams {
  ledgerId?: number;
  from?: string;
  to?: string;
}

type Section = 'transactions' | 'bills';

export function StatementScreen({ params }: ScreenProps<StatementParams>) {
  const nav = useNav();
  const toast = useToast();
  const global = usePeriod();
  const p = params ?? {};
  const fixedPeriod = p.from && p.to ? { from: p.from, to: p.to } : undefined;
  const period = fixedPeriod ?? global.period;
  const [ledgerId, setLedgerId] = useState<number | null>(typeof p.ledgerId === 'number' ? p.ledgerId : null);
  const [section, setSection] = useState<Section>('transactions');
  const [exportOpen, setExportOpen] = useState(false);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const parties = usePartyOptions(period.to);
  const out = useDocumentOutput();

  const q = useApiQuery('outstanding.statement', { ledgerId: ledgerId ?? 0, from: period.from, to: period.to }, { enabled: ledgerId !== null, keepPrevious: true });
  const s = q.data && q.data.party.ledgerId === ledgerId ? q.data : undefined;

  const txColumns = useMemo<Column<StatementLine>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      {
        key: 'particulars',
        header: 'Particulars',
        minWidth: 200,
        title: (r) => (r.narration ? `${r.particulars} — ${r.narration}` : r.particulars),
      },
      { key: 'voucherType', header: 'Vch type', width: 130 },
      { key: 'voucherNumber', header: 'Vch no.', width: 120 },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 140, blankZero: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 140, blankZero: true },
      { key: 'balance', header: 'Balance', kind: 'drcr', width: 160 },
    ],
    [],
  );

  const bucketLabels = s?.pendingBills.buckets.map((b) => b.label) ?? [];
  const billColumns = useMemo<Column<StatementBillRow>[]>(
    () => [
      { key: 'billName', header: 'Bill no.', minWidth: 140, render: (r) => (r.refType === 'new' ? r.billName : `${r.billName} (${refTypeLabel(r.refType)})`) },
      { key: 'billDate', header: 'Bill date', kind: 'date', width: 110 },
      { key: 'dueDate', header: 'Due date', kind: 'date', width: 110 },
      { key: 'overdueDays', header: 'Overdue', width: 110, align: 'right', render: (r) => <OverdueBadge days={r.overdueDays} notDueText={r.dueDate ? 'Not due' : ''} /> },
      { key: 'bucket', header: 'Age', width: 120, value: (r) => (r.bucketIndex === null ? '' : (bucketLabels[r.bucketIndex] ?? '')) },
      { key: 'pendingAmount', header: 'Pending', kind: 'drcr', width: 160 },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bucketLabels.join('|')],
  );

  const txFooter: FooterRow[] = s
    ? [
        { key: 'opening', tone: 'subtle', cells: { particulars: `Opening balance on ${formatDate(s.from)}`, balance: s.openingBalance } },
        { key: 'total', tone: 'total', cells: { particulars: 'Current total', debit: s.totals.debit, credit: s.totals.credit } },
        { key: 'closing', tone: 'total', cells: { particulars: `Closing balance on ${formatDate(s.to)}`, balance: s.closingBalance } },
      ]
    : [];
  const billFooter: FooterRow[] = s
    ? [
        ...(s.pendingBills.advance !== 0 ? [{ key: 'adv', tone: 'subtle' as const, cells: { billName: 'Advances', pendingAmount: s.pendingBills.advance } }] : []),
        ...(s.pendingBills.onAccount !== 0 ? [{ key: 'oa', tone: 'subtle' as const, cells: { billName: 'On account', pendingAmount: s.pendingBills.onAccount } }] : []),
        { key: 'total', tone: 'total', cells: { billName: 'Total outstanding', pendingAmount: s.pendingBills.total } },
      ]
    : [];

  const html = (): string | null => (s ? buildStatementHtml(s, { printedOn: printedOn() }) : null);
  const exportAs = async (format: 'xlsx' | 'csv' | 'pdf'): Promise<void> => {
    setExportOpen(false);
    if (!s) return;
    if (format === 'pdf') {
      await out.pdf(buildStatementHtml(s, { printedOn: printedOn() }), pdfName('Statement', s.party.name, s.from, s.to));
      return;
    }
    try {
      const r = await exportTable({ title: 'Statement of Account', company: s.company.mailingName || s.company.name, period: { from: s.from, to: s.to }, ...statementExport(s) }, format);
      if (r) {
        const name = r.path.split(/[\\/]/).pop() ?? r.path;
        toast.success(r.fellBackToCsv ? `Saved as CSV: ${name}` : `Saved ${name}`, { action: { label: 'Show in folder', onClick: () => showInFolder(r.path) } });
      }
    } catch (err) {
      toast.error('Could not export', { message: userMessage(err) });
    }
  };

  const actions: ScreenActionItem[] = [
    { key: 'Alt+N', label: 'Change party', icon: 'user', onClick: () => pickerRef.current?.focus(), group: 'party' },
    { key: 'Ctrl+1', label: 'Transactions', onClick: () => setSection('transactions'), group: 'view', disabled: section === 'transactions' },
    { key: 'Ctrl+2', label: 'Pending bills', onClick: () => setSection('bills'), group: 'view', disabled: section === 'bills' },
    { key: 'Alt+O', label: 'Party outstanding', icon: 'list', onClick: () => ledgerId !== null && nav.push('outstanding.party', { ledgerId }), disabled: ledgerId === null, group: 'party' },
    { key: 'Alt+L', label: 'Ledger', icon: 'ledger', onClick: () => ledgerId !== null && nav.push('reports.ledger', { ledgerId, from: period.from, to: period.to }), disabled: ledgerId === null, group: 'party' },
    { key: 'Alt+R', label: 'Reminder letter', icon: 'mail', onClick: () => ledgerId !== null && nav.push('outstanding.reminders', { ledgerId }), hidden: !s || s.closingBalance <= 0, group: 'party' },
    { key: 'Alt+E', label: 'Export', icon: 'export', onClick: () => setExportOpen(true), disabled: !s, group: 'output' },
    {
      key: 'Alt+P',
      label: 'Print',
      icon: 'print',
      onClick: () => {
        const h = html();
        if (h) void out.print(h);
      },
      disabled: !s,
      group: 'output',
      primary: true,
    },
  ];

  return (
    <>
      <ReportScreen
        title="Statement of Account"
        subtitle={s?.party.name}
        period={fixedPeriod}
        periodMode="range"
        loading={q.loading && !s && ledgerId !== null}
        refreshing={q.refreshing}
        error={q.error}
        onRetry={() => void q.refetch()}
        actions={actions}
        hint="Alt+N Party · Alt+F2 Period · Alt+P Print · Alt+E Export (PDF / Excel) · Enter Open voucher · Esc Back"
        filters={
          <Inline gap={2}>
            <div style={{ width: 300 }}>
              <PartyPicker options={parties.options} value={ledgerId} onChange={(id) => setLedgerId(id)} autoFocus={ledgerId === null} inputRef={pickerRef} placeholder="Party (customer or supplier)" />
            </div>
            <SegmentedControl<Section>
              aria-label="Section"
              size="sm"
              value={section}
              onChange={setSection}
              options={[
                { value: 'transactions', label: 'Transactions' },
                { value: 'bills', label: 'Pending bills' },
              ]}
            />
          </Inline>
        }
      >
        {!s ? (
          <EmptyState
            icon="file"
            title={ledgerId === null ? 'Choose a party' : 'Preparing the statement…'}
            body={ledgerId === null ? 'Type the customer or supplier name above (Alt+N). The statement covers the period shown at the top (Alt+F2).' : undefined}
          />
        ) : (
          <>
            <Grid columns={2} gap={3}>
              <Card title={s.party.mailingName || s.party.name} subtitle={s.party.groupName} padding="sm">
                <KeyValueList
                  items={[
                    { label: 'Address', value: [s.party.address?.replace(/\s*\n\s*/g, ', '), [s.party.stateName, s.party.pincode].filter(Boolean).join(' - ')].filter(Boolean).join(', '), hideEmpty: true },
                    { label: 'GSTIN', value: s.party.gstin ?? '', hideEmpty: true },
                    { label: 'Contact', value: [s.party.contactPerson, s.party.mobile || s.party.phone, s.party.email].filter(Boolean).join(' · '), hideEmpty: true },
                    {
                      label: 'Credit terms',
                      value: [s.party.creditDays !== null ? `${s.party.creditDays} days` : '', s.party.creditLimit !== null ? `limit ${formatMoney(s.party.creditLimit, { symbol: true })}` : ''].filter(Boolean).join(', '),
                      hideEmpty: true,
                    },
                  ]}
                />
              </Card>
              <Card title={`${formatDate(s.from)} to ${formatDate(s.to)}`} padding="sm">
                <KeyValueList
                  alignValues="right"
                  items={[
                    { label: 'Opening balance', value: formatDrCr(s.openingBalance, { keepZero: true }) },
                    { label: 'Debits', value: formatMoney(s.totals.debit) },
                    { label: 'Credits', value: formatMoney(s.totals.credit) },
                    { label: 'Closing balance', value: formatDrCr(s.closingBalance, { keepZero: true }), strong: true },
                  ]}
                />
              </Card>
            </Grid>
            <VGap />
            {section === 'transactions' ? (
              <DataTable<StatementLine>
                aria-label="Transactions"
                autoFocus
                columns={txColumns}
                rows={s.transactions}
                getRowKey={(r) => String(r.voucherId)}
                footerRows={txFooter}
                onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
                empty={<EmptyState icon="calendar" title="No transactions in this period" body="Change the period with Alt+F2." />}
              />
            ) : (
              <>
                <KeyValueList
                  layout="inline"
                  columns={3}
                  items={[
                    ...s.pendingBills.buckets.map((b, i) => ({ key: `b${i}`, label: b.label, value: formatDrCr(s.pendingBills.bucketTotals[i]) || '—' })),
                  ]}
                />
                <VGap />
                <DataTable<StatementBillRow>
                  aria-label={`Pending bills as on ${formatDate(s.to)}`}
                  autoFocus
                  columns={billColumns}
                  rows={s.pendingBills.rows}
                  getRowKey={(r, i) => `${i}|${r.billName}`}
                  footerRows={billFooter}
                  empty={<EmptyState icon="check-circle" title={`No pending bills on ${formatDate(s.to)}`} />}
                />
              </>
            )}
          </>
        )}
      </ReportScreen>
      {exportOpen ? <ExportDialog title="Statement of Account" onClose={() => setExportOpen(false)} onPick={(f) => void exportAs(f)} /> : null}
    </>
  );
}

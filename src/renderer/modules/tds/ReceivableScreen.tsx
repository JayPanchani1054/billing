/**
 * 'tds.receivable' { fyStart? } — TDS deducted by customers: the TDS Receivable ledger(s) in the books
 * per customer vs Form 26AS / AIS rows imported from a CSV (Alt+I). Matched by the customer's
 * deductor TAN (TDS details), else by name. Enter opens the customer's ledger; Alt+M its TDS details
 * (to record the TAN); Alt+R creates the 'TDS Receivable' ledger when there is none.
 */
import { useMemo, useState } from 'react';
import { formatDateTime } from '../../app/display.ts';
import type { TdsReceivableRow } from '../../../shared/types/tds.ts';
import { api } from '../../app/api.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { invalidate } from '../../app/queryClient.ts';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan, useFeatures } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import { Badge, Banner, DataTable, EmptyState, Grid, KpiCard, Select, Stack, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { openCsvFile, TdsOff } from './components.tsx';
import { fyLabel, quarterChoices, RECEIVABLE_STATUS, receivableExport } from './lib/model.ts';

export function ReceivableScreen({ params }: ScreenProps<{ fyStart?: number }>) {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canManage = useCan('tds.manage');
  const { date: workingDate } = useWorkingDate();
  const choice = quarterChoices(workingDate);
  const [fyStart, setFyStart] = useState<number>(params?.fyStart ?? choice.fyStart);
  const q = useApiQuery('tds.receivable', { fyStart }, { enabled: features.tds, keepPrevious: true });
  const d = q.data && q.data.fyStart === fyStart ? q.data : undefined;
  const rows = d?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => r.key === cursor) ?? null;
  const importer = useApiMutation('tds.26as.import', { invalidates: ['tds'] });
  const years = [...new Set([...choice.years, fyStart])].sort((a, b) => b - a);

  const columns = useMemo<Column<TdsReceivableRow>[]>(
    () => [
      { key: 'partyName', header: 'Customer / deductor', minWidth: 220, sortable: true },
      { key: 'tan', header: 'TAN', width: 120, value: (r) => r.tan ?? '' },
      { key: 'books', header: 'TDS in books', kind: 'amount', width: 140, total: true, sortable: true },
      { key: 'form26as', header: 'TDS in 26AS', kind: 'amount', width: 140, total: true, sortable: true },
      { key: 'amountPaid', header: 'Paid / credited (26AS)', kind: 'amount', width: 160, blankZero: true },
      { key: 'difference', header: 'Difference', kind: 'amount', width: 130, total: true, blankZero: true, title: () => '26AS minus books' },
      {
        key: 'status',
        header: 'Status',
        width: 120,
        value: (r) => RECEIVABLE_STATUS[r.status],
        render: (r) => (
          <Badge size="sm" tone={r.status === 'matched' ? 'success' : r.status === 'mismatch' ? 'danger' : 'warning'}>
            {RECEIVABLE_STATUS[r.status]}
          </Badge>
        ),
      },
    ],
    [],
  );

  const importCsv = async (): Promise<void> => {
    if (!canManage || importer.pending) return;
    try {
      const file = await openCsvFile('Open the Form 26AS / AIS rows (CSV)');
      if (!file) return;
      const out = await importer.mutate({ fyStart, content: file.text, replace: true });
      toast.success(`${out.imported} row(s) imported for FY ${fyLabel(fyStart)}`, {
        message: out.outsideYear > 0 ? `${out.outsideYear} row(s) dated outside the year were skipped.` : 'Earlier rows of the year were replaced.',
      });
    } catch (err) {
      toast.error('Could not import the file', { message: userMessage(err), duration: 12_000 });
    }
  };

  const createLedger = async (): Promise<void> => {
    try {
      const out = await api('tds.receivableLedger.ensure', {});
      invalidate('tds');
      invalidate('accounts');
      toast.success('TDS Receivable ledger is ready', { action: { label: 'Open', onClick: () => nav.push('accounts.ledger.form', { id: out.ledgerId }) } });
    } catch (err) {
      toast.error('Could not create the ledger', { message: userMessage(err) });
    }
  };

  if (!features.tds) return <TdsOff title="TDS Receivable" kind="tds" />;
  return (
    <ReportScreen
      title={`TDS Receivable vs Form 26AS — FY ${fyLabel(fyStart)}`}
      subtitle={d?.imported.rows ? `${d.imported.rows} 26AS row(s), imported ${d.imported.importedAt ? formatDateTime(d.imported.importedAt) : ''}` : 'No 26AS rows imported for this year yet (Alt+I)'}
      periodMode="none"
      loading={q.loading && !d}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={<Select aria-label="Financial year" size="sm" value={String(fyStart)} options={years.map((y) => ({ value: String(y), label: `FY ${fyLabel(y)}` }))} onChange={(v) => setFyStart(Number(v))} />}
      exportDef={() => (d ? receivableExport(d) : { columns: [], rows: [] })}
      actions={[
        { key: 'Alt+I', label: 'Import 26AS CSV', icon: 'upload', primary: true, hidden: !canManage, disabled: !canManage || importer.pending, onClick: () => void importCsv() },
        { key: 'Alt+M', label: 'Customer TDS details', icon: 'ledger', disabled: !current?.partyLedgerId, onClick: () => current?.partyLedgerId && nav.push('tds.ledger.form', { ledgerId: current.partyLedgerId }) },
        { key: 'Alt+R', label: 'Create TDS Receivable', icon: 'plus', hidden: !canManage || ((d?.receivableLedgers.length ?? 1) > 0), disabled: !canManage, onClick: () => void createLedger() },
      ]}
      hint="Enter Customer ledger · Alt+I Import 26AS CSV · Alt+M Customer TDS details · Alt+E Export · Esc Back"
    >
      <Stack gap={3}>
        {d && d.receivableLedgers.length === 0 ? (
          <Banner tone="info" title="No TDS Receivable ledger yet">
            Press Alt+R to create one (under Loans & Advances (Asset)). In a Receipt voucher debit it with the TDS the customer deducted: Dr Bank, Dr TDS
            Receivable, Cr Customer.
          </Banner>
        ) : null}
        {d ? (
          <Grid columns={3} gap={3}>
            <KpiCard label="TDS in books" value={d.totals.books} amount caption={d.receivableLedgers.map((l) => l.name).join(', ')} />
            <KpiCard label="TDS in Form 26AS" value={d.totals.form26as} amount />
            <KpiCard label="Difference" value={d.totals.difference} amount caption={d.totals.difference === 0 ? 'Books agree with 26AS' : 'Follow up with the customers below'} />
          </Grid>
        ) : null}
        <DataTable<TdsReceivableRow>
          aria-label="TDS receivable reconciliation"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          selectedKey={cursor}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => r.partyLedgerId && nav.push('reports.ledger', { ledgerId: r.partyLedgerId })}
          empty={<EmptyState title="Nothing to reconcile" body="No TDS receivable in the books and no 26AS rows for this year." />}
        />
        <span className="bx-muted">
          CSV columns (first row = headings): TAN of deductor, Name of deductor, Section, Transaction date, Amount paid/credited, Tax deducted. Prepare it
          from Form 26AS Part I / AIS (TRACES downloads are text or PDF whose layout changes). Dates DD-MM-YYYY or DD-Mon-YYYY.
        </span>
      </Stack>
    </ReportScreen>
  );
}

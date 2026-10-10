/**
 * Advances (GSTR-1 Table 11) and imports of goods (bills of entry), for the reporting period (Alt+F2):
 *   'gst.advances' {from?, to?, view?} — Ctrl+1 Table 11: advances received (11A) and adjusted /
 *       refunded (11B) rate- and POS-wise with the vouchers; Ctrl+2 Pending: advances not yet invoiced
 *       or refunded (as at the period end). Alt+C records a new advance (Receipt, then Alt+J GST details).
 *   'gst.boe' {from?, to?} — bills of entry recorded on import purchases (ITC in GSTR-3B 4(A)(1));
 *       Alt+O reconciles them with the IMPG / IMPGSEZ sections of a GSTR-2B JSON downloaded from the portal.
 * Enter on a row opens its voucher.
 */
import { useMemo, useState } from 'react';
import type { AdvanceVoucherRow, BoeReconResult, BoeReconRow, BoeRow, PendingAdvance, Table11Row } from '../../../shared/types/gst-plus.ts';
import { formatMoney, native, ReportScreen, useApiMutation, useApiQuery, useCan, useNav, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, DataTable, EmptyState, Grid, KpiCard, Panel, SegmentedControl, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp, useGstRange } from './components.tsx';
import { advanceKindLabel, advancesExport, boeExport, boeReconExport, BOE_STATUS_LABELS, pendingAdvancesExport } from './lib/gstplus.ts';

const money = (p: number): string => formatMoney(p);

function t11Columns(): Column<Table11Row>[] {
  return [
    { key: 'pos', header: 'Place of supply', minWidth: 180, value: (r) => `${r.pos}-${r.posName}` },
    { key: 'supplyKind', header: 'Supply', width: 90, value: (r) => (r.supplyKind === 'INTRA' ? 'Intra-state' : 'Inter-state') },
    { key: 'rate', header: 'Rate', width: 80, value: (r) => `${r.rate}%` },
    { key: 'gross', header: 'Advance (gross)', kind: 'amount', width: 140, total: true },
    { key: 'taxable', header: 'Taxable', kind: 'amount', width: 140, total: true },
    { key: 'igst', header: 'IGST', kind: 'amount', width: 120, total: true, blankZero: true },
    { key: 'cgst', header: 'CGST', kind: 'amount', width: 120, total: true, blankZero: true },
    { key: 'sgst', header: 'SGST/UTGST', kind: 'amount', width: 120, total: true, blankZero: true },
    { key: 'cess', header: 'Cess', kind: 'amount', width: 100, total: true, blankZero: true },
  ];
}

export function AdvancesScreen({ params }: ScreenProps<{ from?: string; to?: string; view?: 'table11' | 'pending' }>) {
  const nav = useNav();
  const canCreate = useCan('vouchers.create');
  const { from, to, override } = useGstRange(params);
  const [view, setView] = useState<'table11' | 'pending'>(params?.view === 'pending' ? 'pending' : 'table11');
  const reg = useApiQuery('gst.advances.register', { from, to }, { keepPrevious: true, enabled: view === 'table11' });
  const pend = useApiQuery('gst.advances.pending', { asOf: to }, { keepPrevious: true, enabled: view === 'pending' });
  const t11 = useMemo(t11Columns, []);
  const vCols = useMemo<Column<AdvanceVoucherRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      { key: 'number', header: 'Voucher no.', width: 120, value: (r) => r.number ?? '' },
      { key: 'kind', header: 'Type', width: 100, value: (r) => advanceKindLabel(r) },
      { key: 'partyName', header: 'Party', minWidth: 200, value: (r) => r.partyName ?? '' },
      { key: 'rate', header: 'Rate', width: 70, value: (r) => `${r.rate}%` },
      { key: 'gross', header: 'Gross', kind: 'amount', width: 130 },
      { key: 'taxable', header: 'Taxable', kind: 'amount', width: 130 },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 120, value: (r) => r.igst + r.cgst + r.sgst + r.cess },
    ],
    [],
  );
  const pCols = useMemo<Column<PendingAdvance>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      { key: 'number', header: 'Receipt no.', width: 120, value: (r) => r.number ?? '' },
      { key: 'partyName', header: 'Party', minWidth: 220, sortable: true, value: (r) => r.partyName ?? '' },
      { key: 'pos', header: 'POS', width: 70 },
      { key: 'rate', header: 'Rate', width: 70, value: (r) => `${r.rate}%` },
      { key: 'gross', header: 'Advance', kind: 'amount', width: 140, total: true },
      { key: 'pending', header: 'Pending', kind: 'amount', width: 140, total: true },
    ],
    [],
  );
  const q = view === 'table11' ? reg : pend;
  const a = reg.data;
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Table 11', onClick: () => setView('table11'), disabled: view === 'table11', group: 'view' },
    { key: 'Ctrl+2', label: 'Pending advances', onClick: () => setView('pending'), disabled: view === 'pending', group: 'view' },
    { key: 'Alt+C', label: 'Create advance receipt', icon: 'plus', onClick: () => nav.push('vouchers.entry', { baseType: 'receipt' }), hidden: !canCreate, group: 'edit' },
    { key: 'Alt+R', label: 'GSTR-1', icon: 'gst', onClick: () => nav.push('gst.gstr1'), group: 'go' },
  ];
  return (
    <ReportScreen
      title="Advances (GST)"
      subtitle={view === 'table11' ? 'GSTR-1 Table 11' : `Pending as on ${to}`}
      period={override}
      filters={
        <SegmentedControl
          aria-label="View"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'table11', label: 'Table 11' },
            { value: 'pending', label: 'Pending' },
          ]}
        />
      }
      actions={actions}
      exportDef={
        view === 'table11'
          ? a
            ? () => ({ ...advancesExport(a), title: 'Advances (GSTR-1 Table 11)', period: { from, to } })
            : undefined
          : pend.data
            ? () => ({ ...pendingAdvancesExport(pend.data ?? []), title: 'Pending advances', period: `As on ${to}` })
            : undefined
      }
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open voucher · Ctrl+1 Table 11 · Ctrl+2 Pending · Alt+C Create advance receipt · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-scroll">
        <GstHelp>
          Tax is payable when an advance is received for services (time of supply, s.13); advances for goods carry no tax (Notification 66/2017-CT). Mark a receipt as an
          advance with Alt+J in the receipt voucher; the invoice that bills the supply adjusts it (Table 11B).
        </GstHelp>
        {view === 'table11' && a ? (
          <>
            <Grid minItemWidth={180} gap={3}>
              <KpiCard label="Received (11A)" value={a.received.reduce((s, r) => s + r.igst + r.cgst + r.sgst + r.cess, 0)} amount caption="Tax on advances received" />
              <KpiCard label="Adjusted / refunded (11B)" value={a.adjusted.reduce((s, r) => s + r.igst + r.cgst + r.sgst + r.cess, 0)} amount caption="Tax reversed on invoicing" />
              <KpiCard label="Net in 3.1(a)" value={a.net.igst + a.net.cgst + a.net.sgst + a.net.cess} amount caption={`Taxable ${money(a.net.taxable)}`} />
            </Grid>
            <Panel title="11A · Advances received (tax liability arising)" headingLevel={2}>
              <DataTable<Table11Row> aria-label="Table 11A" columns={t11} rows={a.received} getRowKey={(r, i) => `${r.pos}:${r.rate}:${i}`} height={Math.min(300, 40 + 32 * (a.received.length + 2))} empty={<EmptyState size="sm" title="No advances received in this period" />} />
            </Panel>
            <Panel title="11B · Advances adjusted against invoices or refunded" headingLevel={2}>
              <DataTable<Table11Row> aria-label="Table 11B" columns={t11} rows={a.adjusted} getRowKey={(r, i) => `${r.pos}:${r.rate}:${i}`} height={Math.min(300, 40 + 32 * (a.adjusted.length + 2))} empty={<EmptyState size="sm" title="No advances adjusted in this period" />} />
            </Panel>
            <Panel title="Vouchers" headingLevel={2} description="Enter opens the voucher.">
              <DataTable<AdvanceVoucherRow>
                aria-label="Advance vouchers"
                autoFocus
                columns={vCols}
                rows={a.vouchers}
                getRowKey={(r, i) => `${r.voucherId}:${r.kind}:${i}`}
                onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
                height={Math.min(420, 40 + 32 * (a.vouchers.length + 2))}
                empty={<EmptyState size="sm" icon="receipt" title="No advance vouchers in this period" body="Alt+C records a receipt; mark it as an advance with Alt+J." />}
              />
            </Panel>
          </>
        ) : null}
        {view === 'pending' && pend.data ? (
          <DataTable<PendingAdvance>
            aria-label="Pending advances"
            autoFocus
            columns={pCols}
            rows={pend.data}
            getRowKey={(r) => String(r.receiptVoucherId)}
            onRowActivate={(r) => nav.push('vouchers.view', { id: r.receiptVoucherId })}
            empty={<EmptyState icon="receipt" title="No advance is pending" body="Every advance received has been invoiced or refunded." />}
          />
        ) : null}
      </div>
    </ReportScreen>
  );
}

// ───────────────────────────── Bills of entry ─────────────────────────────

export function BoeScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const nav = useNav();
  const canCreate = useCan('vouchers.create');
  const toast = useToast();
  const { from, to, override } = useGstRange(params);
  const q = useApiQuery('gst.boe.list', { from, to }, { keepPrevious: true });
  const recon = useApiMutation('gst.boe.reconcile', { invalidates: [] });
  const [result, setResult] = useState<BoeReconResult | null>(null);
  const rows = q.data ?? [];
  const cols = useMemo<Column<BoeRow>[]>(
    () => [
      { key: 'boeNo', header: 'BOE no.', width: 120, sortable: true },
      { key: 'boeDate', header: 'BOE date', kind: 'date', width: 110, sortable: true },
      { key: 'portCode', header: 'Port', width: 90, value: (r) => r.portCode ?? '' },
      { key: 'supplier', header: 'Supplier', minWidth: 200, value: (r) => r.supplier ?? '' },
      { key: 'voucherNumber', header: 'Purchase no.', width: 120, value: (r) => r.voucherNumber ?? '' },
      { key: 'assessableValue', header: 'Assessable value', kind: 'amount', width: 150, total: true },
      { key: 'customsDuty', header: 'Customs duty', kind: 'amount', width: 130, total: true, blankZero: true },
      { key: 'igst', header: 'IGST', kind: 'amount', width: 130, total: true },
      { key: 'cess', header: 'Cess', kind: 'amount', width: 110, total: true, blankZero: true },
      { key: 'itc', header: 'ITC', width: 80, render: (r) => (r.itcClaimed ? <Badge tone="success">Claimed</Badge> : <Badge tone="neutral">Cost</Badge>) },
    ],
    [],
  );
  const rCols = useMemo<Column<BoeReconRow>[]>(
    () => [
      { key: 'status', header: 'Status', width: 140, render: (r) => <Badge tone={r.status === 'matched' ? 'success' : r.status === 'mismatch' ? 'warning' : 'danger'}>{BOE_STATUS_LABELS[r.status]}</Badge> },
      { key: 'boeNo', header: 'BOE no.', width: 120 },
      { key: 'boeDate', header: 'BOE date', kind: 'date', width: 110, value: (r) => r.boeDate ?? '' },
      { key: 'portCode', header: 'Port', width: 90, value: (r) => r.portCode ?? '' },
      { key: 'books', header: 'IGST (books)', kind: 'amount', width: 130, value: (r) => r.books?.igst ?? 0, blankZero: true },
      { key: 'portal', header: 'IGST (2B)', kind: 'amount', width: 130, value: (r) => r.portal?.igst ?? 0, blankZero: true },
      { key: 'igstDiff', header: 'Difference', kind: 'amount', width: 130, blankZero: true },
      { key: 'note', header: 'Note', minWidth: 220, value: (r) => r.note ?? '' },
    ],
    [],
  );
  const reconcile = async (): Promise<void> => {
    try {
      const file = await native('dialog.openFile', { title: 'Open the GSTR-2B JSON downloaded from the portal', filters: [{ name: 'GSTR-2B JSON', extensions: ['json', 'zip'] }] });
      if (!file) return;
      setResult(await recon.mutate({ from, to, fileName: file.name, bytes: file.bytes }));
    } catch (err) {
      toast.error('Could not reconcile the bills of entry', { message: userMessage(err) });
    }
  };
  const actions: ScreenActionItem[] = [
    { key: 'Alt+O', label: 'Reconcile with GSTR-2B', icon: 'upload', primary: true, onClick: () => void reconcile(), disabled: recon.pending, group: 'file' },
    { key: 'Alt+C', label: 'Create import purchase', icon: 'plus', onClick: () => nav.push('vouchers.entry', { baseType: 'purchase' }), hidden: !canCreate, group: 'edit' },
    { key: 'Ctrl+1', label: 'Register', onClick: () => setResult(null), disabled: result === null, group: 'view' },
  ];
  return (
    <ReportScreen
      title="Bills of Entry"
      subtitle={result ? 'Reconciliation with GSTR-2B (IMPG / IMPGSEZ)' : 'Imports of goods'}
      period={override}
      actions={actions}
      exportDef={
        result
          ? () => ({ ...boeReconExport(result.rows), title: 'Bills of Entry — GSTR-2B reconciliation', period: { from, to } })
          : q.data
            ? () => ({ ...boeExport(rows), title: 'Bills of Entry', period: { from, to } })
            : undefined
      }
      loading={q.loading}
      refreshing={q.refreshing || recon.pending}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open purchase · Alt+O Reconcile with GSTR-2B · Ctrl+1 Register · Alt+C Create import purchase · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-scroll">
        <GstHelp>
          IGST paid at customs on imported goods is claimed as ITC on the bill of entry (Rule 36(1)(d)), in GSTR-3B 4(A)(1). Enter the bill of entry on the purchase
          voucher with Alt+J; compare with the bills of entry GSTR-2B shows from ICEGATE before you claim.
        </GstHelp>
        {result ? (
          <>
            <Grid minItemWidth={160} gap={3}>
              <KpiCard label="Matched" value={result.counts.matched} />
              <KpiCard label="Mismatch" value={result.counts.mismatch} />
              <KpiCard label="Not in books" value={result.counts.missing_in_books} />
              <KpiCard label="Not in GSTR-2B" value={result.counts.missing_in_portal} />
            </Grid>
            {result.warnings.length > 0 ? (
              <Banner tone="warning" inline>
                {result.warnings.join(' ')}
              </Banner>
            ) : null}
            <DataTable<BoeReconRow>
              aria-label="Bill of entry reconciliation"
              autoFocus
              columns={rCols}
              rows={result.rows}
              getRowKey={(r, i) => `${r.boeNo}:${r.portCode ?? ''}:${i}`}
              onRowActivate={(r) => (r.books ? nav.push('vouchers.view', { id: r.books.voucherId }) : undefined)}
              empty={<EmptyState title="Nothing to reconcile" body="Neither the books nor the file have bills of entry in this period." />}
            />
          </>
        ) : (
          <DataTable<BoeRow>
            aria-label="Bills of entry"
            autoFocus
            columns={cols}
            rows={rows}
            getRowKey={(r) => `${r.voucherId}`}
            onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
            empty={<EmptyState icon="file" title="No bills of entry in this period" body="Record the import purchase (Alt+C) and enter its bill of entry with Alt+J." />}
          />
        )}
      </div>
    </ReportScreen>
  );
}

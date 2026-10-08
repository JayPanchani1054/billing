/**
 * 'gst.einvoice' {from?, to?, view?} (feature einvoice) — two views (Ctrl+1 / Ctrl+2):
 *   Pending IRN   invoices and notes that need an IRN, with readiness errors per voucher; select
 *                 (Space / Alt+A) and save the bulk JSON for the IRP (Alt+J); import the IRP response
 *                 (Alt+I: JSON or Excel) to record IRNs; vouchers cancelled in the books whose IRN is
 *                 still active, to mark cancelled.
 *   IRN generated documents with an active IRN and the 24-hour IRP cancellation window; mark an IRN
 *                 cancelled on the IRP (Alt+K).
 * Both: history per voucher (Alt+H); Enter opens the voucher.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EinvoiceGeneratedRow, EinvoiceImportResult, EinvoicePendingRow, GstCancelRequiredRow } from '../../../shared/types/gst-returns.ts';
import { isApiError, native, ReportScreen, useApiMutation, useApiQuery, useCan, useNav, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, Checkbox, DataTable, EmptyState, Field, Inline, Modal, Panel, Select, Stack, Tabs, TextInput, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { DocEventsDrawer, FileResultDialog, GstHelp, RejectedDocsDialog, saveJsonFile, useGstRange } from './components.tsx';
import type { FileResult } from './components.tsx';
import {
  cancelWindowText,
  formatIstDateTime,
  importSummary,
  IRN_CANCEL_REASONS,
  irnCancelReasonText,
  MAX_BULK,
  pruneSelection,
  rejectedFromDetails,
  selectionState,
  toggleAllReady,
  toggleSelection,
} from './lib/compliance.ts';
import type { IrnCancelReason } from './lib/compliance.ts';
import { bulkFileMessage } from './lib/reports.ts';

const SUPPLY_LABELS: Readonly<Record<EinvoicePendingRow['supplyType'], string>> = {
  B2B: 'B2B',
  SEZWP: 'SEZ with payment',
  SEZWOP: 'SEZ without payment',
  EXPWP: 'Export with payment',
  EXPWOP: 'Export without payment',
  DEXP: 'Deemed export',
};
const DOC_LABELS: Readonly<Record<EinvoicePendingRow['docType'], string>> = { INV: 'Invoice', CRN: 'Credit note', DBN: 'Debit note' };

type View = 'pending' | 'generated';

/** The voucher whose IRN is to be marked cancelled. */
interface CancelTarget {
  voucherId: number;
  voucherTypeName: string;
  number: string | null;
  /** What the user should know first (24-hour window). */
  note?: string;
}

export interface EinvoiceParams {
  from?: string;
  to?: string;
  view?: View;
}

export function EinvoiceScreen({ params }: ScreenProps<EinvoiceParams>) {
  const nav = useNav();
  const toast = useToast();
  const canFile = useCan('gst.file');
  const { from, to, override } = useGstRange(params);
  const [view, setView] = useState<View>(params?.view === 'generated' ? 'generated' : 'pending');
  const q = useApiQuery('gst.einvoice.pending', { from, to }, { keepPrevious: true });
  const g = useApiQuery('gst.einvoice.generated', { from, to }, { keepPrevious: true, enabled: view === 'generated' });
  const makeJson = useApiMutation('gst.einvoice.json');
  const importer = useApiMutation('gst.einvoice.importResponse', { invalidates: ['vouchers', 'print'] });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const generated = useMemo(() => g.data?.rows ?? [], [g.data]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  useEffect(() => setSelected((s) => pruneSelection(s, rows)), [rows]);
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.voucherId) === cursor) ?? rows[0] ?? null;
  const [genCursor, setGenCursor] = useState<string | null>(null);
  const currentGen = generated.find((r) => String(r.voucherId) === genCursor) ?? generated[0] ?? null;
  const [result, setResult] = useState<FileResult | null>(null);
  const [imported, setImported] = useState<EinvoiceImportResult | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [history, setHistory] = useState<{ id: number; title: string } | null>(null);
  const state = selectionState(selected, rows);
  const readyCount = rows.filter((r) => r.ready).length;
  const pending = view === 'pending';

  const generate = async (): Promise<void> => {
    const ids = [...selected];
    if (ids.length === 0) {
      toast.info('Select the invoices first', { message: 'Press Space on an invoice, or Alt+A to select every ready one.' });
      return;
    }
    if (ids.length > MAX_BULK) {
      toast.warning(`Select at most ${MAX_BULK} invoices`, { message: 'The IRP offline tool takes up to 1000 documents per file.' });
      return;
    }
    try {
      const file = await makeJson.mutate({ voucherIds: ids });
      const path = await saveJsonFile(file, 'Save e-invoice JSON');
      if (!path) return;
      setSelected(new Set());
      setResult({
        title: 'e-Invoice file saved',
        path,
        summary: bulkFileMessage(file),
        warnings: file.warnings,
        rejected: file.rejected,
        nextStep:
          'Upload it in the IRP offline tool or on the e-invoice portal (Bulk upload). Then download the response (JSON or Excel) and import it here with Alt+I to record the IRNs.',
      });
    } catch (err) {
      const rejected = isApiError(err) ? rejectedFromDetails(err.details) : [];
      if (rejected.length > 0) {
        setResult({ title: 'No file was created', path: '', summary: userMessage(err), warnings: [], rejected });
      } else {
        toast.error('Could not create the e-invoice file', { message: userMessage(err) });
      }
    }
  };

  const importResponse = async (): Promise<void> => {
    try {
      const file = await native('dialog.openFile', {
        title: 'Open the IRP response file',
        filters: [{ name: 'IRP response (JSON or Excel)', extensions: ['json', 'xlsx'] }],
      });
      if (!file) return;
      const out = await importer.mutate({ fileName: file.name, bytes: file.bytes });
      setImported(out);
    } catch (err) {
      toast.error('Could not import the IRP response', { message: userMessage(err) });
    }
  };

  const columns = useMemo<Column<EinvoicePendingRow>[]>(
    () => [
      {
        key: 'select',
        header: <span className="bx-sr-only">Select</span>,
        headerLabel: 'Select',
        width: 44,
        render: (r) =>
          r.ready ? (
            <Checkbox
              tabIndex={-1}
              checked={selected.has(r.voucherId)}
              onChange={() => setSelected((s) => toggleSelection(s, r.voucherId))}
              aria-label={`Select ${r.number ?? 'voucher'}`}
            />
          ) : null,
      },
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      { key: 'number', header: 'Number', width: 160, sortable: true, value: (r) => r.number ?? '' },
      { key: 'docType', header: 'Document', width: 110, value: (r) => DOC_LABELS[r.docType] },
      { key: 'partyName', header: 'Party', minWidth: 180, sortable: true, value: (r) => r.partyName ?? '' },
      { key: 'gstin', header: 'GSTIN', width: 160, value: (r) => r.gstin ?? '' },
      { key: 'supplyType', header: 'Supply', width: 150, value: (r) => SUPPLY_LABELS[r.supplyType] },
      { key: 'invoiceValue', header: 'Value', kind: 'amount', width: 130, sortable: true, total: true },
      {
        key: 'status',
        header: 'Status',
        width: 150,
        sortValue: (r) => (r.ready ? 1 : 0),
        sortable: true,
        render: (r) =>
          r.ready ? (
            <Badge tone="success" size="sm" icon="check">
              {r.warnings.length > 0 ? `Ready · ${r.warnings.length} note${r.warnings.length === 1 ? '' : 's'}` : 'Ready'}
            </Badge>
          ) : (
            <Badge tone="danger" size="sm" icon="x-circle">
              {r.errors.length} {r.errors.length === 1 ? 'error' : 'errors'}
            </Badge>
          ),
      },
    ],
    [selected],
  );

  const genColumns = useMemo<Column<EinvoiceGeneratedRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      { key: 'number', header: 'Number', width: 150, sortable: true, value: (r) => r.number ?? '' },
      { key: 'docType', header: 'Document', width: 110, value: (r) => DOC_LABELS[r.docType] },
      { key: 'partyName', header: 'Party', minWidth: 180, sortable: true, value: (r) => r.partyName ?? '' },
      { key: 'invoiceValue', header: 'Value', kind: 'amount', width: 130, sortable: true, total: true },
      { key: 'ackNo', header: 'Ack no.', width: 150, value: (r) => r.ackNo ?? '' },
      { key: 'irn', header: 'IRN', width: 150, render: (r) => <span className="bx-mono bx-truncate" title={r.irn}>{`${r.irn.slice(0, 10)}…`}</span> },
      {
        key: 'window',
        header: 'Cancel on IRP',
        width: 170,
        sortable: true,
        sortValue: (r) => r.cancellableUntil ?? '',
        render: (r) =>
          r.cancelledInBooks ? (
            <Badge tone="danger" size="sm" icon="alert">
              Cancelled in books
            </Badge>
          ) : r.cancelWindowOpen && r.cancellableUntil ? (
            <Badge tone="warning" size="sm" icon="clock">
              {`Until ${formatIstDateTime(r.cancellableUntil)}`}
            </Badge>
          ) : (
            <Badge tone="neutral" size="sm">
              Window closed
            </Badge>
          ),
      },
    ],
    [],
  );

  const markTarget: CancelTarget | null = pending
    ? null
    : currentGen
      ? { voucherId: currentGen.voucherId, voucherTypeName: currentGen.voucherTypeName, number: currentGen.number, note: cancelWindowText(currentGen) }
      : null;
  const historyRow = pending ? current : currentGen;
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Pending IRN', onClick: () => setView('pending'), disabled: pending, group: 'view' },
    { key: 'Ctrl+2', label: 'IRN generated', onClick: () => setView('generated'), disabled: !pending, group: 'view' },
    { key: 'Alt+A', label: state === 'all' ? 'Clear selection' : 'Select all ready', icon: 'check', onClick: () => setSelected((s) => toggleAllReady(s, rows)), disabled: readyCount === 0, hidden: !pending, group: 'select' },
    {
      key: 'Alt+J',
      label: selected.size > 0 ? `Generate JSON (${selected.size})` : 'Generate JSON',
      icon: 'download',
      primary: true,
      onClick: () => void generate(),
      disabled: !canFile || makeJson.pending,
      hidden: !pending,
      hint: canFile ? 'Bulk file for the IRP offline tool' : 'You need the "File GST returns" permission',
      group: 'file',
    },
    {
      key: 'Alt+I',
      label: 'Import IRP response',
      icon: 'upload',
      onClick: () => void importResponse(),
      disabled: !canFile || importer.pending,
      hint: canFile ? 'Record IRNs from the IRP response file (JSON or Excel)' : 'You need the "File GST returns" permission',
      group: 'file',
    },
    {
      key: 'Alt+K',
      label: 'Mark IRN cancelled',
      icon: 'x-circle',
      onClick: () => markTarget && setCancelTarget(markTarget),
      disabled: !markTarget || !canFile,
      hidden: pending,
      hint: canFile ? 'After cancelling the IRN on the e-invoice portal' : 'You need the "File GST returns" permission',
      group: 'row',
    },
    {
      key: 'Alt+H',
      label: 'History',
      icon: 'clock',
      onClick: () => historyRow && setHistory({ id: historyRow.voucherId, title: `${DOC_LABELS[historyRow.docType]} ${historyRow.number ?? ''}` }),
      disabled: !historyRow,
      group: 'row',
    },
    { key: 'Alt+L', label: 'Alter voucher', icon: 'edit', onClick: () => current && nav.push('vouchers.entry', { id: current.voucherId }), disabled: !current, hidden: !pending, group: 'row' },
  ];

  const enabled = q.data?.enabled ?? true;
  const active = pending ? q : g;
  return (
    <>
      <ReportScreen
        title="e-Invoice"
        subtitle={
          pending
            ? q.data
              ? `${rows.length} pending · ${readyCount} ready${selected.size ? ` · ${selected.size} selected` : ''}`
              : undefined
            : g.data
              ? `${generated.length} with an active IRN`
              : undefined
        }
        period={override}
        filters={
          <Tabs
            aria-label="e-Invoice view"
            variant="pill"
            value={view}
            onChange={(id) => setView(id === 'generated' ? 'generated' : 'pending')}
            items={[
              { id: 'pending', label: 'Pending IRN', badge: q.data ? rows.length : undefined },
              { id: 'generated', label: 'IRN generated' },
            ]}
          />
        }
        actions={actions}
        exportDef={
          pending && q.data
            ? () => ({
                title: 'e-Invoices Pending',
                columns: [
                  { header: 'Date', kind: 'date' },
                  { header: 'Number' },
                  { header: 'Document' },
                  { header: 'Party' },
                  { header: 'GSTIN' },
                  { header: 'Supply' },
                  { header: 'Value', kind: 'amount' },
                  { header: 'Status' },
                  { header: 'Errors / notes', width: 60 },
                ],
                rows: rows.map((r) => [
                  r.date,
                  r.number ?? '',
                  DOC_LABELS[r.docType],
                  r.partyName ?? '',
                  r.gstin ?? '',
                  SUPPLY_LABELS[r.supplyType],
                  r.invoiceValue,
                  r.ready ? 'Ready' : 'Errors',
                  [...r.errors, ...r.warnings].join(' '),
                ]),
                landscape: true,
              })
            : !pending && g.data
              ? () => ({
                  title: 'e-Invoices Generated',
                  columns: [
                    { header: 'Date', kind: 'date' },
                    { header: 'Number' },
                    { header: 'Document' },
                    { header: 'Party' },
                    { header: 'GSTIN' },
                    { header: 'Value', kind: 'amount' },
                    { header: 'Ack no.' },
                    { header: 'Ack date' },
                    { header: 'IRN', width: 66 },
                    { header: 'Cancelled in books' },
                  ],
                  rows: generated.map((r) => [r.date, r.number ?? '', DOC_LABELS[r.docType], r.partyName ?? '', r.gstin ?? '', r.invoiceValue, r.ackNo ?? '', r.ackDate ?? '', r.irn, r.cancelledInBooks]),
                  landscape: true,
                })
              : undefined
        }
        loading={active.loading}
        refreshing={active.refreshing || makeJson.pending || importer.pending}
        error={active.error}
        onRetry={() => void active.refetch()}
        hint={
          pending
            ? 'Space Select · Alt+A All ready · Alt+J JSON · Alt+I Import response · Ctrl+2 IRN generated · Enter Open · Esc Back'
            : 'Alt+K Mark IRN cancelled · Alt+H History · Alt+I Import response · Ctrl+1 Pending · Enter Open · Esc Back'
        }
      >
        <div className="bx-gst-fill">
          <GstHelp>
            {pending
              ? 'B2B, SEZ, export and deemed-export invoices and notes that still need an IRN. Select the ready ones, save the JSON for the IRP, then import the IRP’s response to record the IRN and QR code on each invoice.'
              : 'Invoices and notes with an IRN. The IRP lets you cancel an IRN only within 24 hours of generation; after you cancel it there, mark it cancelled here (Alt+K). Later, reverse the invoice with a credit note instead.'}
          </GstHelp>
          {!enabled ? (
            <Banner tone="info" title="e-Invoicing is turned off">
              Turn on e-Invoice under Features (F11) if your turnover makes it mandatory. Pending invoices are still listed below.
            </Banner>
          ) : null}
          {pending ? (
            <>
              {q.data && q.data.cancelRequired.length > 0 ? (
                <CancelRequiredPanel
                  rows={q.data.cancelRequired}
                  canFile={canFile}
                  onMark={(r) => setCancelTarget({ voucherId: r.voucherId, voucherTypeName: r.voucherTypeName, number: r.number })}
                  onHistory={(r) => setHistory({ id: r.voucherId, title: r.number ?? '' })}
                />
              ) : null}
              <DataTable<EinvoicePendingRow>
                aria-label="Invoices pending e-invoicing"
                autoFocus
                columns={columns}
                rows={rows}
                getRowKey={(r) => String(r.voucherId)}
                selectedKey={current ? String(current.voucherId) : null}
                onSelect={(k) => setCursor(k)}
                onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
                onRowKeyDown={(e, r) => {
                  if (e.key === ' ' && r && r.ready) {
                    e.preventDefault();
                    setSelected((s) => toggleSelection(s, r.voucherId));
                  }
                }}
                height="45vh"
                empty={<EmptyState icon="check-circle" title="No invoices waiting for an IRN" body="Every B2B, SEZ and export invoice in this period has an IRN. Change the period with Alt+F2." />}
              />
              {current ? <ReadinessPanel row={current} onAlter={() => nav.push('vouchers.entry', { id: current.voucherId })} /> : null}
            </>
          ) : (
            <>
              <DataTable<EinvoiceGeneratedRow>
                aria-label="Invoices with an active IRN"
                autoFocus
                columns={genColumns}
                rows={generated}
                getRowKey={(r) => String(r.voucherId)}
                selectedKey={currentGen ? String(currentGen.voucherId) : null}
                onSelect={(k) => setGenCursor(k)}
                onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
                height="45vh"
                empty={<EmptyState icon="file" title="No IRNs in this period" body="Import the IRP response (Alt+I) after uploading the e-invoice JSON, or change the period with Alt+F2." />}
              />
              {currentGen ? (
                <Banner tone={currentGen.cancelledInBooks ? 'danger' : currentGen.cancelWindowOpen ? 'warning' : 'info'} inline>
                  {`${DOC_LABELS[currentGen.docType]} ${currentGen.number ?? ''} · Ack ${currentGen.ackNo ?? '—'}${currentGen.ackDate ? ` of ${currentGen.ackDate}` : ''}. ${cancelWindowText(currentGen)}`}
                </Banner>
              ) : null}
            </>
          )}
        </div>
      </ReportScreen>
      <FileResultDialog result={result && result.path ? result : null} onClose={() => setResult(null)} />
      {result && !result.path ? <RejectedDocsDialog result={result} onClose={() => setResult(null)} /> : null}
      {imported ? <ImportResultDialog result={imported} onClose={() => setImported(null)} /> : null}
      {cancelTarget ? <MarkCancelledDialog target={cancelTarget} onClose={() => setCancelTarget(null)} /> : null}
      <DocEventsDrawer voucherId={history?.id ?? null} title={history?.title ?? ''} onClose={() => setHistory(null)} />
    </>
  );
}

function ReadinessPanel({ row, onAlter }: { row: EinvoicePendingRow; onAlter: () => void }) {
  const title = `${DOC_LABELS[row.docType]} ${row.number ?? ''} · ${row.partyName ?? ''}`;
  if (row.errors.length === 0 && row.warnings.length === 0) {
    return (
      <Banner tone="success" inline>
        {title}: ready for the IRP.
      </Banner>
    );
  }
  return (
    <Panel
      title={title}
      headingLevel={2}
      description={row.ready ? 'Ready — but check these notes.' : 'Fix these before generating the e-invoice:'}
      actions={
        <Button size="sm" icon="edit" onClick={onAlter}>
          Alter voucher (Alt+L)
        </Button>
      }
    >
      <ul className="bx-gst-list">
        {row.errors.map((e, i) => (
          <li key={`e${i}`}>
            <Badge tone="danger" size="sm">
              Error
            </Badge>{' '}
            {e}
          </li>
        ))}
        {row.warnings.map((w, i) => (
          <li key={`w${i}`}>
            <Badge tone="warning" size="sm">
              Note
            </Badge>{' '}
            {w}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function CancelRequiredPanel({
  rows,
  canFile,
  onMark,
  onHistory,
}: {
  rows: readonly GstCancelRequiredRow[];
  canFile: boolean;
  onMark: (r: GstCancelRequiredRow) => void;
  onHistory: (r: GstCancelRequiredRow) => void;
}) {
  return (
    <Banner tone="warning" title={`${rows.length} cancelled ${rows.length === 1 ? 'invoice still has' : 'invoices still have'} an active IRN`}>
      <Stack gap={1}>
        <span>Cancel the IRN on the e-invoice portal (within 24 hours of generation), then mark it cancelled here.</span>
        <ul className="bx-gst-list">
          {rows.map((r) => (
            <li key={r.voucherId}>
              <Inline gap={2}>
                <span>
                  {r.voucherTypeName} {r.number} · {r.partyName ?? ''} · IRN <span className="bx-mono">{r.refNo.slice(0, 12)}…</span>
                </span>
                <Button size="sm" variant="secondary" disabled={!canFile} onClick={() => onMark(r)}>
                  Mark IRN cancelled
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onHistory(r)}>
                  History
                </Button>
              </Inline>
            </li>
          ))}
        </ul>
      </Stack>
    </Banner>
  );
}

function MarkCancelledDialog({ target, onClose }: { target: CancelTarget; onClose: () => void }) {
  const toast = useToast();
  const mark = useApiMutation('gst.einvoice.markCancelled', { invalidates: ['vouchers', 'print'] });
  const [reason, setReason] = useState<IrnCancelReason>('data_entry');
  const [remark, setRemark] = useState('');
  const [error, setError] = useState<string | null>(null);
  const label = `${target.voucherTypeName} ${target.number ?? ''}`.trim();
  const submit = async (): Promise<void> => {
    const text = irnCancelReasonText(reason, remark);
    if (!text) {
      setError('Describe the reason as you entered it on the IRP (at least 3 characters).');
      return;
    }
    try {
      await mark.mutate({ voucherId: target.voucherId, reason: text });
      toast.success(`IRN of ${label || 'the voucher'} marked cancelled`);
      onClose();
    } catch (err) {
      setError(userMessage(err));
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Mark IRN cancelled — ${label}`}
      description="Do this after you have cancelled the IRN on the e-invoice portal. The voucher keeps its number; a new invoice needs a new number."
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          <Button variant="danger" shortcut="Ctrl+A" loading={mark.pending} onClick={() => void submit()}>
            Mark cancelled
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        {target.note ? (
          <Banner tone="warning" inline>
            {target.note}
          </Banner>
        ) : null}
        <CancelForm reason={reason} setReason={setReason} remark={remark} setRemark={setRemark} error={error} onSubmit={() => void submit()} />
      </Stack>
    </Modal>
  );
}

/** Inside the modal so Ctrl+A binds to the dialog's own hotkey scope. */
function CancelForm(p: {
  reason: IrnCancelReason;
  setReason: (v: IrnCancelReason) => void;
  remark: string;
  setRemark: (v: string) => void;
  error: string | null;
  onSubmit: () => void;
}) {
  useHotkeys({ 'Ctrl+A': () => p.onSubmit() }, [p.onSubmit]);
  return (
    <Stack gap={3}>
      <Field label="Reason given on the IRP" required>
        <Select<IrnCancelReason> data-autofocus="" value={p.reason} onChange={p.setReason} options={IRN_CANCEL_REASONS.map((r) => ({ value: r.value, label: r.label }))} />
      </Field>
      <Field
        label="Remarks"
        optional={p.reason !== 'others'}
        required={p.reason === 'others'}
        error={p.error ?? undefined}
        hint="As entered on the IRP (up to 100 characters)."
      >
        <TextInput
          value={p.remark}
          maxLength={100}
          onChange={(e) => p.setRemark(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              p.onSubmit();
            }
          }}
        />
      </Field>
    </Stack>
  );
}

function ImportResultDialog({ result, onClose }: { result: EinvoiceImportResult; onClose: () => void }) {
  const s = importSummary(result);
  return (
    <Modal
      open
      onClose={onClose}
      title={s.title}
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Stack gap={3}>
        <Banner tone={s.tone}>
          <ul className="bx-gst-list">
            {s.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </Banner>
        {result.warnings.length > 0 ? (
          <Banner tone="warning" title="Act on these">
            <ul className="bx-gst-list">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {result.updated.length > 0 ? (
          <Panel title="IRN recorded" headingLevel={3} collapsible defaultCollapsed={result.updated.length > 10}>
            <ul className="bx-gst-list">
              {result.updated.map((u) => (
                <li key={u.voucherId}>
                  {u.number ?? `Voucher ${u.voucherId}`} · Ack {u.ackNo ?? '—'}
                  {u.ewayBillNo ? ` · e-way bill ${u.ewayBillNo}` : ''}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        {result.skipped.length > 0 ? (
          <Panel title="Not applied" headingLevel={3}>
            <ul className="bx-gst-list">
              {result.skipped.map((x, i) => (
                <li key={i}>
                  {x.docNo ?? '(no number)'}
                  {x.docDate ? ` dated ${x.docDate}` : ''}: {x.reason}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        {result.failed.length > 0 ? (
          <Panel title="Rejected by the IRP" headingLevel={3}>
            <ul className="bx-gst-list">
              {result.failed.map((x, i) => (
                <li key={i}>
                  {x.docNo ?? '(no number)'}: {x.message}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </Stack>
    </Modal>
  );
}


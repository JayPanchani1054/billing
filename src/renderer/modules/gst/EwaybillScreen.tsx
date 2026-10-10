/**
 * 'gst.ewaybill' {from?, to?} (feature ewayBill) — sales and sales returns whose goods value exceeds
 * the e-way bill limit and that have no e-way bill yet. Select (Space / Alt+S) and save the bulk JSON
 * for the EWB portal (Alt+J); record the e-way bill number, date and validity the portal gives
 * (Alt+N); history per voucher (Alt+H). Enter opens the voucher, Alt+A alters it.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EwayPendingRow } from '../../../shared/types/gst-returns.ts';
import { formatMoney, isApiError, ReportScreen, useApiMutation, useApiQuery, useCan, useNav, userMessage, useWorkingDate, fieldErrorsOf } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, Checkbox, DataTable, DateInput, EmptyState, Field, Modal, Panel, Stack, TextInput, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { DocEventsDrawer, FileResultDialog, GstHelp, RejectedDocsDialog, saveJsonFile, useGstRange } from './components.tsx';
import type { FileResult } from './components.tsx';
import { MAX_BULK, normaliseEwbNo, pruneSelection, rejectedFromDetails, selectionState, toggleAllReady, toggleSelection, validateEwbForm } from './lib/compliance.ts';
import type { EwbFormErrors } from './lib/compliance.ts';
import { bulkFileMessage } from './lib/reports.ts';

export function EwaybillScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const nav = useNav();
  const toast = useToast();
  const canFile = useCan('gst.file');
  const { from, to, override } = useGstRange(params);
  const q = useApiQuery('gst.ewaybill.pending', { from, to }, { keepPrevious: true });
  const makeJson = useApiMutation('gst.ewaybill.json');
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  useEffect(() => setSelected((s) => pruneSelection(s, rows)), [rows]);
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.voucherId) === cursor) ?? rows[0] ?? null;
  const [result, setResult] = useState<FileResult | null>(null);
  const [recording, setRecording] = useState<EwayPendingRow | null>(null);
  const [history, setHistory] = useState<{ id: number; title: string } | null>(null);
  const state = selectionState(selected, rows);
  const readyCount = rows.filter((r) => r.ready).length;
  const threshold = q.data ? formatMoney(q.data.thresholdPaise, { symbol: true }) : 'the e-way bill limit';

  const generate = async (): Promise<void> => {
    const ids = [...selected];
    if (ids.length === 0) {
      toast.info('Select the invoices first', { message: 'Press Space on an invoice, or Alt+S to select every ready one.' });
      return;
    }
    if (ids.length > MAX_BULK) {
      toast.warning(`Select at most ${MAX_BULK} invoices`);
      return;
    }
    try {
      const file = await makeJson.mutate({ voucherIds: ids });
      const path = await saveJsonFile(file, 'Save e-way bill JSON');
      if (!path) return;
      setSelected(new Set());
      setResult({
        title: 'e-Way Bill file saved',
        path,
        summary: bulkFileMessage(file),
        warnings: file.warnings,
        rejected: file.rejected,
        nextStep: 'Upload it on the e-way bill portal (e-Waybill › Generate Bulk). Then record each e-way bill number here with Alt+N.',
      });
    } catch (err) {
      const rejected = isApiError(err) ? rejectedFromDetails(err.details) : [];
      if (rejected.length > 0) setResult({ title: 'No file was created', path: '', summary: userMessage(err), warnings: [], rejected });
      else toast.error('Could not create the e-way bill file', { message: userMessage(err) });
    }
  };

  const columns = useMemo<Column<EwayPendingRow>[]>(
    () => [
      {
        key: 'select',
        header: <span className="bx-sr-only">Select</span>,
        headerLabel: 'Select',
        width: 44,
        render: (r) =>
          r.ready ? (
            <Checkbox tabIndex={-1} checked={selected.has(r.voucherId)} onChange={() => setSelected((s) => toggleSelection(s, r.voucherId))} aria-label={`Select ${r.number ?? 'voucher'}`} />
          ) : null,
      },
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      { key: 'number', header: 'Number', width: 150, sortable: true, value: (r) => r.number ?? '' },
      { key: 'voucherTypeName', header: 'Type', width: 120 },
      { key: 'partyName', header: 'Party', minWidth: 180, sortable: true, value: (r) => r.partyName ?? '' },
      { key: 'toGstin', header: 'To GSTIN', width: 160 },
      { key: 'consignmentValue', header: 'Goods value', kind: 'amount', width: 130, sortable: true, total: true },
      { key: 'invoiceValue', header: 'Invoice value', kind: 'amount', width: 130, sortable: true },
      { key: 'distanceKm', header: 'Km', width: 70, align: 'right', value: (r) => r.distanceKm, render: (r) => (r.distanceKm === null ? '' : String(r.distanceKm)) },
      { key: 'vehicleNo', header: 'Vehicle', width: 120, value: (r) => r.vehicleNo ?? '' },
      {
        key: 'status',
        header: 'Status',
        width: 140,
        sortable: true,
        sortValue: (r) => (r.ready ? 1 : 0),
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

  const actions: ScreenActionItem[] = [
    { key: 'Alt+S', label: state === 'all' ? 'Clear selection' : 'Select all ready', icon: 'check', onClick: () => setSelected((s) => toggleAllReady(s, rows)), disabled: readyCount === 0, group: 'select' },
    {
      key: 'Alt+J',
      label: selected.size > 0 ? `Generate JSON (${selected.size})` : 'Generate JSON',
      icon: 'download',
      primary: true,
      onClick: () => void generate(),
      disabled: !canFile || makeJson.pending,
      hint: canFile ? 'Bulk file for the e-way bill portal' : 'You need the "File GST returns" permission',
      group: 'file',
    },
    { key: 'Alt+N', label: 'Record e-Way Bill no.', icon: 'edit', onClick: () => current && setRecording(current), hidden: !canFile, disabled: !current || !canFile, group: 'row' },
    { key: 'Alt+H', label: 'History', icon: 'clock', onClick: () => current && setHistory({ id: current.voucherId, title: `${current.voucherTypeName} ${current.number ?? ''}` }), disabled: !current, group: 'row' },
    { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', onClick: () => current && nav.push('vouchers.entry', { id: current.voucherId }), disabled: !current, group: 'row' },
  ];

  const enabled = q.data?.enabled ?? true;
  return (
    <>
      <ReportScreen
        title="e-Way Bills"
        subtitle={q.data ? `${rows.length} pending · ${readyCount} ready${selected.size ? ` · ${selected.size} selected` : ''}` : undefined}
        period={override}
        actions={actions}
        exportDef={
          q.data
            ? () => ({
                title: 'e-Way Bills Pending',
                columns: [
                  { header: 'Date', kind: 'date' },
                  { header: 'Number' },
                  { header: 'Type' },
                  { header: 'Party' },
                  { header: 'To GSTIN' },
                  { header: 'Goods value', kind: 'amount' },
                  { header: 'Invoice value', kind: 'amount' },
                  { header: 'Km', kind: 'number' },
                  { header: 'Vehicle' },
                  { header: 'Errors / notes', width: 60 },
                ],
                rows: rows.map((r) => [
                  r.date,
                  r.number ?? '',
                  r.voucherTypeName,
                  r.partyName ?? '',
                  r.toGstin,
                  r.consignmentValue,
                  r.invoiceValue,
                  r.distanceKm,
                  r.vehicleNo ?? '',
                  [...r.errors, ...r.warnings].join(' '),
                ]),
                landscape: true,
              })
            : undefined
        }
        loading={q.loading}
        refreshing={q.refreshing || makeJson.pending}
        error={q.error}
        onRetry={() => void q.refetch()}
        hint="Space Select · Alt+S All ready · Alt+A Alter voucher · Alt+J JSON · Alt+N Record EWB no. · Enter Open · Esc Back"
      >
        <div className="bx-gst-fill">
          <GstHelp>
            Sales and sales returns whose goods value is more than {threshold} need an e-way bill before the goods move. Save the JSON for the EWB portal, then
            record the e-way bill number it gives you.
          </GstHelp>
          {!enabled ? (
            <Banner tone="info" title="e-Way Bills are turned off">
              Turn on e-Way Bill under Features (F11) to track them. Invoices above the limit are still listed below.
            </Banner>
          ) : null}
          {q.data && q.data.cancelRequired.length > 0 ? (
            <Banner tone="warning" title={`${q.data.cancelRequired.length} cancelled ${q.data.cancelRequired.length === 1 ? 'invoice still has' : 'invoices still have'} an e-way bill`}>
              Cancel {q.data.cancelRequired.length === 1 ? 'it' : 'them'} on the EWB portal within 24 hours of generation:{' '}
              {q.data.cancelRequired.map((r) => `${r.voucherTypeName} ${r.number ?? ''} (EWB ${r.refNo})`).join(', ')}.
            </Banner>
          ) : null}
          <DataTable<EwayPendingRow>
            aria-label="Invoices that need an e-Way Bill"
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
            empty={<EmptyState icon="check-circle" title="No e-Way Bills pending" body={`No invoice in this period is above ${threshold} without an e-way bill. Change the period with Alt+F2.`} />}
          />
          {current && (current.errors.length > 0 || current.warnings.length > 0) ? (
            <Panel
              title={`${current.voucherTypeName} ${current.number ?? ''} · ${current.partyName ?? ''}`}
              headingLevel={2}
              description={current.ready ? 'Ready — but check these notes.' : 'Fix these before generating the e-way bill:'}
              actions={
                <Button size="sm" icon="edit" onClick={() => nav.push('vouchers.entry', { id: current.voucherId })}>
                  Alter voucher (Alt+A)
                </Button>
              }
            >
              <ul className="bx-gst-list">
                {current.errors.map((e, i) => (
                  <li key={`e${i}`}>
                    <Badge tone="danger" size="sm">
                      Error
                    </Badge>{' '}
                    {e}
                  </li>
                ))}
                {current.warnings.map((w, i) => (
                  <li key={`w${i}`}>
                    <Badge tone="warning" size="sm">
                      Note
                    </Badge>{' '}
                    {w}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </ReportScreen>
      <FileResultDialog result={result && result.path ? result : null} onClose={() => setResult(null)} />
      {result && !result.path ? <RejectedDocsDialog result={result} onClose={() => setResult(null)} /> : null}
      {recording ? <RecordEwbDialog row={recording} onClose={() => setRecording(null)} /> : null}
      <DocEventsDrawer voucherId={history?.id ?? null} title={history?.title ?? ''} onClose={() => setHistory(null)} />
    </>
  );
}

function RecordEwbDialog({ row, onClose }: { row: EwayPendingRow; onClose: () => void }) {
  const toast = useToast();
  const { date: workingDate } = useWorkingDate();
  const update = useApiMutation('gst.ewaybill.update', { invalidates: ['vouchers', 'print'] });
  const [no, setNo] = useState('');
  const [date, setDate] = useState<string | null>(workingDate < row.date ? row.date : workingDate);
  const [validUpto, setValidUpto] = useState<string | null>(null);
  const [errors, setErrors] = useState<EwbFormErrors>({});
  const submit = async (): Promise<void> => {
    const e = validateEwbForm({ ewayBillNo: no, date, validUpto }, row.date);
    setErrors(e);
    if (Object.keys(e).length > 0 || !date) return;
    try {
      await update.mutate({ voucherId: row.voucherId, ewayBillNo: normaliseEwbNo(no), date, validUpto });
      toast.success(`e-Way Bill recorded on ${row.number ?? 'the invoice'}`);
      onClose();
    } catch (err) {
      const fe = fieldErrorsOf(err);
      if (Object.keys(fe).length > 0) setErrors({ ewayBillNo: fe.ewayBillNo, date: fe.date, validUpto: fe.validUpto });
      else toast.error('Could not record the e-way bill', { message: userMessage(err) });
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Record e-Way Bill — ${row.voucherTypeName} ${row.number ?? ''}`}
      description={`${row.partyName ?? ''} · goods value ${formatMoney(row.consignmentValue, { symbol: true })}`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={update.pending} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <EwbForm no={no} setNo={setNo} date={date} setDate={setDate} validUpto={validUpto} setValidUpto={setValidUpto} minDate={row.date} errors={errors} onSubmit={() => void submit()} />
    </Modal>
  );
}

/** Inside the modal so Enter / Ctrl+A bind to the dialog. */
function EwbForm(p: {
  no: string;
  setNo: (v: string) => void;
  date: string | null;
  setDate: (v: string | null) => void;
  validUpto: string | null;
  setValidUpto: (v: string | null) => void;
  minDate: string;
  errors: EwbFormErrors;
  onSubmit: () => void;
}) {
  useHotkeys({ 'Ctrl+A': () => p.onSubmit() }, [p.onSubmit]);
  const ref = useEnterAdvance<HTMLFormElement>({ onComplete: p.onSubmit });
  return (
    <form ref={ref} onSubmit={(e) => e.preventDefault()}>
      <Stack gap={3}>
        <Field label="e-Way Bill no." required error={p.errors.ewayBillNo} hint="12 digits, as shown on the EWB portal.">
          <TextInput data-autofocus="" mono inputMode="numeric" value={p.no} maxLength={16} onChange={(e) => p.setNo(e.target.value)} />
        </Field>
        <Field label="Generated on" required error={p.errors.date}>
          <DateInput value={p.date} onChange={p.setDate} minDate={p.minDate} referenceDate={p.date ?? p.minDate} />
        </Field>
        <Field label="Valid up to" optional error={p.errors.validUpto} hint="Leave blank if Part-B (vehicle) is not filled yet.">
          <DateInput value={p.validUpto} onChange={p.setValidUpto} minDate={p.date ?? p.minDate} referenceDate={p.date ?? p.minDate} />
        </Field>
      </Stack>
    </form>
  );
}

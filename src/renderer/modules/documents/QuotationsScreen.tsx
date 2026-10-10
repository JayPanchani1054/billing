/**
 * 'documents.quotations' {baseType?: 'quotation' | 'proforma', status?} — the register of quotations or
 * proforma invoices for the period: status (open / accepted / rejected / expired / converted /
 * cancelled), validity, what each became, value by status and the conversion rate.
 *
 * Keys: Enter view · Ctrl+1 Quotations · Ctrl+2 Proforma · Ctrl+3…8 status filter · Alt+C create ·
 * Alt+V convert to Sales Invoice · Alt+O convert to Sales Order · Alt+S accept / reject · Alt+F2
 * period · Alt+E export · Alt+P print.
 *
 * 'documents.quotation.status' {id} (dialog) — mark accepted / rejected (with a reason) / open again.
 */
import { useMemo, useState } from 'react';
import { formatMoney } from '../../../shared/format.ts';
import type { DocumentBaseType, DocumentDecision, DocumentRow, DocumentStatus } from '../../../shared/types/documents.ts';
import { DialogScreen, ReportScreen, useApiMutation, useApiQuery, useCan, useFeatures, useNav, usePeriod, userMessage, useShell, useWorkingDate } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, EmptyState, Field, RadioGroup, SegmentedControl, Stack, TextArea, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { canConvert, DOC_LABEL, DOCUMENTS_INVALIDATES, documentsExport, expiryText, STATUS_META } from './lib/model.ts';

const STATUS_FILTERS: ReadonlyArray<{ value: DocumentStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'expired', label: 'Expired' },
  { value: 'converted', label: 'Converted' },
  { value: 'rejected', label: 'Rejected' },
];

export interface QuotationsParams {
  baseType?: DocumentBaseType;
  status?: DocumentStatus;
}

export function QuotationsScreen({ params }: ScreenProps<QuotationsParams>) {
  const { from, to } = usePeriod();
  const { date: workingDate } = useWorkingDate();
  const nav = useNav();
  const shell = useShell();
  const features = useFeatures();
  const canCreate = useCan('vouchers.create');
  const canAlter = useCan('vouchers.alter');
  const [base, setBase] = useState<DocumentBaseType>(params?.baseType === 'proforma' ? 'proforma' : 'quotation');
  const [status, setStatus] = useState<DocumentStatus | 'all'>(params?.status ?? 'all');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useApiQuery('documents.quotation.list', { baseType: base, from, to, ...(status === 'all' ? {} : { status }) }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const current = rows.find((r) => String(r.id) === selected) ?? rows[0] ?? null;
  const L = DOC_LABEL[base];

  const columns = useMemo<Column<DocumentRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 105, sortable: true },
      { key: 'number', header: 'No.', width: 90, value: (r) => r.number ?? '' },
      { key: 'partyName', header: 'Party', minWidth: 180, value: (r) => r.partyName ?? '', sortable: true },
      { key: 'validUntil', header: 'Valid until', kind: 'date', width: 110 },
      {
        key: 'status',
        header: 'Status',
        width: 200,
        value: (r) => STATUS_META[r.status].label,
        render: (r) => (
          <span>
            <Badge tone={STATUS_META[r.status].tone} size="sm">
              {STATUS_META[r.status].label}
            </Badge>{' '}
            <span className="bx-muted">{expiryText(r) ?? r.statusReason ?? ''}</span>
          </span>
        ),
      },
      {
        key: 'convertedTo',
        header: 'Converted into',
        width: 180,
        value: (r) => (r.convertedTo ? `${r.convertedTo.voucherTypeName} ${r.convertedTo.number ?? ''}` : ''),
      },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140, total: true, sortable: true },
    ],
    [],
  );
  const s = q.data?.summary;
  const footer = useMemo<FooterRow[]>(
    () =>
      s && rows.length > 0
        ? [
            {
              key: 'summary',
              tone: 'total',
              cells: {
                partyName: `${s.count} document${s.count === 1 ? '' : 's'} · converted ${s.byStatus.converted.count}${s.conversionRatePct !== null ? ` (${s.conversionRatePct}%)` : ''}`,
                amount: s.value,
              },
            },
          ]
        : [],
    [s, rows.length],
  );

  const avail = shell.voucherAvailability(base);
  const convertible = current !== null && canConvert(current.status) && canCreate;
  const convert = (target: 'sales' | 'sales_order') => current && nav.push('vouchers.entry', { draft: { sourceId: current.id, targetBaseType: target, date: workingDate } });
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Quotations', icon: 'file', onClick: () => setBase('quotation'), disabled: base === 'quotation', group: 'view' },
    { key: 'Ctrl+2', label: 'Proforma invoices', icon: 'invoice', onClick: () => setBase('proforma'), disabled: base === 'proforma', group: 'view' },
    ...STATUS_FILTERS.map(
      (f, i): ScreenActionItem => ({ key: `Ctrl+${i + 3}`, label: `Show ${f.label.toLowerCase()}`, icon: 'filter', onClick: () => setStatus(f.value), disabled: status === f.value, group: 'filter' }),
    ),
    { key: 'Alt+C', label: `Create ${L.one.toLowerCase()}`, icon: 'plus', primary: true, onClick: () => shell.openVoucher(base), hidden: !canCreate, disabled: !avail.ok, hint: avail.reason, group: 'go' },
    { key: 'Alt+V', label: 'Convert to Sales Invoice', icon: 'invoice', onClick: () => convert('sales'), disabled: !convertible, group: 'go' },
    { key: 'Alt+O', label: 'Convert to Sales Order', icon: 'cart', onClick: () => convert('sales_order'), hidden: base !== 'quotation', disabled: !convertible || !features.orderProcessing, hint: features.orderProcessing ? undefined : 'Turn on Order processing in Features (F11).', group: 'go' },
    { key: 'Alt+S', label: 'Accept / reject', icon: 'check-circle', onClick: () => current && nav.push('documents.quotation.status', { id: current.id }), disabled: !current || current.status === 'cancelled' || current.status === 'converted', hidden: !canAlter, group: 'go' },
  ];

  return (
    <ReportScreen
      title={L.register}
      subtitle={s ? `Open ₹ ${formatMoney(s.byStatus.open.value + s.byStatus.accepted.value)} · conversion rate ${s.conversionRatePct === null ? '—' : `${s.conversionRatePct}%`}` : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter View · Alt+V Convert to invoice · Alt+S Accept or reject · Alt+C Create · Ctrl+1/2 Quotations or proforma · Alt+E Export"
      filters={
        <Stack gap={2}>
          <SegmentedControl<DocumentStatus | 'all'> aria-label="Status" size="sm" options={STATUS_FILTERS} value={status} onChange={setStatus} />
        </Stack>
      }
      exportDef={() => ({ subtitle: status === 'all' ? undefined : STATUS_META[status].label, ...documentsExport(rows, base) })}
    >
      {q.data?.truncated ? <Banner tone="info">Only the first 5,000 documents are listed. Narrow the period (Alt+F2).</Banner> : null}
      <DataTable<DocumentRow>
        aria-label={L.register}
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(k) => setSelected(k)}
        onRowActivate={(r) => nav.push('vouchers.view', { id: r.id })}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={
          <EmptyState
            icon="file"
            title={`No ${L.many.toLowerCase()} in this period`}
            body={`Press Alt+C to create one, or change the period with Alt+F2. A ${L.one.toLowerCase()} never touches the books or the GST invoice series.`}
          />
        }
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Status dialog ─────────────────────────────

const DECISIONS: ReadonlyArray<{ value: DocumentDecision; label: string; description: string }> = [
  { value: 'accepted', label: 'Accepted', description: 'The customer accepted the offer (convert it when the order or invoice is due).' },
  { value: 'rejected', label: 'Rejected', description: 'The offer is lost — give the reason for your records.' },
  { value: 'open', label: 'Open', description: 'Awaiting the customer (clears an earlier decision).' },
];

export function DocumentStatusDialog({ params }: ScreenProps<{ id: number }>) {
  const nav = useNav();
  const toast = useToast();
  const links = useApiQuery('documents.links', { voucherId: params.id }, { staleTime: 0 });
  const save = useApiMutation('documents.quotation.setStatus', { invalidates: DOCUMENTS_INVALIDATES });
  const current = links.data?.document?.status;
  const [decision, setDecision] = useState<DocumentDecision>(current === 'accepted' ? 'rejected' : 'accepted');
  const [reason, setReason] = useState('');
  const submit = async () => {
    try {
      await save.mutate({ id: params.id, status: decision, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      toast.success(`Marked ${decision}`);
      nav.pop();
    } catch {
      // save.error / fieldErrors shown below
    }
  };
  return (
    <DialogScreen
      title="Quotation status"
      description={current ? `Now: ${STATUS_META[current].label}` : undefined}
      size="sm"
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <StatusKeys onAccept={() => void submit()} />
      <Stack gap={3}>
        {save.error && Object.keys(save.fieldErrors).length === 0 ? <Banner tone="danger">{userMessage(save.error)}</Banner> : null}
        <RadioGroup<DocumentDecision> label="Status" options={DECISIONS} value={decision} onChange={setDecision} />
        <Field label="Reason" optional={decision !== 'rejected'} required={decision === 'rejected'} error={save.fieldErrors.reason}>
          <TextArea value={reason} onValueChange={setReason} maxLength={500} autoGrow placeholder={decision === 'rejected' ? 'Price, delivery time, lost to a competitor…' : ''} data-autofocus />
        </Field>
      </Stack>
    </DialogScreen>
  );
}

function StatusKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}

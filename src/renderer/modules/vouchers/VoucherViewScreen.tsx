/**
 * 'vouchers.view' {id} — read-only rendering of a saved voucher: header, party, item lines,
 * ledger entries (Dr / Cr) with bills, cost centres and bank details, GST breakup, e-invoice and
 * e-way bill status, cancellation and audit stamps.
 *
 * Keys: Alt+A alter · Alt+P print · Alt+2 duplicate · Alt+X cancel · Alt+D delete · Alt+H history · Esc back.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney, formatPercent, formatQty, formatRate } from '../../../shared/format.ts';
import { stateLabel } from '../../../shared/gst/index.ts';
import type { GstLineView, PreviewInventoryLine, VoucherDetailEntry } from '../../../shared/types/vouchers.ts';
import { formatDateTime, Screen, useApiMutation, useApiQuery, useCan, useConfirm, useNav, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { amountInWords } from '../../../shared/words.ts';
import { Badge, Banner, Card, DataTable, KeyValueList, Stack, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { REF_TYPE_LABEL } from './lib/bills.ts';
import { MODE_LABEL } from './lib/kinds.ts';
import { INSTRUMENT_LABEL, ReasonDialog } from './entry/dialogs.tsx';
import { VOUCHER_INVALIDATES } from './entry/VoucherEntryScreen.tsx';

interface EntryRow {
  key: string;
  name: string;
  detail: string;
  debit: number;
  credit: number;
}

interface GstRateRow {
  key: string;
  label: string;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

function entryDetail(e: VoucherDetailEntry): string {
  const parts: string[] = [];
  for (const b of e.billAllocations) parts.push(`${REF_TYPE_LABEL[b.refType]}${b.billName ? ` ${b.billName}` : ''} ₹ ${formatMoney(Math.abs(b.amount))}${b.dueDate ? ` (due ${formatDate(b.dueDate, 'D-MMM-YY')})` : ''}`);
  for (const c of e.costAllocations) parts.push(`${c.costCentreName ?? 'Cost centre'} ₹ ${formatMoney(Math.abs(c.amount))}`);
  if (e.instrument) {
    const i = e.instrument;
    parts.push([INSTRUMENT_LABEL[i.type], i.number, i.date ? formatDate(i.date, 'D-MMM-YY') : '', i.bankName, i.favouring ? `favouring ${i.favouring}` : ''].filter(Boolean).join(' '));
  }
  if (e.bankDate) parts.push(`Cleared in bank on ${formatDate(e.bankDate, 'D-MMM-YY')}`);
  if (e.narration) parts.push(e.narration);
  return parts.join(' · ');
}

/** GST lines grouped by rate (per head), as on the invoice's tax summary. */
function gstByRate(lines: readonly GstLineView[]): GstRateRow[] {
  const m = new Map<string, GstRateRow>();
  for (const l of lines) {
    const key = `${l.taxability}:${l.rate}:${l.cessRate}:${l.isReverseCharge}`;
    const label = l.taxability === 'taxable' ? `${formatPercent(l.rate)}${l.cessRate ? ` + cess ${formatPercent(l.cessRate)}` : ''}${l.isReverseCharge ? ' (reverse charge)' : ''}` : l.taxability.replace('_', '-');
    const cur = m.get(key) ?? { key, label, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    cur.taxable += l.taxableValue;
    cur.igst += l.igst;
    cur.cgst += l.cgst;
    cur.sgst += l.sgst;
    cur.cess += l.cess;
    m.set(key, cur);
  }
  return [...m.values()];
}

export function VoucherViewScreen({ params }: ScreenProps<{ id: number }>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useApiQuery('vouchers.get', { id: params.id }, { staleTime: 0 });
  const v = q.data;
  const canAlter = useCan('vouchers.alter');
  const canCreate = useCan('vouchers.create');
  const canDelete = useCan('vouchers.delete');
  const canAudit = useCan('audit.view');
  const del = useApiMutation('vouchers.delete', { invalidates: VOUCHER_INVALIDATES });
  const cancelM = useApiMutation('vouchers.cancel', { invalidates: VOUCHER_INVALIDATES });
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const entries = useMemo<EntryRow[]>(
    () => (v?.entries ?? []).map((e) => ({ key: String(e.id), name: e.ledgerName, detail: entryDetail(e), debit: e.amount > 0 ? e.amount : 0, credit: e.amount < 0 ? -e.amount : 0 })),
    [v],
  );
  const gstRows = useMemo(() => gstByRate(v?.gstLines ?? []), [v]);

  const physical = v?.voucherType.baseType === 'physical_stock';
  const itemColumns = useMemo<Column<PreviewInventoryLine>[]>(
    () => [
      { key: 'lineNo', header: '#', width: 44, kind: 'number', decimals: 0 },
      {
        key: 'itemName',
        header: 'Item',
        render: (r) => (
          <span>
            {r.itemName}
            {r.batchName ? <span className="bx-muted"> · batch {r.batchName}</span> : null}
            {r.trackingRef ? <span className="bx-muted"> · note {r.trackingRef}</span> : null}
            {r.orderRef ? <span className="bx-muted"> · order {r.orderRef}</span> : null}
            {r.isConsumption ? <span className="bx-muted"> · consumed</span> : null}
          </span>
        ),
      },
      { key: 'godownName', header: 'Godown', width: 140 },
      // Physical stock stores the adjustment (counted − book): show it signed, not as a quantity.
      physical
        ? { key: 'qty', header: 'Adjustment', width: 140, align: 'right', render: (r) => <span className="bx-num">{`${r.qty > 0 ? '+' : r.qty < 0 ? '−' : ''}${formatQty(Math.abs(r.qty), 3, r.unit)}`}</span> }
        : { key: 'qty', header: 'Quantity', width: 130, align: 'right', render: (r) => <span className="bx-num">{formatQty(Math.abs(r.qty), 3, r.unit)}</span> },
      { key: 'rate', header: 'Rate', width: 110, align: 'right', render: (r) => <span className="bx-num">{formatRate(r.rate)}</span> },
      { key: 'discountPct', header: 'Disc %', width: 80, align: 'right', render: (r) => (r.discountPct ? <span className="bx-num">{formatPercent(r.discountPct)}</span> : '') },
      { key: 'hsnSac', header: 'HSN/SAC', width: 100 },
      { key: 'gstRate', header: 'GST %', width: 80, align: 'right', render: (r) => (r.gstRate === null ? '' : <span className="bx-num">{formatPercent(r.gstRate)}</span>) },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140, total: true },
    ],
    [physical],
  );
  const entryColumns = useMemo<Column<EntryRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Particulars',
        render: (r) => (
          <span className="bx-vch-view__entry">
            <span>{r.name}</span>
            {r.detail ? <span className="bx-muted bx-vch-view__detail">{r.detail}</span> : null}
          </span>
        ),
      },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 150, blankZero: true, total: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 150, blankZero: true, total: true },
    ],
    [],
  );
  const gstColumns = useMemo<Column<GstRateRow>[]>(
    () => [
      { key: 'label', header: 'GST rate' },
      { key: 'taxable', header: 'Taxable value', kind: 'amount', width: 150, total: true },
      { key: 'igst', header: 'IGST', kind: 'amount', width: 120, blankZero: true, total: true },
      { key: 'cgst', header: 'CGST', kind: 'amount', width: 120, blankZero: true, total: true },
      { key: 'sgst', header: 'SGST/UTGST', kind: 'amount', width: 120, blankZero: true, total: true },
      { key: 'cess', header: 'Cess', kind: 'amount', width: 110, blankZero: true, total: true },
    ],
    [],
  );

  const remove = async () => {
    if (!v) return;
    const ok = await confirm({
      title: `Delete ${v.voucherType.name} ${v.number ?? ''}?`.replace(/\s+\?/, '?'),
      message: 'The voucher and its GST entries are removed from the books. To keep a record instead, cancel it (Alt+X).',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await del.mutate({ id: v.id, expectedUpdatedAt: v.updatedAt });
      toast.success(`${v.voucherType.name} ${v.number ?? ''} deleted`.replace(/\s+/g, ' '));
      nav.pop();
    } catch (err) {
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };
  const cancel = async (reason: string) => {
    if (!v) return;
    setCancelError(null);
    try {
      await cancelM.mutate({ id: v.id, reason, expectedUpdatedAt: v.updatedAt });
      toast.success(`${v.voucherType.name} ${v.number ?? ''} cancelled`.replace(/\s+/g, ' '));
      setCancelling(false);
      void q.refetch();
    } catch (err) {
      setCancelError(userMessage(err));
    }
  };

  const live = !!v && !v.isCancelled;
  const irnGenerated = v?.irn.status === 'generated';
  const actions: ScreenActionItem[] = [
    { key: 'Alt+A', label: 'Alter', icon: 'edit', primary: true, onClick: () => v && nav.push('vouchers.entry', { id: v.id }), hidden: !live || !canAlter, disabled: irnGenerated, hint: irnGenerated ? 'An e-invoice has been generated: cancel it instead of altering.' : undefined },
    { key: 'Alt+P', label: 'Print', icon: 'print', onClick: () => v && nav.push('print.voucher', { id: v.id }), hidden: !v, group: 'output' },
    { key: 'Alt+2', label: 'Duplicate', icon: 'copy', onClick: () => v && nav.push('vouchers.entry', { duplicateOf: v.id }), hidden: !v || !canCreate, group: 'output' },
    {
      key: 'Alt+H',
      label: 'Edit history',
      icon: 'clock',
      onClick: () => v && nav.push('security.audit', { entityType: 'voucher', entityId: v.id, entityGuid: v.guid, label: `${v.voucherType.name} ${v.number ?? ''}`.trim() }),
      hidden: !v || !canAudit,
      group: 'output',
    },
    { key: 'Alt+X', label: 'Cancel voucher', icon: 'x-circle', onClick: () => setCancelling(true), hidden: !live || !canAlter, group: 'danger' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !v || !canDelete || irnGenerated, group: 'danger' },
  ];

  const title = v ? `${v.voucherType.name} ${v.number ?? ''}`.trim() : 'Voucher';
  const consignee = v?.consignee;
  const dispatch = v?.dispatch;
  return (
    <Screen
      title={title}
      subtitle={v ? `${formatDate(v.date)} · ${MODE_LABEL[v.mode]}` : undefined}
      icon="invoice"
      width="full"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      actions={actions}
      hint="Alt+A Alter · Alt+P Print · Alt+2 Duplicate · Esc Back"
      meta={
        v ? (
          <>
            {v.isCancelled ? <Badge tone="danger">Cancelled</Badge> : null}
            {v.isOptional ? <Badge tone="warning">Optional</Badge> : null}
            {v.isPostDated ? <Badge tone="info">Post-dated</Badge> : null}
            {!v.affectsBooks && !v.isCancelled && !v.isOptional ? <Badge tone="neutral">Not in the books</Badge> : null}
            {v.irn.status ? <Badge tone={v.irn.status === 'generated' ? 'success' : 'info'}>e-Invoice: {v.irn.status}</Badge> : null}
          </>
        ) : undefined
      }
    >
      {v ? (
        <Stack gap={4}>
          {v.cancellation ? (
            <Banner tone="warning" title="This voucher is cancelled">
              Cancelled on {formatDateTime(v.cancellation.at)}
              {v.cancellation.by ? ` by ${v.cancellation.by}` : ''}. Reason: {v.cancellation.reason}
            </Banner>
          ) : null}
          <div className="bx-vch-view__head">
            <Card title="Voucher" padding="sm">
              <KeyValueList
                items={[
                  { label: 'Type', value: v.voucherType.name },
                  { label: 'Number', value: v.number ?? '—' },
                  { label: 'Date', value: v.date, kind: 'date' },
                  { label: 'Effective date', value: v.effectiveDate ?? '', kind: 'date', hideEmpty: true },
                  { label: 'Reference', value: [v.referenceNo, v.referenceDate ? formatDate(v.referenceDate) : ''].filter(Boolean).join(' dated '), hideEmpty: true },
                  { label: 'Against invoice', value: [v.originalInvoiceNo, v.originalInvoiceDate ? formatDate(v.originalInvoiceDate) : ''].filter(Boolean).join(' dated '), hideEmpty: true },
                  { label: 'Reason', value: v.noteReason ?? '', hideEmpty: true },
                  { label: 'Amount', value: v.totals.amount, kind: 'amount', strong: true },
                ]}
              />
            </Card>
            {v.partyLedgerName || v.party.name ? (
              <Card title="Party" padding="sm">
                <KeyValueList
                  items={[
                    { label: 'Name', value: v.party.name ?? v.partyLedgerName ?? '' },
                    { label: 'Ledger', value: v.partyLedgerName && v.partyLedgerName !== v.party.name ? v.partyLedgerName : '', hideEmpty: true },
                    { label: 'GSTIN', value: v.party.gstin ?? '', hideEmpty: true },
                    { label: 'Address', value: v.party.address ?? '', hideEmpty: true },
                    { label: 'State', value: v.party.stateCode ? stateLabel(v.party.stateCode) : '', hideEmpty: true },
                    { label: 'Place of supply', value: v.placeOfSupply ? stateLabel(v.placeOfSupply) : '', hideEmpty: true },
                    { label: 'Reverse charge', value: v.isReverseCharge ? 'Yes' : '', hideEmpty: true },
                  ]}
                />
              </Card>
            ) : null}
            {consignee || dispatch || v.ewayBill.number || v.irn.irn ? (
              <Card title="Dispatch & e-documents" padding="sm">
                <KeyValueList
                  items={[
                    { label: 'Consignee', value: [consignee?.name, consignee?.stateCode ? stateLabel(consignee.stateCode) : ''].filter(Boolean).join(', '), hideEmpty: true },
                    { label: 'Vehicle', value: dispatch?.vehicleNo ?? '', hideEmpty: true },
                    { label: 'Transporter', value: dispatch?.transporterName ?? '', hideEmpty: true },
                    { label: 'Distance', value: dispatch?.distanceKm ? `${dispatch.distanceKm} km` : '', hideEmpty: true },
                    { label: 'e-Way bill', value: v.ewayBill.number ? `${v.ewayBill.number}${v.ewayBill.validUpto ? ` (valid up to ${formatDate(v.ewayBill.validUpto)})` : ''}` : '', hideEmpty: true },
                    { label: 'IRN', value: v.irn.irn ?? '', hideEmpty: true },
                    { label: 'Ack no.', value: v.irn.ackNo ? `${v.irn.ackNo}${v.irn.ackDate ? ` · ${formatDate(v.irn.ackDate.slice(0, 10))}` : ''}` : '', hideEmpty: true },
                  ]}
                />
              </Card>
            ) : null}
          </div>

          {v.inventory.length > 0 ? (
            <section aria-label="Items">
              <h2 className="bx-vch-grid__title">Items</h2>
              <DataTable<PreviewInventoryLine> aria-label="Items" columns={itemColumns} rows={v.inventory} getRowKey={(r) => `${r.lineNo}-${r.itemId}-${r.isConsumption ? 'c' : 'p'}`} density="compact" />
            </section>
          ) : null}

          {entries.length > 0 ? (
            <section aria-label="Accounting entries">
              <h2 className="bx-vch-grid__title">Accounting entries</h2>
              <DataTable<EntryRow> aria-label="Accounting entries" columns={entryColumns} rows={entries} getRowKey={(r) => r.key} density="compact" autoFocus />
            </section>
          ) : v.isCancelled ? null : (
            <p className="bx-muted">This voucher records stock only — it has no accounting entries.</p>
          )}

          {gstRows.length > 0 ? (
            <section aria-label="GST breakup">
              <h2 className="bx-vch-grid__title">GST</h2>
              <DataTable<GstRateRow> aria-label="GST breakup" columns={gstColumns} rows={gstRows} getRowKey={(r) => r.key} density="compact" />
            </section>
          ) : null}

          <div className="bx-vch-view__foot">
            {v.totals.amount > 0 && !v.isCancelled ? <p className="bx-vch-totals__words">{amountInWords(v.totals.amount)}</p> : null}
            {v.narration ? (
              <p>
                <span className="bx-muted">Narration: </span>
                {v.narration}
              </p>
            ) : null}
            <p className="bx-muted">
              Entered by {v.createdBy.name ?? 'unknown'} on {formatDateTime(v.createdAt)}
              {v.updatedAt !== v.createdAt ? ` · last changed by ${v.updatedBy.name ?? 'unknown'} on ${formatDateTime(v.updatedAt)}` : ''}
            </p>
          </div>
        </Stack>
      ) : null}
      {cancelling && v ? (
        <ReasonDialog
          title={`Cancel ${v.voucherType.name} ${v.number ?? ''}?`.replace(/\s+\?/, '?')}
          message="The voucher keeps its number but its amounts leave the books and stock. This cannot be undone."
          confirmLabel="Cancel voucher"
          required
          busy={cancelM.pending}
          error={cancelError}
          onConfirm={(r) => void cancel(r)}
          onClose={() => setCancelling(false)}
        />
      ) : null}
    </Screen>
  );
}

/**
 * Documents pieces shown by other screens through ModuleDef extension points:
 *  - RecurringDueNotice  (gatewayNotices) — "N recurring vouchers are due" when the company opens;
 *  - DocumentsCard       (dashboardCards) — recurring due, open quotations, unbilled challans;
 *  - VoucherDocumentsPanel (voucherPanels) — links of the voucher on 'vouchers.view' and its keys:
 *      Alt+V convert to Sales Invoice · Alt+O convert to Sales Order (quotation) · Alt+S status ·
 *      Alt+R make recurring · Alt+L pre-close order.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { VoucherRef } from '../../../shared/types/documents.ts';
import { useApiMutation, useApiQuery, useCan, useCompany, useFeatures, useNav, userMessage, useScreenActions, useWorkingDate } from '../../app/index.ts';
import type { ScreenActionItem, VoucherPanelProps } from '../../app/index.ts';
import { Badge, Banner, Button, Card, DataTable, Inline, KeyValueList, Stack, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import type { OrderClosureRow } from '../../../shared/types/documents.ts';
import { canConvert, DOCUMENTS_INVALIDATES, noticeStorageKey, STATUS_META } from './lib/model.ts';

function readFlag(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, '1');
  } catch {
    // Storage unavailable: the notice simply shows again next time.
  }
}

// ───────────────────────────── Gateway notice ─────────────────────────────

/** Shown on the Gateway when the company opens; dismissed for the rest of the working day. */
export function RecurringDueNotice() {
  const can = useCan('vouchers.view');
  const company = useCompany();
  const { date } = useWorkingDate();
  const nav = useNav();
  const key = noticeStorageKey(company.id, date);
  const [dismissed, setDismissed] = useState(() => readFlag(key));
  const q = useApiQuery('documents.summary', { asOf: date }, { enabled: can && !dismissed, staleTime: 60_000 });
  const s = q.data;
  if (!can || dismissed || !s || s.recurringDue === 0) return null;
  return (
    <Banner
      tone="info"
      icon="clock"
      title={`${s.recurringDue} recurring voucher${s.recurringDue === 1 ? ' is' : 's are'} due`}
      onDismiss={() => {
        writeFlag(key);
        setDismissed(true);
      }}
      action={
        <Button size="sm" variant="primary" onClick={() => nav.push('documents.recurring.due')}>
          Review &amp; post
        </Button>
      }
    >
      Rent, retainers and other repeating entries up to {formatDate(date)} — ₹ {formatMoney(s.recurringDueValue)} before tax. Nothing is posted until you review them.
    </Banner>
  );
}

// ───────────────────────────── Dashboard card ─────────────────────────────

export function DocumentsCard({ className }: { className?: string }) {
  const can = useCan('vouchers.view');
  const { date } = useWorkingDate();
  const nav = useNav();
  const q = useApiQuery('documents.summary', { asOf: date }, { enabled: can, staleTime: 30_000 });
  const s = q.data;
  if (!can) return null;
  const go = (screen: string, params?: Record<string, unknown>) => (nav.canOpen(screen) ? () => nav.push(screen, params ?? {}) : undefined);
  const row = (label: string, value: string, onClick: (() => void) | undefined, tone?: 'warning' | 'info') => (
    <Inline gap={2} justify="between" key={label}>
      <span>{label}</span>
      {onClick ? (
        <Button size="sm" variant="link" onClick={onClick}>
          {tone ? <Badge tone={tone} size="sm">{value}</Badge> : value}
        </Button>
      ) : (
        <span className="bx-num">{value}</span>
      )}
    </Inline>
  );
  return (
    <Card className={className} title="Documents" subtitle="Recurring vouchers, quotations, unbilled challans" padding="sm">
      {s ? (
        <Stack gap={2}>
          {row('Recurring vouchers due', String(s.recurringDue), go('documents.recurring.due'), s.recurringDue > 0 ? 'warning' : undefined)}
          {row('Open quotations / proforma', String(s.quotationsOpen), go('documents.quotations'))}
          {row('Expiring within 7 days', String(s.quotationsExpiringSoon), go('documents.quotations', { status: 'open' }), s.quotationsExpiringSoon > 0 ? 'info' : undefined)}
          {row('Challans unbilled over 7 days', String(s.unbilledDeliveryNotes), go('documents.billsPending', { kind: 'sales' }), s.unbilledDeliveryNotes > 0 ? 'warning' : undefined)}
          {s.unbilledValue > 0 ? <p className="bx-muted">Unbilled challan value ₹ {formatMoney(s.unbilledValue)} — a tax invoice is due on removal of goods (CGST s.31).</p> : null}
        </Stack>
      ) : (
        <p className="bx-muted">{q.error ? userMessage(q.error) : 'Loading…'}</p>
      )}
    </Card>
  );
}

// ───────────────────────────── Voucher view panel ─────────────────────────────

const refText = (r: VoucherRef): string => `${r.voucherTypeName} ${r.number ?? ''} dated ${formatDate(r.date)}${r.isCancelled ? ' (cancelled)' : ''}`.replace(/\s+/g, ' ');

export function VoucherDocumentsPanel({ voucherId, baseType, isCancelled, isOptional, updatedAt }: VoucherPanelProps) {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canCreate = useCan('vouchers.create');
  const canAlter = useCan('vouchers.alter');
  const q = useApiQuery('documents.links', { voucherId }, { staleTime: 0 });
  // Refetch when the voucher is saved again (updatedAt changes).
  const seen = useRef(updatedAt);
  const { refetch } = q;
  useEffect(() => {
    if (seen.current === updatedAt) return;
    seen.current = updatedAt;
    void refetch();
  }, [updatedAt, refetch]);
  const reopen = useApiMutation('documents.order.reopen', { invalidates: DOCUMENTS_INVALIDATES });
  const l = q.data;
  const isDoc = baseType === 'quotation' || baseType === 'proforma';
  const isOrder = baseType === 'sales_order' || baseType === 'purchase_order';
  const convertible = !!l?.document && canConvert(l.document.status) && canCreate;
  const convert = (target: 'sales' | 'sales_order') => nav.push('vouchers.entry', { draft: { sourceId: voucherId, targetBaseType: target } });

  const actions: ScreenActionItem[] = [
    { key: 'Alt+V', label: 'Convert to Sales Invoice', icon: 'invoice', onClick: () => convert('sales'), hidden: !isDoc || isCancelled, disabled: !convertible, hint: l?.document && !convertible ? `This document is ${STATUS_META[l.document.status].label.toLowerCase()}.` : undefined, group: 'documents' },
    {
      key: 'Alt+O',
      label: 'Convert to Sales Order',
      icon: 'cart',
      onClick: () => convert('sales_order'),
      hidden: baseType !== 'quotation' || isCancelled,
      disabled: !convertible || !features.orderProcessing,
      hint: !features.orderProcessing ? 'Turn on Order processing in Features (F11) to use sales orders.' : undefined,
      group: 'documents',
    },
    { key: 'Alt+S', label: 'Accept / reject', icon: 'check-circle', onClick: () => nav.push('documents.quotation.status', { id: voucherId }), hidden: !isDoc || isCancelled || !canAlter, group: 'documents' },
    { key: 'Alt+R', label: 'Make recurring', icon: 'refresh', onClick: () => nav.push('documents.recurring.form', { sourceVoucherId: voucherId }), hidden: isCancelled || !canCreate || baseType === 'physical_stock', group: 'documents' },
    { key: 'Alt+L', label: 'Pre-close order', icon: 'x-circle', onClick: () => nav.push('documents.order.preclose', { orderId: voucherId }), hidden: !isOrder || isCancelled || isOptional || !canAlter, group: 'documents' },
  ];
  useScreenActions(actions);

  const closureColumns: Column<OrderClosureRow>[] = [
    { key: 'itemName', header: 'Item', minWidth: 160 },
    { key: 'closedQty', header: 'Closed qty', width: 120, align: 'right', value: (r) => r.closedQty, render: (r) => <span className="bx-num">{`${r.closedQty} ${r.unit}`}</span> },
    { key: 'date', header: 'Closed on', kind: 'date', width: 110 },
    { key: 'reason', header: 'Reason', minWidth: 200 },
    { key: 'createdBy', header: 'By', width: 120, value: (r) => r.createdBy ?? '' },
  ];

  if (!l) return null;
  const lines: Array<{ label: string; value: ReactNode }> = [];
  if (l.document) {
    lines.push({ label: 'Status', value: <Badge tone={STATUS_META[l.document.status].tone}>{STATUS_META[l.document.status].label}</Badge> });
    if (l.document.validUntil) lines.push({ label: 'Valid until', value: formatDate(l.document.validUntil) });
    if (l.document.reason) lines.push({ label: 'Reason', value: l.document.reason });
  }
  if (l.applicableUpto) lines.push({ label: 'Applicable up to', value: `${formatDate(l.applicableUpto)} (counts in scenario reports up to this date)` });
  if (l.convertedFrom) {
    const from = l.convertedFrom;
    lines.push({ label: 'Converted from', value: <Button size="sm" variant="link" onClick={() => nav.push('vouchers.view', { id: from.id })}>{refText(from)}</Button> });
  }
  for (const t of l.convertedTo) lines.push({ label: 'Converted into', value: <Button size="sm" variant="link" onClick={() => nav.push('vouchers.view', { id: t.id })}>{refText(t)}</Button> });
  if (l.recurring) {
    const r = l.recurring;
    lines.push({ label: 'Recurring voucher', value: <Button size="sm" variant="link" onClick={() => nav.push('documents.recurring.form', { id: r.templateId })}>{`${r.templateName} · ${r.periodKey}`}</Button> });
  }
  for (const t of l.templates) lines.push({ label: 'Recurs as', value: <Button size="sm" variant="link" onClick={() => nav.push('documents.recurring.form', { id: t.id })}>{`${t.name}${t.isActive ? '' : ' (paused)'}`}</Button> });
  if (lines.length === 0 && l.closures.length === 0) return null;

  const doReopen = async () => {
    try {
      await reopen.mutate({ orderId: voucherId });
      toast.success('Order reopened', { message: 'The closed balance is pending again.' });
      void q.refetch();
    } catch (err) {
      toast.error('Could not reopen', { message: userMessage(err) });
    }
  };
  return (
    <Stack gap={3}>
      {lines.length > 0 ? (
        <Card title="Linked documents" padding="sm">
          <KeyValueList items={lines.map((x, i) => ({ key: String(i), label: x.label, value: x.value }))} />
        </Card>
      ) : null}
      {l.closures.length > 0 ? (
        <section aria-label="Pre-closed balances">
          <Inline gap={2} justify="between">
            <h2 className="bx-vch-grid__title">Pre-closed balances</h2>
            {canAlter ? (
              <Button size="sm" icon="undo" onClick={() => void doReopen()} loading={reopen.pending}>
                Reopen order
              </Button>
            ) : null}
          </Inline>
          <DataTable<OrderClosureRow> aria-label="Pre-closed balances" columns={closureColumns} rows={l.closures} getRowKey={(r) => String(r.itemId)} density="compact" />
        </section>
      ) : null}
    </Stack>
  );
}

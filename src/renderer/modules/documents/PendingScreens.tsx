/**
 * 'documents.billsPending' {kind?: 'sales' | 'purchase', partyLedgerId?} — Sales Bills Pending / Purchase
 * Bills Pending (Tally: Statements of Inventory): delivery / receipt notes (and rejections) not yet
 * fully invoiced, as on the period's end date, with quantities, value and ageing. Views: note lines,
 * by party, by item. Enter on a line opens the note; on a party / item it lists that party's / item's lines.
 * Keys: Ctrl+1 Sales · Ctrl+2 Purchase · Ctrl+3 Lines · Ctrl+4 By party · Ctrl+5 By item ·
 * Alt+I Invoice now (sales) / Enter bill (purchase) · Alt+F2 Date · Alt+E Export · Alt+P Print.
 *
 * 'documents.order.preclose' {orderId, kind?} (dialog) — close the balance of a sales / purchase order
 * that will not be supplied, per item, with a date and a reason (Tally "Pre-close order"). The order
 * itself is not altered; reopen from the voucher view. Ctrl+A Save.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { BillsPendingKind, BillsPendingRow } from '../../../shared/types/documents.ts';
import type { OrderKind } from '../../../shared/types/stock.ts';
import { DialogScreen, ReportScreen, useApiMutation, useApiQuery, useCan, useNav, usePeriod, userMessage, useWorkingDate } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, DateInput, EmptyState, Field, QuantityInput, SegmentedControl, Stack, TextArea, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import {
  AGE_BUCKETS,
  ageBucket,
  BILLS_LABEL,
  billsGroupExport,
  billsPendingExport,
  DOCUMENTS_INVALIDATES,
  groupBills,
  NOTE_LABEL,
  precloseItems,
  precloseLines,
  qtyText,
} from './lib/model.ts';
import type { BillsGroupRow, BillsView } from './lib/model.ts';

const KINDS: ReadonlyArray<{ value: BillsPendingKind; label: string }> = [
  { value: 'sales', label: 'Sales' },
  { value: 'purchase', label: 'Purchase' },
];
const VIEWS: ReadonlyArray<{ value: BillsView; label: string }> = [
  { value: 'lines', label: 'Note lines' },
  { value: 'party', label: 'By party' },
  { value: 'item', label: 'By item' },
];
const EMPTY: readonly BillsPendingRow[] = [];

export interface BillsPendingParams {
  kind?: BillsPendingKind;
  partyLedgerId?: number;
}

export function BillsPendingScreen({ params }: ScreenProps<BillsPendingParams>) {
  const period = usePeriod();
  const { date: workingDate } = useWorkingDate();
  const nav = useNav();
  const canView = useCan('vouchers.view');
  const canCreate = useCan('vouchers.create');
  const [kind, setKind] = useState<BillsPendingKind>(params?.kind === 'purchase' ? 'purchase' : 'sales');
  const [view, setView] = useState<BillsView>('lines');
  const [filter, setFilter] = useState<{ by: 'party' | 'item'; key: string; name: string } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useApiQuery(
    'documents.billsPending',
    { kind, asOf: period.to, ...(params?.partyLedgerId !== undefined ? { partyLedgerId: params.partyLedgerId } : {}) },
    { keepPrevious: true },
  );
  const all = q.data?.rows ?? EMPTY;
  const lines = useMemo(
    () => (filter ? all.filter((r) => (filter.by === 'party' ? `p:${r.partyLedgerId ?? r.partyName}` : `i:${r.itemId}`) === filter.key) : all),
    [all, filter],
  );
  const groups = useMemo(() => (view === 'lines' ? [] : groupBills(all, view)), [all, view]);
  const L = BILLS_LABEL[kind];
  const current = view === 'lines' ? (lines.find((r) => r.key === cursor) ?? lines[0] ?? null) : null;

  const switchKind = (k: BillsPendingKind) => {
    setKind(k);
    setFilter(null);
  };
  const switchView = (v: BillsView) => {
    setView(v);
    if (v !== 'lines') setFilter(null);
  };
  const invoice = (r: BillsPendingRow | null) => {
    if (!r || !canCreate) return;
    nav.push('vouchers.entry', { baseType: r.invoiceBaseType, draft: { sourceId: r.noteId, targetBaseType: r.invoiceBaseType, date: workingDate } });
  };

  const lineColumns = useMemo<Column<BillsPendingRow>[]>(
    () => [
      { key: 'noteDate', header: 'Date', kind: 'date', width: 105, sortable: true },
      { key: 'note', header: 'Note', width: 150, value: (r) => `${NOTE_LABEL[r.noteBaseType] ?? r.noteTypeName} ${r.noteNo ?? ''}`.trim() },
      { key: 'partyName', header: L.party, minWidth: 160, sortable: true },
      { key: 'itemName', header: 'Item', minWidth: 160, sortable: true },
      { key: 'qty', header: 'Quantity', width: 110, align: 'right', value: (r) => r.qty, render: (r) => <span className="bx-num">{qtyText(r.qty, r.unit)}</span> },
      { key: 'billedQty', header: 'Billed', width: 110, align: 'right', value: (r) => r.billedQty, render: (r) => <span className="bx-num">{r.billedQty ? qtyText(r.billedQty, r.unit) : ''}</span> },
      { key: 'pendingQty', header: 'Pending', width: 110, align: 'right', value: (r) => r.pendingQty, render: (r) => <span className="bx-num">{qtyText(r.pendingQty, r.unit)}</span> },
      { key: 'pendingValue', header: 'Pending value', kind: 'amount', width: 140, total: true, sortable: true },
      {
        key: 'ageDays',
        header: 'Age',
        width: 120,
        value: (r) => r.ageDays,
        sortable: true,
        render: (r) => (
          <Badge tone={r.ageDays > 30 ? 'danger' : r.ageDays > 7 ? 'warning' : 'neutral'} size="sm">
            {`${r.ageDays} day${r.ageDays === 1 ? '' : 's'}`}
          </Badge>
        ),
      },
    ],
    [L],
  );
  const groupColumns = useMemo<Column<BillsGroupRow>[]>(
    () => [
      { key: 'name', header: view === 'party' ? L.party : 'Item', minWidth: 200, sortable: true },
      { key: 'pendingQty', header: 'Pending qty', width: 120, align: 'right', hidden: view !== 'item', value: (g) => g.pendingQty ?? 0, render: (g) => <span className="bx-num">{qtyText(g.pendingQty ?? 0, g.unit)}</span> },
      { key: 'notes', header: 'Notes', kind: 'number', width: 80 },
      ...AGE_BUCKETS.map((b): Column<BillsGroupRow> => ({ key: `b:${b}`, header: b, kind: 'amount', width: 130, blankZero: true, value: (g) => g.buckets[b], total: true })),
      { key: 'pendingValue', header: 'Pending value', kind: 'amount', width: 150, total: true, sortable: true },
    ],
    [view, L],
  );
  const t = q.data?.totals;
  const lineFooter = useMemo<FooterRow[]>(
    () => (lines.length > 0 ? [{ key: 'total', tone: 'total', cells: { partyName: filter ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : `${t?.notes ?? 0} notes · ${t?.parties ?? 0} parties`, pendingValue: lines.reduce((a, r) => a + r.pendingValue, 0) } }] : []),
    [lines, filter, t],
  );

  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Sales bills pending', icon: 'invoice', onClick: () => switchKind('sales'), disabled: kind === 'sales', group: 'view' },
    { key: 'Ctrl+2', label: 'Purchase bills pending', icon: 'cart', onClick: () => switchKind('purchase'), disabled: kind === 'purchase', group: 'view' },
    { key: 'Ctrl+3', label: filter ? 'All note lines' : 'Note lines', icon: 'list', onClick: () => { setView('lines'); setFilter(null); }, disabled: view === 'lines' && !filter, group: 'view' },
    { key: 'Ctrl+4', label: 'By party', icon: 'users', onClick: () => switchView('party'), disabled: view === 'party', group: 'view' },
    { key: 'Ctrl+5', label: 'By item', icon: 'box', onClick: () => switchView('item'), disabled: view === 'item', group: 'view' },
    { key: 'Alt+I', label: L.invoice, icon: 'invoice', primary: true, onClick: () => invoice(current), disabled: !current, hidden: !canCreate, hint: 'Pre-fills the invoice with the pending quantities, tracked against the note', group: 'go' },
  ];

  const ageing = t ? AGE_BUCKETS.map((b) => ({ b, v: all.filter((r) => ageBucket(r.ageDays) === b).reduce((a, r) => a + r.pendingValue, 0) })) : [];

  return (
    <ReportScreen
      title={L.title}
      subtitle={
        t
          ? `₹ ${formatMoney(t.pendingValue)} unbilled · ${ageing.filter((x) => x.v !== 0).map((x) => `${x.b} ₹ ${formatMoney(x.v)}`).join(' · ') || 'nothing pending'}`
          : undefined
      }
      periodMode="asOn"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint={`Enter ${view === 'lines' ? 'Open note' : 'Show lines'} · Alt+I ${kind === 'sales' ? 'Invoice now' : 'Enter bill'} · Ctrl+3/4/5 Lines, party, item · Alt+F2 Date · Alt+E Export`}
      filters={
        <Stack gap={2}>
          <SegmentedControl<BillsPendingKind> aria-label="Sales or purchase" size="sm" options={KINDS} value={kind} onChange={switchKind} />
          <SegmentedControl<BillsView> aria-label="View" size="sm" options={VIEWS} value={view} onChange={switchView} />
        </Stack>
      }
      exportDef={() => (view === 'lines' ? { subtitle: filter ? filter.name : undefined, ...billsPendingExport(lines, kind) } : billsGroupExport(groups, view, kind))}
    >
      <Stack gap={3} grow>
        {kind === 'sales' && t && t.olderThan7Days > 0 ? (
          <Banner tone="warning" title={`${t.olderThan7Days} delivery note${t.olderThan7Days === 1 ? '' : 's'} unbilled for more than 7 days`}>
            For a taxable supply of goods the tax invoice is due before or at the time of removal (CGST Act s.31(1)); a delivery challan covers only movements such as job work, goods sent on approval, transport for reasons other than supply, or goods whose quantity is not known at removal (CGST Rule 55). Invoice supplies now with Alt+I.
          </Banner>
        ) : null}
        {filter ? (
          <Banner tone="info" onDismiss={() => setFilter(null)}>
            Showing {filter.by === 'party' ? L.party.toLowerCase() : 'item'} {filter.name} only — Ctrl+3 shows every line.
          </Banner>
        ) : null}
        {view === 'lines' ? (
          <DataTable<BillsPendingRow>
            aria-label={L.title}
            autoFocus
            columns={lineColumns}
            rows={lines}
            getRowKey={(r) => r.key}
            selectedKey={current?.key ?? null}
            onSelect={(k) => setCursor(k)}
            onRowActivate={(r) => canView && nav.push('vouchers.view', { id: r.noteId })}
            footerRows={lineFooter.length > 0 ? lineFooter : undefined}
            loading={q.loading}
            empty={<EmptyState icon="check-circle" title="Everything is billed" body={`No ${kind === 'sales' ? 'delivery notes or rejections in' : 'receipt notes or rejections out'} with an unbilled quantity as on ${formatDate(period.to)}.`} />}
          />
        ) : (
          <DataTable<BillsGroupRow>
            aria-label={`${L.title} ${view === 'party' ? 'by party' : 'by item'}`}
            autoFocus
            columns={groupColumns}
            rows={groups}
            getRowKey={(g) => g.key}
            onRowActivate={(g) => {
              setFilter({ by: view === 'party' ? 'party' : 'item', key: g.key, name: g.name });
              setView('lines');
            }}
            loading={q.loading}
            empty={<EmptyState icon="check-circle" title="Everything is billed" body={`Nothing pending as on ${formatDate(period.to)}.`} />}
          />
        )}
      </Stack>
    </ReportScreen>
  );
}

// ───────────────────────────── Pre-close dialog ─────────────────────────────

export interface PrecloseParams {
  orderId: number;
  kind?: OrderKind;
  /** Pre-select one item (from a Pending Orders line): the others start at 0. */
  itemId?: number;
}

export function OrderPrecloseDialog({ params }: ScreenProps<PrecloseParams>) {
  const nav = useNav();
  const toast = useToast();
  const { date: workingDate } = useWorkingDate();
  const [date, setDate] = useState<string | null>(workingDate);
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState<Record<number, number | null>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const kind: OrderKind = params.kind ?? 'sales';
  const q = useApiQuery('stock.pendingOrders', { kind, asOf: date ?? workingDate }, { keepPrevious: true, staleTime: 0 });
  const lines = useMemo(() => precloseLines(q.data?.rows ?? [], params.orderId), [q.data, params.orderId]);
  const order = q.data?.rows.find((r) => r.orderId === params.orderId);
  const save = useApiMutation('documents.order.preclose', { invalidates: DOCUMENTS_INVALIDATES });
  const qtyOf = (itemId: number, pending: number): number | null => (itemId in qty ? qty[itemId] : params.itemId !== undefined && params.itemId !== itemId ? 0 : pending);

  const submit = async () => {
    if (save.pending) return;
    if (!reason.trim()) {
      setProblem('Give the reason the balance will not be supplied (customer cancelled, item discontinued …).');
      return;
    }
    const chosen = Object.fromEntries(lines.map((l) => [l.itemId, qtyOf(l.itemId, l.pendingQty)]));
    const { items, problem: p } = precloseItems(lines, chosen);
    if (p) {
      setProblem(p.message);
      return;
    }
    if (items.length === 0) {
      setProblem('Enter the quantity to close for at least one item.');
      return;
    }
    try {
      await save.mutate({ orderId: params.orderId, reason: reason.trim(), ...(date ? { date } : {}), items });
      toast.success('Order pre-closed', { message: 'The closed balance has left the pending orders. Reopen it from the order (voucher view) if needed.' });
      nav.pop({ orderId: params.orderId });
    } catch {
      // save.error / fieldErrors shown below
    }
  };
  const ref = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });

  return (
    <DialogScreen
      title="Pre-close Order"
      description={order ? `${kind === 'sales' ? 'Sales' : 'Purchase'} order ${order.orderNo ?? ''} dated ${formatDate(order.orderDate)} · ${order.partyName}` : undefined}
      size="md"
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()} disabled={lines.length === 0}>
            Pre-close
          </Button>
        </>
      }
    >
      <PrecloseKeys onAccept={() => void submit()} />
      <div ref={ref}>
        <Stack gap={3}>
          {problem || (save.error && Object.keys(save.fieldErrors).length === 0) ? <Banner tone="danger">{problem ?? userMessage(save.error)}</Banner> : null}
          {q.error ? <Banner tone="danger">{userMessage(q.error)}</Banner> : null}
          {!q.loading && lines.length === 0 ? (
            <EmptyState size="sm" icon="check-circle" title="Nothing pending on this order" body={`As on ${formatDate(date ?? workingDate)} the order has no balance to close (it may already be delivered or pre-closed).`} />
          ) : null}
          {lines.map((l) => (
            <Field key={l.itemId} label={l.itemName} hint={`Pending ${qtyText(l.pendingQty, l.unit)} — 0 keeps it open`} error={save.fieldErrors[`items[${lines.indexOf(l)}].qty`]}>
              <QuantityInput
                value={qtyOf(l.itemId, l.pendingQty)}
                onChange={(v) => {
                  setQty((m) => ({ ...m, [l.itemId]: v }));
                  setProblem(null);
                }}
                unit={l.unit}
                decimals={3}
                max={l.pendingQty}
              />
            </Field>
          ))}
          <Field label="Closed on" required error={save.fieldErrors.date} hint="Deliveries after this date do not count against the closed balance.">
            <DateInput value={date} onChange={setDate} referenceDate={workingDate} />
          </Field>
          <Field label="Reason" required error={save.fieldErrors.reason}>
            <TextArea value={reason} onValueChange={(v) => { setReason(v); setProblem(null); }} maxLength={500} autoGrow placeholder="Customer cancelled the balance, item discontinued …" />
          </Field>
        </Stack>
      </div>
    </DialogScreen>
  );
}

function PrecloseKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}

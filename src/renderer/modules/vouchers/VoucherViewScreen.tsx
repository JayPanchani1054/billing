/**
 * 'vouchers.view' {id} — read-only rendering of a saved voucher.
 *
 * 2.1 (SPEC-21 §1.5, D21): the voucher is the document. Title row: the h1 (type and number), the date and
 * state words only (Cancelled the one danger word). Then the party in one line (with its GSTIN) and the
 * references in one line; the item lines (columns empty or the same on every line hidden); the totals
 * block of an item invoice (Taxable · tax heads · Round off · Total ₹); the amount in words and the
 * narration; then the panels of other modules. The Dr / Cr entries (with bills, cost centres and bank
 * details) are shown by default for vouchers without item lines and behind **Alt+F1 Detailed** for
 * invoices; Detailed also adds the GST rate-wise table, addresses, dispatch / e-invoice details and the
 * "Entered by … · last changed by …" line. The choice is remembered (`pevqori.ui` `voucherDetailed`).
 *
 * 2.2: a line's own description, typed on this voucher, shows as typed (line breaks kept) on a muted line
 * under its name — an item line's description (never the stock item's master description) and a Dr / Cr
 * line's narration, which no longer joins the details line (bills, cost centres, instrument, bank date)
 * under it. A row with a line under its name keeps every cell on the name's line (lib/voucherView.ts
 * `lineDescription`, `viewEntryRows`). The Items and Accounting entries tables are never windowed
 * (`virtualize={false}`): they are as tall as their rows (the page scrolls, not the table), so windowing
 * saves nothing, and its one-row-height arithmetic cannot place rows of different heights — a described
 * first line left the last lines of a 250-line voucher unrendered.
 *
 * 2.2: a voucher that posts no ledger entries — a sales / purchase order, a quotation, a proforma, a note
 * with charges — keeps its ledger lines only as entered (`input.ledgers`; they print from there). They are its
 * Particulars: each ledger (named as `accounts.ledger.get` answers, '…' until then), the line's description
 * under it like an entry's, and its amount as entered (+ adds to the document's value, − deducts), in the
 * entries' place and by the same rule — by default without item lines (an accounting quotation's lines),
 * behind Detailed beside them (an order's "Charges & discounts", like an invoice's entries) — never on a
 * cancelled voucher, never a line without an amount (lib/voucherView.ts `viewLineRows`, `viewSections().lines`).
 *
 * Keys: Alt+A alter · Alt+P print · Alt+F1 detailed · Alt+2 duplicate · Alt+X cancel · Alt+D delete ·
 * Alt+H history · Ctrl+R change the number (2.0: vouchers.renumber + vouchers.alter → 'vouchers.renumber';
 * the voucher is re-saved as entered, so its entries are unchanged) · Esc back.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney, formatPercent, formatQty, formatRate } from '../../../shared/format.ts';
import { stateLabel } from '../../../shared/gst/index.ts';
import type { GstLineView, PreviewInventoryLine, VoucherNumberOverride } from '../../../shared/types/vouchers.ts';
import { ApiError, formatDateTime, isApiError, Screen, useApiMutation, useApiQuery, useCan, useCompany, useConfirm, useModules, useNav, userMessage, withConfirmation } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { setUiPrefs, useUiPrefs } from '../../app/preferences.ts';
import { amountInWords } from '../../../shared/words.ts';
import { Banner, DataTable, EmptyState, Inline, KeyValueList, Panel, Stack, useToast } from '../../ui/index.ts';
import type { Column, KeyValueItem } from '../../ui/index.ts';
import {
  hiddenItemColumns,
  lineDescription,
  partyLine,
  referenceLine,
  viewEntryRows,
  viewLineLedgerIds,
  viewLineRows,
  viewSections,
  viewStateWords,
  viewTotals,
} from './lib/voucherView.ts';
import type { ViewEntryRow, ViewLineRow } from './lib/voucherView.ts';
import { INSTRUMENT_LABEL, ReasonDialog } from './entry/dialogs.tsx';
import { VOUCHER_INVALIDATES } from './entry/VoucherEntryScreen.tsx';
import { ChangeNumberDialog } from './ChangeNumberDialog.tsx';
import { changeNumberAvailability, isGstDocType, renumberedText } from './lib/changeNumber.ts';
import { confirmationRequest } from './lib/errorPaths.ts';
import { useLedgerDetails } from './pickers/hooks.ts';

/** A row with a line under its name (a description, or bills / cost centres / bank details): every cell stays on the name's line. */
const MULTILINE_ROW = 'bx-vch-view__row--multiline';

const NO_LEDGER_IDS: readonly number[] = [];

/**
 * The Particulars cell of the Dr / Cr entries and of the lines of a voucher that posts none: the ledger, then
 * its description (2.2: its own line) and an entry's bills / cost centres / bank details.
 */
function particulars(r: Pick<ViewEntryRow, 'name' | 'description'> & { detail?: string }): ReactNode {
  return (
    <>
      <div className="bx-vch-view__name">{r.name}</div>
      {r.description ? <div className="bx-muted bx-vch-view__desc">{r.description}</div> : null}
      {r.detail ? <div className="bx-muted bx-vch-view__detail">{r.detail}</div> : null}
    </>
  );
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
  // Alt+F1 Detailed / condensed, remembered on this computer (SPEC-21 §4.5).
  const detailed = useUiPrefs().voucherDetailed;
  // Other modules' panels for this voucher (ModuleDef.voucherPanels: conversion links, recurring, pre-close).
  const modules = useModules();
  const panels = useMemo(() => modules.flatMap((m) => (m.voucherPanels ?? []).map((C, i) => ({ key: `${m.id}:${i}`, C }))), [modules]);
  const canAlter = useCan('vouchers.alter');
  const canCreate = useCan('vouchers.create');
  const canDelete = useCan('vouchers.delete');
  const canAudit = useCan('audit.view');
  const del = useApiMutation('vouchers.delete', { invalidates: VOUCHER_INVALIDATES });
  const cancelM = useApiMutation('vouchers.cancel', { invalidates: VOUCHER_INVALIDATES });
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // 2.0: Change number (Ctrl+R) — the type's series (method, format) and the next number for the dialog.
  const company = useCompany();
  const canRenumber = useCan('vouchers.renumber');
  const [renumbering, setRenumbering] = useState(false);
  const [renumberError, setRenumberError] = useState<string | null>(null);
  const renumberM = useApiMutation('vouchers.renumber', { invalidates: VOUCHER_INVALIDATES });
  const typesQ = useApiQuery('accounts.voucherType.list', {}, { staleTime: 60_000, enabled: canRenumber && canAlter });
  const vType = v ? typesQ.data?.rows.find((t) => t.id === v.voucherType.id) : undefined;
  const nextQ = useApiQuery('vouchers.nextNumber', { voucherTypeId: v?.voucherType.id ?? 0, date: v?.date ?? '2000-01-01' }, { enabled: renumbering && !!v, staleTime: 0 });

  const entries = useMemo<ViewEntryRow[]>(() => viewEntryRows(v?.entries ?? [], INSTRUMENT_LABEL), [v]);
  // 2.2: a voucher that posts no ledger entries (an order, a quotation) keeps its ledger lines only as
  // entered; they are its Particulars, their ledgers named as the names load ('…' until then).
  const lineLedgers = useLedgerDetails(v ? viewLineLedgerIds(v) : NO_LEDGER_IDS);
  const lines = useMemo<ViewLineRow[]>(() => (v ? viewLineRows(v, (id) => lineLedgers.get(id)?.name) : []), [v, lineLedgers]);
  const signedLines = v?.mode === 'ledger';
  const gstRows = useMemo(() => gstByRate(v?.gstLines ?? []), [v]);

  const physical = v?.voucherType.baseType === 'physical_stock';
  const invoiceTotals = v ? viewSections(v, false).totals : false;
  const itemColumns = useMemo<Column<PreviewInventoryLine>[]>(
    () => [
      { key: 'lineNo', header: '#', width: 44, kind: 'number', decimals: 0 },
      {
        key: 'itemName',
        header: 'Item',
        render: (r) => {
          // 2.2: the line's own description (typed on this voucher, not the item master's), as typed.
          const description = lineDescription(r.description);
          return (
            <>
              <div className="bx-vch-view__name">
                {r.itemName}
                {r.batchName ? <span className="bx-muted"> · batch {r.batchName}</span> : null}
                {r.trackingRef ? <span className="bx-muted"> · note {r.trackingRef}</span> : null}
                {r.orderRef ? <span className="bx-muted"> · order {r.orderRef}</span> : null}
                {r.isConsumption ? <span className="bx-muted"> · consumed</span> : null}
              </div>
              {description ? <div className="bx-muted bx-vch-view__desc">{description}</div> : null}
            </>
          );
        },
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
      // An item invoice says its totals in the block under the lines (Taxable … Total ₹), not in a total row.
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140, total: !invoiceTotals },
    ],
    [physical, invoiceTotals],
  );
  const entryColumns = useMemo<Column<ViewEntryRow>[]>(
    () => [
      // The ledger, then its description (2.2: its own line) and its bills / cost centres / bank details.
      { key: 'name', header: 'Particulars', render: particulars },
      { key: 'debit', header: 'Debit', kind: 'amount', width: 150, blankZero: true, total: true },
      { key: 'credit', header: 'Credit', kind: 'amount', width: 150, blankZero: true, total: true },
    ],
    [],
  );
  const lineColumns = useMemo<Column<ViewLineRow>[]>(
    () => [
      { key: 'name', header: 'Particulars', render: particulars },
      // As entered, like the entry's Amount: + adds to the document's value, − deducts (a discount); no total
      // (the document's value is in words below). A Dr / Cr line could only be a voucher saved without its entries.
      { key: 'amount', header: 'Amount', kind: signedLines ? 'drcr' : 'amount', width: 150 },
    ],
    [signedLines],
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

  const renumber = async (o: VoucherNumberOverride) => {
    if (!v) return;
    setRenumberError(null);
    try {
      const out = await withConfirmation(
        (ack) =>
          renumberM
            .mutate({
              id: v.id,
              number: o.number,
              ...(o.reason !== undefined ? { reason: o.reason } : {}),
              ...(o.continueSeries === true ? { continueSeries: true } : {}),
              expectedUpdatedAt: v.updatedAt,
              acknowledgeWarnings: ack || undefined,
            })
            .catch((err: unknown) => {
              // The voucher warnings protocol (e.g. a filed GSTR-1 period) as the shell's confirmation.
              if (isApiError(err) && err.code === 'BUSINESS_RULE') {
                const req = confirmationRequest(err.details);
                if (req) throw new ApiError('BUSINESS_RULE', err.message, { needsConfirmation: true, warnings: req.confirm }, err.route);
              }
              throw err;
            }),
        { title: 'Please check before saving', confirmLabel: 'Save anyway', cancelLabel: 'Go back' },
      );
      if (out === undefined) return;
      const infos = out.warnings.filter((w) => w.level === 'info').map((w) => w.message);
      toast.success(renumberedText(v.voucherType.name, v.number, out.number), infos.length > 0 ? { message: infos.join(' ') } : undefined);
      setRenumbering(false);
      void q.refetch();
    } catch (err) {
      setRenumberError(userMessage(err));
    }
  };

  const live = !!v && !v.isCancelled;
  const irnGenerated = v?.irn.status === 'generated';
  const renumberAction = changeNumberAvailability({ where: 'view', canRenumber, canAlter, method: vType?.numbering.method ?? null, isCancelled: v?.isCancelled === true, irnGenerated });
  const actions: ScreenActionItem[] = [
    { key: 'Alt+A', label: 'Alter', icon: 'edit', primary: true, onClick: () => v && nav.push('vouchers.entry', { id: v.id }), hidden: !live || !canAlter, disabled: irnGenerated, hint: irnGenerated ? 'An e-invoice has been generated: cancel it instead of altering.' : undefined },
    { key: 'Alt+P', label: 'Print', icon: 'print', onClick: () => v && nav.push('print.voucher', { id: v.id }), hidden: !v || !nav.isRegistered('print.voucher'), group: 'output' },
    { key: 'Alt+2', label: 'Duplicate', icon: 'copy', onClick: () => v && nav.push('vouchers.entry', { duplicateOf: v.id }), hidden: !v || !canCreate, group: 'output' },
    {
      key: 'Alt+H',
      label: 'Edit history',
      icon: 'clock',
      onClick: () => v && nav.push('security.audit', { entityType: 'voucher', entityId: v.id, entityGuid: v.guid, label: `${v.voucherType.name} ${v.number ?? ''}`.trim() }),
      hidden: !v || !canAudit,
      group: 'output',
    },
    { key: 'Ctrl+R', label: 'Change number', icon: 'hash', onClick: () => setRenumbering(true), hidden: !v || renumberAction.hidden, disabled: renumberAction.disabled, hint: renumberAction.hint, group: 'output' },
    { key: 'Alt+X', label: 'Cancel voucher', icon: 'x-circle', onClick: () => setCancelling(true), hidden: !live || !canAlter, group: 'danger' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !v || !canDelete || irnGenerated, group: 'danger' },
    // 2.1 (SPEC-21 D21): Detailed adds the Dr / Cr entries of an invoice, the GST table, addresses and the audit line; remembered.
    { key: 'Alt+F1', label: 'Detailed', icon: 'list', onClick: () => setUiPrefs({ voucherDetailed: !detailed }), hidden: !v, group: 'view', checked: detailed },
  ];

  const title = v ? `${v.voucherType.name} ${v.number ?? ''}`.trim() : 'Voucher';
  const consignee = v?.consignee;
  const dispatch = v?.dispatch;
  const state = v ? viewStateWords(v) : null;
  const sections = v ? viewSections(v, detailed) : null;
  // The lines of a voucher that posts nothing: beside item lines they are its charges (entry's own title), else the document.
  const linesTitle = v && v.inventory.length > 0 ? 'Charges & discounts' : null;
  const party = v ? partyLine(v) : '';
  const refs = v ? referenceLine(v) : '';
  // Detailed: the party's address and state, dispatch and e-invoice details (only those with a value).
  const details: KeyValueItem[] = v
    ? [
        { label: 'Ledger', value: v.partyLedgerName && v.partyLedgerName !== v.party.name ? v.partyLedgerName : '' },
        { label: 'Address', value: v.party.address ?? '' },
        { label: 'State', value: v.party.stateCode ? stateLabel(v.party.stateCode) : '' },
        { label: 'Place of supply', value: v.placeOfSupply ? stateLabel(v.placeOfSupply) : '' },
        { label: 'Effective date', value: v.effectiveDate ?? '', kind: 'date' as const },
        { label: 'Reason', value: v.noteReason ?? '' },
        { label: 'Consignee', value: [consignee?.name, consignee?.stateCode ? stateLabel(consignee.stateCode) : ''].filter(Boolean).join(', ') },
        { label: 'Vehicle', value: dispatch?.vehicleNo ?? '' },
        { label: 'Transporter', value: dispatch?.transporterName ?? '' },
        { label: 'Distance', value: dispatch?.distanceKm ? `${dispatch.distanceKm} km` : '' },
        { label: 'e-Way Bill valid up to', value: v.ewayBill.validUpto ?? '', kind: 'date' as const },
        { label: 'IRN', value: v.irn.irn ?? '' },
        { label: 'Ack no.', value: v.irn.ackNo ? `${v.irn.ackNo}${v.irn.ackDate ? ` · ${formatDate(v.irn.ackDate.slice(0, 10))}` : ''}` : '' },
      ].filter((d) => d.value !== '')
    : [];
  return (
    <Screen
      title={title}
      subtitle={v ? formatDate(v.date) : undefined}
      width="full"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      actions={actions}
      hint="Alt+A Alter · Alt+P Print · Alt+F1 Detailed · Alt+2 Duplicate · Esc Back"
      meta={
        state && (state.danger || state.words.length > 0) ? (
          <>
            {state.danger ? <span className="bx-vch-view__danger">{state.danger}</span> : null}
            {state.danger && state.words.length > 0 ? ' · ' : ''}
            {state.words.join(' · ')}
          </>
        ) : undefined
      }
    >
      {v && sections ? (
        <Stack gap={4}>
          {v.cancellation ? (
            <Banner tone="warning" title="This voucher is cancelled">
              Cancelled on {formatDateTime(v.cancellation.at)}
              {v.cancellation.by ? ` by ${v.cancellation.by}` : ''}. Reason: {v.cancellation.reason}
            </Banner>
          ) : null}
          {party || refs ? (
            <Inline justify="between" gap={6} rowGap={2}>
              <span>{party}</span>
              {refs ? <span className="bx-muted">{refs}</span> : null}
            </Inline>
          ) : null}
          {detailed && details.length > 0 ? <KeyValueList columns={2} items={details} /> : null}

          {v.inventory.length > 0 ? (
            <section aria-label="Items">
              <DataTable<PreviewInventoryLine>
                aria-label="Items"
                columns={itemColumns}
                rows={v.inventory}
                getRowKey={(r) => `${r.lineNo}-${r.itemId}-${r.isConsumption ? 'c' : 'p'}`}
                getRowClassName={(r) => (lineDescription(r.description) ? MULTILINE_ROW : undefined)}
                hiddenColumns={hiddenItemColumns(v.inventory, detailed)}
                density="compact"
                // A described line is taller than the others, and the table is as tall as its rows: no windowing.
                virtualize={false}
                autoFocus={sections.focus === 'items'}
              />
            </section>
          ) : null}

          {sections.totals ? (
            <KeyValueList
              className="bx-vch-view__totals"
              alignValues="right"
              items={viewTotals(v).map((r) =>
                // Tax the party is not paid (reverse charge, IGST at customs) is shown muted, outside the Total.
                r.muted
                  ? { key: r.key, label: <span className="bx-muted">{r.label}</span>, value: <span className="bx-muted">{formatMoney(r.amount)}</span>, kind: 'amount' as const }
                  : { key: r.key, label: r.label, value: r.amount, kind: 'amount' as const, strong: r.grand },
              )}
            />
          ) : null}

          {sections.entries ? (
            // An invoice's entries (Detailed) get a section title; a voucher's own Dr / Cr lines are the document.
            <Section title={v.inventory.length > 0 ? 'Accounting entries' : null} label="Accounting entries">
              <DataTable<ViewEntryRow>
                aria-label="Accounting entries"
                columns={entryColumns}
                rows={entries}
                getRowKey={(r) => r.key}
                getRowClassName={(r) => (r.description || r.detail ? MULTILINE_ROW : undefined)}
                density="compact"
                virtualize={false}
                autoFocus={sections.focus === 'entries'}
              />
            </Section>
          ) : sections.lines ? (
            // 2.2: posts no ledger entries (an order, a quotation): its ledger lines as entered, as they print.
            <Section title={linesTitle} label={linesTitle ?? 'Particulars'}>
              <DataTable
                aria-label={linesTitle ?? 'Particulars'}
                columns={lineColumns}
                rows={lines}
                getRowKey={(r) => r.key}
                getRowClassName={(r) => (r.description ? MULTILINE_ROW : undefined)}
                density="compact"
                virtualize={false}
                autoFocus={sections.focus === 'lines'}
                empty={<EmptyState size="sm" title="No lines" />}
              />
            </Section>
          ) : detailed && entries.length === 0 && !v.isCancelled ? (
            <p className="bx-muted">This voucher records stock only — it has no accounting entries.</p>
          ) : null}

          {sections.gst ? (
            <Panel title="GST" padded={false}>
              <DataTable<GstRateRow> aria-label="GST breakup" columns={gstColumns} rows={gstRows} getRowKey={(r) => r.key} density="compact" hideEmptyColumns />
            </Panel>
          ) : null}

          <Stack gap={1}>
            {v.totals.amount > 0 && !v.isCancelled ? <p>{amountInWords(v.totals.amount)}</p> : null}
            {v.narration ? (
              <p>
                <span className="bx-muted">Narration: </span>
                {v.narration}
              </p>
            ) : null}
            {detailed ? (
              <p className="bx-muted">
                Entered by {v.createdBy.name ?? 'unknown'} on {formatDateTime(v.createdAt)}
                {v.updatedAt !== v.createdAt ? ` · last changed by ${v.updatedBy.name ?? 'unknown'} on ${formatDateTime(v.updatedAt)}` : ''}
              </p>
            ) : null}
          </Stack>

          {panels.map(({ key, C }) => (
            <C key={key} voucherId={v.id} baseType={v.voucherType.baseType} isCancelled={v.isCancelled} isOptional={v.isOptional} updatedAt={v.updatedAt} />
          ))}
        </Stack>
      ) : null}
      {renumbering && v ? (
        <ChangeNumberDialog
          voucherTypeId={v.voucherType.id}
          baseType={v.voucherType.baseType}
          date={v.date}
          fyStartMonth={company.fyStartMonth}
          gstDoc={isGstDocType(v.voucherType.baseType, company.gstEnabled)}
          method={vType?.numbering.method ?? 'automatic'}
          scheme={vType?.numbering ?? null}
          current={v.number}
          nextNumber={nextQ.data ?? ''}
          excludeId={v.id}
          partyLedgerId={v.partyLedgerId}
          mode={v.mode}
          busy={renumberM.pending}
          error={renumberError}
          onAccept={(o) => void renumber(o)}
          onClose={() => {
            setRenumbering(false);
            setRenumberError(null);
          }}
        />
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

/** A titled section (Panel) or, without a title, a plain section named for screen readers. */
function Section({ title, label, children }: { title: string | null; label: string; children: ReactNode }) {
  return title ? (
    <Panel title={title} padded={false}>
      {children}
    </Panel>
  ) : (
    <section aria-label={label}>{children}</section>
  );
}

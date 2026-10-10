/**
 * 'cheques.print' {voucherIds?} — Cheque Printing (F11 › Cheque printing).
 *  - With `voucherIds` (Alt+K on a Payment / Contra, or from the picker): the cheques of those vouchers,
 *    one leaf per page in the bank's layout. Space leaves the highlighted cheque out, Alt+X toggles its
 *    'A/c Payee' crossing, Alt+P prints (recorded in the edit log and the cheque register first),
 *    Alt+L chooses another layout, Alt+O opens the voucher.
 *  - Without: tick Payments / Contras of the period (Space, Alt+A all) and Ctrl+A to preview them.
 */
import { useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { ChequePrintItem } from '../../../shared/types/cheques.ts';
import type { VoucherListRow } from '../../../shared/types/vouchers.ts';
import { api, Screen, useApiQuery, useCan, useNav, usePeriod, type ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, Checkbox, DataTable, EmptyState, Field, Inline, Select, Stack, useToast, type Column } from '../../ui/index.ts';
import { orderedSelection, toggleAll, toggleId } from '../print/lib/screenState.ts';
import { ChequeSheets, useChequePrintJob, useChequesOn } from './components.tsx';
import { chequeMarks, mixedLayouts, selectedCheques } from './lib/cheque.ts';
import { CHEQUES_OFF } from './lib/model.ts';

export interface PrintChequesParams {
  voucherIds?: number[];
}

export function PrintChequesScreen({ params }: ScreenProps<PrintChequesParams>) {
  const on = useChequesOn();
  const ids = Array.isArray(params.voucherIds) ? params.voucherIds.filter((x) => Number.isInteger(x) && x > 0).slice(0, 200) : [];
  if (!on) {
    return (
      <Screen title="Print Cheques" icon="bank">
        <EmptyState icon="bank" title="Cheque printing is turned off" body={CHEQUES_OFF} />
      </Screen>
    );
  }
  return ids.length > 0 ? <ChequePreview ids={ids} /> : <ChequePicker />;
}

function ChequePreview({ ids }: { ids: number[] }) {
  const nav = useNav();
  const toast = useToast();
  const canExport = useCan('data.export');
  const [layoutId, setLayoutId] = useState<number | null>(null);
  const q = useApiQuery('cheques.print.data', { voucherIds: ids, ...(layoutId !== null ? { layoutId } : {}) }, { keepPrevious: true, staleTime: 0 });
  const layouts = useApiQuery('cheques.layout.list', {});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [crossing, setCrossing] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const job = useChequePrintJob(rootRef);
  const all = useMemo(() => q.data?.cheques ?? [], [q.data]);
  const items = useMemo(() => all.map((c) => ({ ...c, acPayee: c.self ? false : (crossing[c.key] ?? c.acPayee) })), [all, crossing]);
  const chosen = selectedCheques(items, excluded);
  const current = items.find((c) => c.key === cursor) ?? items[0] ?? null;
  const mixed = mixedLayouts(chosen);
  const pages = useMemo(() => chosen.map((c) => ({ key: c.key, ...chequeMarks(c, c.spec) })), [chosen]);
  const layoutWarnings = pages.flatMap((p, i) => p.warnings.map((w) => `${chosen[i].voucherLabel}: ${w}`));
  const warnings = [...chosen.flatMap((c) => c.warnings.map((w) => `${c.voucherLabel}: ${w}`)), ...layoutWarnings];

  const print = async (): Promise<void> => {
    if (chosen.length === 0 || mixed.length > 0) return;
    const spec = chosen[0].spec;
    const ok = await job.run({
      spec,
      title: chosen.length === 1 ? `Cheque ${chosen[0].chequeNo ?? ''} ${chosen[0].payee}` : `${chosen.length} cheques`,
      before: async () => {
        await api('cheques.print.record', { items: chosen.map((c) => ({ voucherId: c.voucherId, lineNo: c.lineNo })), ...(layoutId !== null ? { layoutId } : {}) });
      },
    });
    if (ok) {
      toast.success(chosen.length === 1 ? 'Cheque sent to the printer' : `${chosen.length} cheques sent to the printer`, { message: 'Recorded in the cheque register. If a leaf is spoilt, cancel it there (Alt+X).' });
      void q.refetch();
    }
  };

  const columns = useMemo<Column<ChequePrintItem & { acPayee: boolean }>[]>(
    () => [
      { key: 'pick', header: 'Print', headerLabel: 'Selected for printing', width: 64, render: (r) => <Checkbox checked={!excluded.has(r.key)} aria-label={`Print cheque for ${r.payee}`} tabIndex={-1} onChange={() => setExcluded((s) => toggleKey(s, r.key))} /> },
      { key: 'chequeNo', header: 'Cheque No.', width: 110, value: (r) => r.chequeNo ?? '—' },
      { key: 'chequeDate', header: 'Date', kind: 'date', width: 110 },
      { key: 'payee', header: 'Payee', minWidth: 200 },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140 },
      { key: 'bankLedgerName', header: 'Bank', width: 150 },
      { key: 'acPayee', header: 'Crossing', width: 110, render: (r) => (r.acPayee ? <Badge size="sm">A/c Payee</Badge> : <Badge size="sm" tone="warning">{r.self ? 'Self' : 'Open'}</Badge>) },
      { key: 'voucherLabel', header: 'Voucher', minWidth: 200 },
    ],
    [excluded],
  );

  return (
    <Screen
      title="Print Cheques"
      subtitle={q.data ? `${chosen.length} of ${items.length} cheque${items.length === 1 ? '' : 's'} · ${chosen[0]?.layoutName ?? ''}` : undefined}
      icon="bank"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Alt+P Print · Space Leave out / include · Alt+X A/c Payee on / off · Alt+L Layout · Alt+O Open voucher · Esc Back"
      actions={[
        {
          key: 'Alt+P',
          label: 'Print cheques',
          icon: 'print',
          primary: true,
          onClick: () => void print(),
          disabled: chosen.length === 0 || mixed.length > 0 || job.busy || !canExport,
          hint: canExport ? 'Printing is recorded in the edit log' : 'Printing cheques needs the Data › Export permission',
        },
        { key: 'Alt+X', label: 'A/c Payee on / off', icon: 'edit', onClick: () => current && !current.self && setCrossing((c) => ({ ...c, [current.key]: !current.acPayee })), disabled: !current || current.self },
        { key: 'Alt+O', label: 'Open voucher', icon: 'eye', onClick: () => current && nav.push('vouchers.view', { id: current.voucherId }), disabled: !current, group: 'nav' },
        { key: 'Alt+L', label: 'Layouts', icon: 'layers', onClick: () => nav.push('cheques.layouts'), group: 'nav' },
      ]}
    >
      <Stack gap={3}>
        <Inline gap={4} align="end">
          <Field label="Layout" hint="Default: each bank's own layout (Cheque Books › Alt+S).">
            <Select
              aria-label="Cheque layout"
              size="sm"
              value={layoutId === null ? '' : String(layoutId)}
              onChange={(v: string) => setLayoutId(v === '' ? null : Number(v))}
              options={[{ value: '', label: "Each bank's layout" }, ...(layouts.data ?? []).map((l) => ({ value: String(l.id), label: l.name }))]}
            />
          </Field>
        </Inline>
        {q.data && q.data.skipped.length > 0 ? (
          <Banner tone="info" title="Not printed">
            <ul>
              {q.data.skipped.map((s) => (
                <li key={s.voucherId}>
                  {s.label}: {s.reason}
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {mixed.length > 0 ? (
          <Banner tone="warning" title="Several layouts">
            These cheques use different layouts ({mixed.join(', ')}). Choose one layout above, or leave out the cheques of the other bank (Space), and print them separately.
          </Banner>
        ) : null}
        {warnings.length > 0 ? (
          <Banner tone="warning" title="Before you print">
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        <DataTable
          aria-label="Cheques"
          autoFocus
          columns={columns}
          rows={items}
          getRowKey={(r) => r.key}
          selectedKey={current?.key ?? null}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => setExcluded((s) => toggleKey(s, r.key))}
          onRowKeyDown={(e, r) => {
            if (r && e.key === ' ' && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              setExcluded((s) => toggleKey(s, r.key));
            }
          }}
          empty={<EmptyState icon="bank" title="No cheques to print" body="The vouchers chosen are not paid by cheque. In a Payment, press Alt+K on the bank line and choose Cheque." />}
        />
        {chosen.length > 0 && mixed.length === 0 ? <ChequeSheets pages={pages} spec={chosen[0].spec} rootRef={rootRef} label="Preview of the cheques" /> : null}
      </Stack>
    </Screen>
  );
}

function toggleKey(s: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(s);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function ChequePicker() {
  const nav = useNav();
  const { from, to, label, openDialog } = usePeriod();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useApiQuery('vouchers.list', { from, to, baseTypes: ['payment', 'contra'], includeCancelled: false, sort: 'date_asc', limit: 1000 }, { keepPrevious: true });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const chosen = orderedSelection(selected, ids).slice(0, 200);
  const columns = useMemo<Column<VoucherListRow>[]>(
    () => [
      { key: 'pick', header: 'Print', headerLabel: 'Selected', width: 64, render: (r) => <Checkbox checked={selected.has(r.id)} aria-label={`Select ${r.voucherTypeName} ${r.number ?? ''}`} tabIndex={-1} onChange={() => setSelected((s) => toggleId(s, r.id))} /> },
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'voucherTypeName', header: 'Type', width: 130 },
      { key: 'number', header: 'No.', width: 110, value: (r) => r.number ?? '' },
      { key: 'partyName', header: 'Particulars', minWidth: 200, value: (r) => r.partyName ?? '' },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140 },
    ],
    [selected],
  );
  return (
    <Screen
      title="Print Cheques"
      subtitle={`${label} · ${chosen.length} selected`}
      icon="bank"
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Space or Enter Tick · Alt+A Tick all · Ctrl+A Preview cheques · Alt+F2 Period"
      actions={[
        { key: 'Ctrl+A', label: 'Preview cheques', icon: 'print', primary: true, onClick: () => chosen.length > 0 && nav.push('cheques.print', { voucherIds: chosen }), disabled: chosen.length === 0 },
        { key: 'Alt+A', label: chosen.length === ids.length && ids.length > 0 ? 'Untick all' : 'Tick all', icon: 'check', onClick: () => setSelected((s) => toggleAll(s, ids)), disabled: ids.length === 0 },
      ]}
      toolbar={
        <Button icon="calendar" onClick={openDialog}>
          {label}
        </Button>
      }
    >
      <DataTable
        aria-label="Payments and contras"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        loading={q.loading}
        selectedKey={cursor}
        onSelect={(key) => setCursor(key)}
        onRowActivate={(r) => setSelected((s) => toggleId(s, r.id))}
        onRowKeyDown={(e, r) => {
          if (r && e.key === ' ' && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            setSelected((s) => toggleId(s, r.id));
          }
        }}
        empty={<EmptyState icon="bank" title={`No payments or contras from ${formatDate(from)} to ${formatDate(to)}`} body="Change the period with Alt+F2." />}
      />
    </Screen>
  );
}


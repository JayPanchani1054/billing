/**
 * Return filing status and GSTR-1 amendments:
 *   'gst.filings'    — every return marked filed (form, period, date, ARN). Enter opens the return;
 *                      Alt+U unmarks one (after confirmation; needs gst.file). Returns are marked filed
 *                      from their own screens (Alt+F).
 *   'gst.amendments' {period?, all?} — documents changed (9A invoices, 9C notes, 10 B2C small) or added
 *                      after their GSTR-1 was filed, reported in the chosen return period: original as
 *                      filed, amended now and the difference. Ctrl+2 shows every period. Enter opens the
 *                      voucher.
 */
import { useMemo, useRef, useState } from 'react';
import type { GstAmendmentRow, GstFiling } from '../../../shared/types/gst-plus.ts';
import { ReportScreen, useApiMutation, useApiQuery, useCan, useConfirm, useNav, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, DataTable, EmptyState, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp, PeriodSelect, useReturnPeriod } from './components.tsx';
import { amendmentsExport, amendmentTableLabel, filingRoute, filingsExport, FORM_LABELS, taxSum } from './lib/gstplus.ts';

// ───────────────────────────── Filing status ─────────────────────────────

export function FilingsScreen() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canFile = useCan('gst.file');
  const q = useApiQuery('gst.filing.list', {});
  const unmark = useApiMutation('gst.filing.unmark', { invalidates: ['gst'] });
  const rows = q.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const keyOf = (r: GstFiling): string => `${r.form}:${r.period}`;
  const current = rows.find((r) => keyOf(r) === selected) ?? rows[0] ?? null;
  const cols = useMemo<Column<GstFiling>[]>(
    () => [
      { key: 'form', header: 'Return', width: 110, value: (r) => FORM_LABELS[r.form] },
      { key: 'periodLabel', header: 'Period', minWidth: 180 },
      { key: 'filedOn', header: 'Filed on', kind: 'date', width: 120, sortable: true },
      { key: 'arn', header: 'ARN', width: 200, value: (r) => r.arn ?? '' },
    ],
    [],
  );
  const doUnmark = async (r: GstFiling | null): Promise<void> => {
    if (!r || !canFile) return;
    const ok = await confirm({
      title: `Unmark ${FORM_LABELS[r.form]} for ${r.periodLabel}?`,
      message:
        r.form === 'gstr1'
          ? 'Only if it was marked by mistake. Documents of that period can then be changed freely again, and amendments already logged for it are kept.'
          : 'Only if it was marked by mistake: the return will show as not filed.',
      confirmLabel: 'Unmark',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await unmark.mutate({ form: r.form, period: r.period });
      toast.success(`${FORM_LABELS[r.form]} for ${r.periodLabel} unmarked`);
    } catch (err) {
      toast.error('Could not unmark the return', { message: userMessage(err) });
    }
  };
  const actions: ScreenActionItem[] = [
    { key: 'Alt+U', label: 'Unmark filed', icon: 'x-circle', onClick: () => void doUnmark(current), hidden: !canFile, disabled: !canFile || !current, group: 'danger' },
    { key: 'Alt+M', label: 'Amendments', icon: 'list', onClick: () => nav.push('gst.amendments', { all: true }), group: 'go' },
  ];
  return (
    <ReportScreen
      title="Return Filing Status"
      periodMode="none"
      actions={actions}
      exportDef={q.data ? () => ({ ...filingsExport(rows), title: 'Return Filing Status' }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open return · Alt+U Unmark · Alt+M Amendments · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>
          Mark a return filed (Alt+F on the return) after filing it on the portal. A filed GSTR-1 is protected: its documents cannot be deleted or cancelled, and changes
          to them are reported as amendments in the next GSTR-1 instead of silently changing the filed period.
        </GstHelp>
        <DataTable<GstFiling>
          aria-label="Returns marked filed"
          autoFocus
          columns={cols}
          rows={rows}
          getRowKey={keyOf}
          selectedKey={current ? keyOf(current) : null}
          onSelect={(k) => setSelected(k)}
          onRowActivate={(r) => {
            const to = filingRoute(r);
            nav.push(to.screen, to.params);
          }}
          empty={<EmptyState icon="check" title="No return is marked filed" body="Open a return (GSTR-1, GSTR-3B, CMP-08 or GSTR-4) and press Alt+F after filing it on the portal." />}
        />
      </div>
    </ReportScreen>
  );
}

// ───────────────────────────── Amendments ─────────────────────────────

export function AmendmentsScreen({ params }: ScreenProps<{ period?: string; all?: boolean }>) {
  const nav = useNav();
  const rp = useReturnPeriod(params?.period);
  const [all, setAll] = useState(params?.all === true);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const q = useApiQuery('gst.amendments.list', all ? {} : { period: rp.key ?? '' }, { enabled: all || rp.key !== null, keepPrevious: true });
  const rows = q.data ?? [];
  const cols = useMemo<Column<GstAmendmentRow>[]>(
    () => [
      { key: 'table', header: 'Table', width: 90, render: (r) => <Badge tone={r.table === 'late' ? 'info' : 'warning'}>{amendmentTableLabel(r)}</Badge>, value: (r) => r.table },
      { key: 'origNumber', header: 'Document no.', width: 140, value: (r) => r.origNumber ?? '' },
      { key: 'origDate', header: 'Original date', kind: 'date', width: 120 },
      { key: 'party', header: 'Party', minWidth: 180, value: (r) => r.amended?.partyName ?? r.original?.partyName ?? '' },
      { key: 'originalPeriod', header: 'Filed in', width: 100 },
      { key: 'amendPeriod', header: 'Reported in', width: 110 },
      { key: 'origValue', header: 'Original value', kind: 'amount', width: 140, value: (r) => r.original?.value ?? 0, blankZero: true },
      { key: 'newValue', header: 'Amended value', kind: 'amount', width: 140, value: (r) => r.amended?.value ?? 0 },
      { key: 'dTaxable', header: 'Δ Taxable', kind: 'amount', width: 130, total: true, value: (r) => r.delta.taxable },
      { key: 'dTax', header: 'Δ Tax', kind: 'amount', width: 120, total: true, value: (r) => taxSum(r.delta) },
    ],
    [],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Alt+F2', label: 'Return period', icon: 'calendar', onClick: () => selectRef.current?.focus(), disabled: all, group: 'period' },
    { key: 'Ctrl+1', label: 'This period', onClick: () => setAll(false), disabled: !all, group: 'view' },
    { key: 'Ctrl+2', label: 'All periods', onClick: () => setAll(true), disabled: all, group: 'view' },
    { key: 'Alt+R', label: 'GSTR-1', icon: 'gst', onClick: () => nav.push('gst.gstr1', rp.key ? { period: rp.key } : {}), group: 'go' },
    { key: 'Alt+S', label: 'Filing status', icon: 'check', onClick: () => nav.push('gst.filings'), group: 'go' },
  ];
  return (
    <ReportScreen
      title="GSTR-1 Amendments"
      subtitle={all ? 'All periods' : rp.label ? `Reported in ${rp.label}` : undefined}
      periodMode="none"
      filters={all ? undefined : <PeriodSelect periods={rp.periods} value={rp.key} onChange={rp.setKey} selectRef={selectRef} />}
      actions={actions}
      exportDef={q.data ? () => ({ ...amendmentsExport(rows), title: 'GSTR-1 Amendments', period: all ? 'All periods' : rp.label }) : undefined}
      loading={rp.loading || (q.loading && !q.data)}
      refreshing={q.refreshing}
      error={rp.error ?? q.error}
      onRetry={() => (rp.error ? rp.refetch() : void q.refetch())}
      hint="Enter Open voucher · Ctrl+1 This period · Ctrl+2 All · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>
          Invoices and notes changed after their GSTR-1 was filed are reported here as amendments (9A invoices, 9C credit / debit notes, 10 B2C small) in the next GSTR-1
          you file; documents dated in a filed period but missing from it are reported as added. The filed period keeps its figures.
        </GstHelp>
        {rows.some((r) => r.amended === null) ? (
          <Banner tone="info" inline>
            Rows without an amended value: the document no longer counts (made optional). Report it on the portal with zero values.
          </Banner>
        ) : null}
        <DataTable<GstAmendmentRow>
          aria-label="Amendments"
          autoFocus
          columns={cols}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          onRowActivate={(r) => (r.voucherId ? nav.push('vouchers.view', { id: r.voucherId }) : undefined)}
          empty={<EmptyState icon="check" title="No amendments" body={`Nothing changed after filing${all ? '' : ' for this period'}. Mark a GSTR-1 filed (Alt+F on GSTR-1) to start tracking changes.`} />}
        />
      </div>
    </ReportScreen>
  );
}

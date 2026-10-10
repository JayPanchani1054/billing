/**
 * Final-wave GST screens:
 *   'gst.gstr3b.changes' {period?, all?} — vouchers of periods whose GSTR-3B was marked filed that were
 *        altered, added late or deleted / cancelled afterwards, and the period whose GSTR-3B reports the
 *        change (the filed period keeps its figures). Enter opens the voucher; Ctrl+2 all periods.
 *   'gst.rule37' {asOf?} — purchases not paid within 180 days (Rule 37): the credit to reverse for the
 *        unpaid part, and to reclaim once paid. Alt+R posts the reversal journal, Alt+L the reclaim
 *        (both a GST stat adjustment journal through the books; need gst.file). Enter opens the purchase.
 */
import { useMemo, useRef, useState } from 'react';
import type { Gstr3bChangeRow, Rule37Row } from '../../../shared/types/gst-plus.ts';
import type { TaxAmounts } from '../../../shared/types/gst-returns.ts';
import { formatDate, formatMoney, ReportScreen, useApiMutation, useApiQuery, useCan, useNav, useWorkingDate, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, DateInput, EmptyState, Field, Hotkeys, Inline, Modal, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp, PeriodSelect, useReturnPeriod } from './components.tsx';
import { CHANGE_KIND_LABELS, gstr3bChangesExport, rule37Actionable, rule37Export } from './lib/gaps.ts';

const sum = (t: TaxAmounts): number => t.igst + t.cgst + t.sgst + t.cess;

// ───────────────────────────── Changes after GSTR-3B filing ─────────────────────────────

export function Gstr3bChangesScreen({ params }: ScreenProps<{ period?: string; all?: boolean }>) {
  const nav = useNav();
  const rp = useReturnPeriod(params?.period);
  const [all, setAll] = useState(params?.all === true);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const q = useApiQuery('gst.gstr3b.changes', all ? {} : { period: rp.key ?? '' }, { enabled: all || rp.key !== null, keepPrevious: true });
  const rows = q.data ?? [];
  const cols = useMemo<Column<Gstr3bChangeRow>[]>(
    () => [
      { key: 'kind', header: 'Change', width: 150, render: (r) => <Badge tone={r.kind === 'removed' ? 'danger' : r.kind === 'added' ? 'info' : 'warning'}>{CHANGE_KIND_LABELS[r.kind]}</Badge>, value: (r) => r.kind },
      { key: 'label', header: 'Voucher', minWidth: 180 },
      { key: 'docDate', header: 'Date', kind: 'date', width: 120 },
      { key: 'originalPeriod', header: 'Filed in', width: 100 },
      { key: 'reportPeriod', header: 'Reported in', width: 110 },
      { key: 'dTax', header: 'Δ Tax payable', kind: 'amount', width: 140, total: true, value: (r) => sum(r.liabilityDelta) },
      { key: 'dItc', header: 'Δ Net ITC', kind: 'amount', width: 140, total: true, value: (r) => sum(r.itcDelta) },
    ],
    [],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'This period', onClick: () => setAll(false), disabled: !all, group: 'view' },
    { key: 'Ctrl+2', label: 'All periods', onClick: () => setAll(true), disabled: all, group: 'view' },
    { key: 'Alt+R', label: 'GSTR-3B', icon: 'gst', onClick: () => nav.push('gst.gstr3b', rp.key ? { period: rp.key } : {}), group: 'go' },
    { key: 'Alt+S', label: 'Filing status', icon: 'check', onClick: () => nav.push('gst.filings'), group: 'go' },
  ];
  return (
    <ReportScreen
      title="Changes after GSTR-3B Filing"
      subtitle={all ? 'All periods' : rp.label ? `Reported in ${rp.label}` : undefined}
      periodMode="none"
      filters={all ? undefined : <PeriodSelect periods={rp.periods} value={rp.key} onChange={rp.setKey} selectRef={selectRef} />}
      actions={actions}
      exportDef={q.data ? () => ({ ...gstr3bChangesExport(rows), title: 'Changes after GSTR-3B Filing', period: all ? 'All periods' : rp.label }) : undefined}
      loading={rp.loading || (q.loading && !q.data)}
      refreshing={q.refreshing}
      error={rp.error ?? q.error}
      onRetry={() => (rp.error ? rp.refetch() : void q.refetch())}
      hint="Enter Open voucher · Ctrl+1 This period · Ctrl+2 All · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>
          Purchases, journals and other vouchers changed after the GSTR-3B of their period was filed. The filed period keeps its figures; the change is reported in the GSTR-3B of the
          period shown — more credit in 4(A), less credit as a reversal in 4(B)(2), tax in 3.1.
        </GstHelp>
        <DataTable<Gstr3bChangeRow>
          aria-label="Changes after GSTR-3B filing"
          autoFocus
          columns={cols}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          onRowActivate={(r) => (r.voucherId ? nav.push('vouchers.view', { id: r.voucherId }) : undefined)}
          empty={<EmptyState icon="check" title="No changes" body={`Nothing changed after filing${all ? '' : ' for this period'}. Mark a GSTR-3B filed (Alt+F on GSTR-3B) to start tracking changes.`} />}
        />
      </div>
    </ReportScreen>
  );
}

// ───────────────────────────── Rule 37 ─────────────────────────────

export function Rule37Screen({ params }: ScreenProps<{ asOf?: string }>) {
  const nav = useNav();
  const { date } = useWorkingDate();
  const canFile = useCan('gst.file');
  const [asOf, setAsOf] = useState<string | null>(params?.asOf ?? date);
  const [posting, setPosting] = useState<'reversal' | 'reclaim' | null>(null);
  const q = useApiQuery('gst.rule37.report', { asOf: asOf ?? date }, { enabled: asOf !== null, keepPrevious: true });
  const r = q.data;
  const rows = r?.rows ?? [];
  const cols = useMemo<Column<Rule37Row>[]>(
    () => [
      { key: 'partyName', header: 'Supplier', minWidth: 180 },
      { key: 'number', header: 'Voucher no.', width: 110, value: (x) => x.number ?? '' },
      { key: 'referenceNo', header: 'Supplier invoice', width: 130, value: (x) => x.referenceNo ?? '' },
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'deadline', header: '180 days on', kind: 'date', width: 120 },
      { key: 'reportPeriodLabel', header: 'Reverse in', width: 100 },
      { key: 'unpaid', header: 'Unpaid', kind: 'amount', width: 130, total: true },
      { key: 'reversed', header: 'Reversed', kind: 'amount', width: 120, value: (x) => sum(x.reversed), blankZero: true },
      { key: 'toReverse', header: 'Reverse now', kind: 'amount', width: 130, total: true, value: (x) => sum(x.toReverse), blankZero: true },
      { key: 'toReclaim', header: 'Reclaim now', kind: 'amount', width: 130, total: true, value: (x) => sum(x.toReclaim), blankZero: true },
    ],
    [],
  );
  const reversible = r ? rule37Actionable(r, 'reversal').length : 0;
  const reclaimable = r ? rule37Actionable(r, 'reclaim').length : 0;
  const actions: ScreenActionItem[] = [
    { key: 'Alt+R', label: 'Post reversal', icon: 'check', onClick: () => setPosting('reversal'), disabled: !canFile || reversible === 0, group: 'file' },
    { key: 'Alt+L', label: 'Post reclaim', icon: 'check', onClick: () => setPosting('reclaim'), disabled: !canFile || reclaimable === 0, group: 'file' },
    { key: 'Alt+S', label: 'GSTR-3B', icon: 'gst', onClick: () => nav.push('gst.gstr3b'), group: 'go' },
  ];
  return (
    <ReportScreen
      title="Rule 37 — Unpaid after 180 Days"
      subtitle={asOf ? `As on ${formatDate(asOf)}` : undefined}
      periodMode="none"
      filters={
        <Inline gap={2} align="center">
          <span className="bx-muted">As on</span>
          <DateInput id="gst-r37-asof" aria-label="As on date" size="sm" value={asOf} referenceDate={date} onChange={setAsOf} />
        </Inline>
      }
      actions={actions}
      exportDef={r ? () => ({ ...rule37Export(r), title: 'Rule 37 — Unpaid after 180 Days', period: `As on ${formatDate(r.asOf)}` }) : undefined}
      loading={q.loading && !q.data}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open purchase · Alt+R Post reversal · Alt+L Post reclaim · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        {r ? <GstHelp>{r.notes[0]}</GstHelp> : null}
        {r && r.notBillWise.length > 0 ? (
          <Banner tone="warning" inline>
            {`${r.notBillWise.length} purchase(s) are of suppliers without bill-wise details, so their payment cannot be traced: ${r.notBillWise
              .slice(0, 5)
              .map((x) => `${x.partyName} ${x.number ?? ''} (${formatDate(x.date)})`)
              .join(', ')}${r.notBillWise.length > 5 ? ' …' : ''}. Check them by hand.`}
          </Banner>
        ) : null}
        <DataTable<Rule37Row>
          aria-label="Purchases unpaid after 180 days"
          autoFocus
          columns={cols}
          rows={rows}
          getRowKey={(x) => String(x.voucherId)}
          onRowActivate={(x) => nav.push('vouchers.view', { id: x.voucherId })}
          empty={<EmptyState icon="check" title="Nothing to reverse" body="Every purchase with input tax credit was paid within 180 days of its invoice date." />}
        />
        {r ? (
          <p className="bx-gst-help">
            {r.notes.slice(1).join(' ')}
          </p>
        ) : null}
      </div>
      {posting && r && asOf ? <PostRule37Dialog kind={posting} asOf={asOf} total={sum(posting === 'reversal' ? r.totals.toReverse : r.totals.toReclaim)} onClose={() => setPosting(null)} /> : null}
    </ReportScreen>
  );
}

function PostRule37Dialog({ kind, asOf, total, onClose }: { kind: 'reversal' | 'reclaim'; asOf: string; total: number; onClose: () => void }) {
  const toast = useToast();
  const nav = useNav();
  const { date } = useWorkingDate();
  const [vdate, setVdate] = useState<string | null>(date < asOf ? asOf : date);
  const [narration, setNarration] = useState('');
  const post = useApiMutation('gst.rule37.post', { invalidates: ['gst', 'reports', 'vouchers', 'dashboard'] });
  const accept = async (): Promise<void> => {
    if (!vdate || post.pending) return;
    try {
      const out = await post.mutate({ asOf, date: vdate, kind, narration: narration.trim() || undefined });
      toast.success(`${kind === 'reversal' ? 'ITC reversal' : 'ITC reclaim'} posted (Journal ${out.number ?? ''})`, { action: { label: 'Open', onClick: () => nav.push('vouchers.view', { id: out.id }) } });
      onClose();
    } catch (err) {
      toast.error(`Could not post the ${kind}`, { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void accept() });
  const verb = kind === 'reversal' ? 'reverse' : 'reclaim';
  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'reversal' ? 'Post Rule 37 reversal' : 'Post Rule 37(4) reclaim'}
      description={`Posts one journal to ${verb} ${formatMoney(total, { symbol: true })} of input tax credit (Input tax ledgers and "ITC Reversed (GST)"), as a GST stat adjustment. GSTR-3B shows it in ${kind === 'reversal' ? '4(B)(2)' : '4(A)(5) and 4(D)(1)'} of the period of its date.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={post.pending} disabled={!vdate} onClick={() => void accept()}>
            Post journal
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void accept() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="Date" required hint={`On or after ${formatDate(asOf)}`} error={post.fieldErrors.date}>
            <DateInput data-autofocus value={vdate} onChange={setVdate} referenceDate={date} />
          </Field>
          <Field label="Narration" optional>
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={500} />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}

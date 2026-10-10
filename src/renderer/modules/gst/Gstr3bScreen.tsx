/**
 * 'gst.gstr3b' {period?} — GSTR-3B laid out like the portal form (3.1, 3.1.1, 3.2, 4, 5, 5.1, 6.1)
 * with the figures worked out from the books. Figures only the portal knows (ISD credit, reversals,
 * interest, late fee, credit not in the books; unused credit of earlier periods is brought forward automatically) are typed in "Your entries" and saved with Ctrl+A
 * ('gst.gstr3b.saveAdjustments', only the changed cells are sent). The 6.1 table shows how ITC pays
 * each tax head and the cash to pay. Alt+J saves the portal JSON; Alt+P prints the whole form.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Gstr3bItcRow, Gstr3bSummary, Gstr3bSupplyRow, TaxHead } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import {
  api,
  formatDateTime,
  formatMoney,
  ReportScreen,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useDirty,
  useNav,
  userMessage,
} from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { AmountInput, Badge, Banner, Button, Panel, Stack, useEnterAdvance, useToast } from '../../ui/index.ts';
import { FileResultDialog, GstHelp, PeriodSelect, saveJsonFile, useReturnPeriod, WideTable } from './components.tsx';
import type { FileResult } from './components.tsx';
import { MarkFiledDialog, useFiling } from './plusComponents.tsx';
import { taxSum } from './lib/gstplus.ts';
import {
  ADJUSTMENT_FIELDS,
  changedCellCount,
  creditMayPay,
  diffAdjustments,
  draftFrom,
  emptyDraft,
  gstr3bExport,
  HEAD_LABELS,
  interStateTable,
  isDraftDirty,
  paymentSections,
  SET_OFF_RULE,
  setDraftCell,
  setOffLines,
  setOffSentence,
} from './lib/gstr3b.ts';
import type { AdjustmentDraft, PaymentLine } from './lib/gstr3b.ts';

export interface Gstr3bParams {
  period?: string;
}

const money = (p: number): string => formatMoney(p);

export function Gstr3bScreen({ params }: ScreenProps<Gstr3bParams>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canFile = useCan('gst.file');
  const rp = useReturnPeriod(params?.period);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const q = useApiQuery('gst.gstr3b.summary', { period: rp.key ?? '' }, { enabled: rp.key !== null, keepPrevious: true });
  const save = useApiMutation('gst.gstr3b.saveAdjustments');
  const filing = useFiling('gstr3b', rp.key);
  const [marking, setMarking] = useState(false);
  const composition = rp.periods?.registration === 'composition';
  // The summary returned by a save, shown until the refetched query catches up (no flicker of "dirty").
  const [saved, setSaved] = useState<Gstr3bSummary | null>(null);
  useEffect(() => setSaved(null), [q.data]);
  const summary = saved && saved.period.key === rp.key ? saved : q.data && q.data.period.key === rp.key ? q.data : undefined;
  const shown = summary ?? q.data;

  // Draft of the manual entries, re-based whenever a new summary arrives and nothing is being edited.
  const [draft, setDraft] = useState<AdjustmentDraft>(emptyDraft);
  const base = useRef<{ key: string | null; values: Gstr3bSummary['adjustments'] | undefined }>({ key: null, values: undefined });
  useEffect(() => {
    if (!summary) return;
    const prev = base.current;
    setDraft((d) => (prev.key !== summary.period.key || !isDraftDirty(prev.values, d) ? draftFrom(summary.adjustments) : d));
    base.current = { key: summary.period.key, values: summary.adjustments };
  }, [summary]);
  const dirty = !!summary && isDraftDirty(summary.adjustments, draft);
  const changes = summary ? changedCellCount(summary.adjustments, draft) : 0;
  useDirty(dirty);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FileResult | null>(null);

  const changePeriod = async (key: string): Promise<void> => {
    if (key === rp.key) return;
    if (dirty) {
      const ok = await confirm({
        title: 'Discard your unsaved entries?',
        message: `You changed ${changes} ${changes === 1 ? 'figure' : 'figures'} for ${rp.label} and have not saved them. Save first with Ctrl+A to keep them.`,
        confirmLabel: 'Discard and switch',
        tone: 'danger',
      });
      if (!ok) return;
    }
    rp.setKey(key);
  };

  const doSave = async (): Promise<void> => {
    if (!rp.key || !summary || !dirty || save.pending) return;
    try {
      const out = await save.mutate({ period: rp.key, values: diffAdjustments(summary.adjustments, draft) });
      setSaved(out);
      setDraft(draftFrom(out.adjustments));
      toast.success('GSTR-3B entries saved', { message: 'Net ITC, set-off and cash payable have been recalculated.' });
    } catch (err) {
      toast.error('Could not save the entries', { message: userMessage(err) });
    }
  };

  const exportJson = async (): Promise<void> => {
    if (!rp.key || busy) return;
    const errorCount = summary ? summary.issueCount.errors : 0;
    if (errorCount > 0) {
      const ok = await confirm({
        title: `Export GSTR-3B with ${errorCount} GST ${errorCount === 1 ? 'error' : 'errors'} in the period?`,
        message: 'Fixing those entries can change the figures in this return (Alt+X shows them). Export anyway?',
        confirmLabel: 'Export anyway',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const file = await api('gst.gstr3b.json', { period: rp.key });
      const path = await saveJsonFile(file, 'Save GSTR-3B JSON');
      if (path) {
        setResult({
          title: 'GSTR-3B file saved',
          path,
          summary: `GSTR-3B for ${rp.label}${summary?.gstin ? ` · GSTIN ${summary.gstin}` : ''}`,
          warnings: file.warnings,
          nextStep: 'On the GST portal open GSTR-3B for this period, choose "Prepare offline" and upload the file, then check every table before you pay and file.',
        });
      }
    } catch (err) {
      toast.error('Could not create the GSTR-3B file', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const actions: ScreenActionItem[] = [
    {
      key: 'Ctrl+A',
      label: 'Save entries',
      icon: 'save',
      primary: true,
      onClick: () => void doSave(),
      disabled: !dirty || save.pending || !canFile,
      hint: canFile ? (dirty ? `Save ${changes} changed ${changes === 1 ? 'figure' : 'figures'}` : 'Nothing to save') : 'You need the "Prepare GST filings" permission',
      group: 'edit',
    },
    { key: 'Alt+F2', label: 'Return period', icon: 'calendar', onClick: () => selectRef.current?.focus(), group: 'period' },
    {
      key: 'Alt+J',
      label: 'Export JSON',
      icon: 'download',
      onClick: () => void exportJson(),
      disabled: !summary || busy || dirty || !canFile,
      hint: dirty ? 'Save your entries first (Ctrl+A)' : 'Save the file to upload on the GST portal',
      group: 'file',
    },
    { key: 'Alt+X', label: 'GST exceptions', icon: 'alert', onClick: () => shown && nav.push('gst.exceptions', { from: shown.period.from, to: shown.period.to }), disabled: !shown, group: 'go' },
    { key: 'Alt+R', label: 'GSTR-1', icon: 'gst', onClick: () => rp.key && nav.push('gst.gstr1', { period: rp.key }), disabled: !rp.key, group: 'go' },
    // GST plus: set-off / challan / filing status.
    { key: 'Alt+S', label: 'GST set-off', icon: 'gst', onClick: () => rp.key && nav.push('gst.setoff', { period: rp.key }), disabled: !rp.key || dirty, hint: dirty ? 'Save your entries first (Ctrl+A)' : 'Use the credit, record the challan, post the set-off', group: 'go' },
    {
      key: 'Alt+F',
      label: filing.filing ? 'Filed' : 'Mark filed',
      icon: 'check',
      onClick: () => setMarking(true),
      disabled: !shown || !canFile || dirty || filing.filing !== null || composition,
      hint: filing.filing ? `Filed on ${filing.filing.filedOn}` : 'After filing on the portal',
      group: 'file',
    },
  ];

  return (
    <>
      <ReportScreen
        title="GSTR-3B"
        subtitle={rp.label ? `Summary return · ${rp.label}` : 'Summary return'}
        periodMode="none"
        filters={<PeriodSelect periods={rp.periods} value={rp.key} onChange={(k) => void changePeriod(k)} selectRef={selectRef} />}
        actions={actions}
        exportDef={shown ? () => ({ ...gstr3bExport(shown), title: 'GSTR-3B', period: shown.period.label }) : undefined}
        loading={rp.loading || (q.loading && !shown)}
        refreshing={q.refreshing || busy || save.pending}
        error={rp.error ?? q.error}
        onRetry={() => (rp.error ? rp.refetch() : void q.refetch())}
        hint="Enter Next field · Ctrl+A Save entries · Alt+J JSON · Alt+S Set-off · Alt+F Mark filed · Alt+P Print · Alt+F2 Period · Esc Back"
      >
        {composition ? (
          <Banner tone="info" title="Composition taxpayers file CMP-08, not GSTR-3B">
            Reverse-charge tax shown here is paid through CMP-08 — open GST › CMP-08.
          </Banner>
        ) : null}
        {filing.filing ? (
          <Banner tone="success" inline>
            Marked filed on {filing.filing.filedOn}
            {filing.filing.arn ? ` (ARN ${filing.filing.arn})` : ''}.
          </Banner>
        ) : null}
        {shown?.bookAdjustments && hasBookAdjustments(shown.bookAdjustments) ? (
          <Banner tone="info" inline>
            Included from the books: {bookAdjustmentsText(shown.bookAdjustments)}.
          </Banner>
        ) : null}
        {rp.periods && rp.periods.periods.length === 0 ? (
          <Banner tone="info" title="No return periods yet">
            Return periods start from the date your books begin. Record a sale or purchase to see it here.
          </Banner>
        ) : shown ? (
          <Gstr3bForm
            summary={shown}
            draft={draft}
            onDraft={setDraft}
            dirty={dirty}
            changes={changes}
            canEdit={canFile}
            fieldErrors={save.fieldErrors}
            onSave={() => void doSave()}
            onExceptions={() => nav.push('gst.exceptions', { from: shown.period.from, to: shown.period.to })}
          />
        ) : null}
      </ReportScreen>
      <FileResultDialog result={result} onClose={() => setResult(null)} />
      {marking && shown && rp.key ? (
        <MarkFiledDialog
          form="gstr3b"
          period={rp.key}
          periodLabel={shown.period.label}
          onClose={(done) => {
            setMarking(false);
            if (done) filing.refetch();
          }}
        />
      ) : null}
    </>
  );
}

/** Any GST entry of the books other than invoices (advances, stat journals, bills of entry) in this return. */
function hasBookAdjustments(b: NonNullable<Gstr3bSummary['bookAdjustments']>): boolean {
  return [b.advances, b.rcmLiability, b.rcmCredit, b.reversalRules, b.reversalOthers, b.reclaimed, b.billOfEntry].some((t) => taxSum(t) !== 0);
}

function bookAdjustmentsText(b: NonNullable<Gstr3bSummary['bookAdjustments']>): string {
  const parts: string[] = [];
  const add = (label: string, v: number) => {
    if (v !== 0) parts.push(`${label} ${formatMoney(v)}`);
  };
  add('tax on advances (net 11A − 11B) in 3.1(a)', taxSum(b.advances));
  add('reverse-charge journals in 3.1(d)', taxSum(b.rcmLiability));
  add('ITC reversed under Rules 38 / 42 / 43 / s.17(5) in 4(B)(1)', taxSum(b.reversalRules));
  add('other ITC reversals (Rules 37 / 37A) in 4(B)(2)', taxSum(b.reversalOthers));
  add('ITC reclaimed in 4(D)(1)', taxSum(b.reclaimed));
  add('bill-of-entry IGST adjustment in 4(A)(1)', taxSum(b.billOfEntry));
  return parts.join('; ');
}

// ───────────────────────────── Form ─────────────────────────────

interface FormProps {
  summary: Gstr3bSummary;
  draft: AdjustmentDraft;
  onDraft: (d: AdjustmentDraft) => void;
  dirty: boolean;
  changes: number;
  canEdit: boolean;
  fieldErrors: Record<string, string>;
  onSave: () => void;
  onExceptions: () => void;
}

function Gstr3bForm({ summary: s, draft, onDraft, dirty, changes, canEdit, fieldErrors, onSave, onExceptions }: FormProps) {
  const cash = s.payment.rows;
  return (
    <div className="bx-gst-scroll">
      <GstHelp>
        Your summary return worked out from the books. Type the figures only the portal knows under “Your entries”, save them with Ctrl+A, then pay the cash shown
        in 6.1 and upload the JSON (Alt+J) or copy the figures into the portal.
      </GstHelp>
      {s.issueCount.errors > 0 ? (
        <Banner
          tone="danger"
          title={`${s.issueCount.errors} ${s.issueCount.errors === 1 ? 'entry has' : 'entries have'} GST errors`}
          action={
            <Button size="sm" onClick={onExceptions}>
              Review (Alt+X)
            </Button>
          }
        >
          Fix them before filing — they can change the figures below.
        </Banner>
      ) : s.issueCount.warnings > 0 ? (
        <Banner tone="warning" inline action={<Button size="sm" variant="ghost" onClick={onExceptions}>Review</Button>}>
          {s.issueCount.warnings} {s.issueCount.warnings === 1 ? 'warning' : 'warnings'} in this period are worth a look.
        </Banner>
      ) : null}
      {dirty ? (
        <Banner tone="warning" title={`${changes} unsaved ${changes === 1 ? 'change' : 'changes'}`} action={<Button size="sm" variant="primary" shortcut="Ctrl+A" onClick={onSave}>Save</Button>}>
          Net ITC, the set-off and the cash to pay are recalculated when you save.
        </Banner>
      ) : null}

      <div className="bx-gst-cashline" role="status" aria-live="polite">
        <span>Cash to pay for {s.period.label}</span>
        <span className="bx-gst-cashline__amount">{formatMoney(s.payment.cashTotal, { symbol: true })}</span>
        <span>
          {cash
            .filter((r) => r.totalCash > 0)
            .map((r) => `${r.label} ${money(r.totalCash)}`)
            .join(' · ') || 'Nothing to pay in cash'}
        </span>
      </div>

      <Panel title="3.1 Outward supplies and inward supplies liable to reverse charge" headingLevel={2}>
        <SupplyTable rows={s.supplies} caption="Values for the period, net of credit and debit notes." />
      </Panel>

      <Panel title="3.1.1 Supplies through e-commerce operators" headingLevel={2} collapsible defaultCollapsed>
        <SupplyTable rows={s.eco} caption="Not recorded in the books — fill this on the portal if you sell through an e-commerce operator." />
      </Panel>

      <Panel title="3.2 Inter-state supplies to unregistered persons, composition taxpayers and UIN holders" headingLevel={2}>
        <InterStateTable summary={s} />
      </Panel>

      <Panel title="4 Eligible ITC" headingLevel={2} description={s.itc.blocked && sumHeads(s.itc.blocked) > 0 ? `Includes ${formatMoney(sumHeads(s.itc.blocked), { symbol: true })} blocked under s.17(5), which is reversed again in 4(B)(1).` : undefined}>
        <ItcTable summary={s} />
      </Panel>

      <Panel title="5 Exempt, nil-rated and non-GST inward supplies" headingLevel={2}>
        <table className="bx-gst-form">
          <thead>
            <tr>
              <th scope="col">Nature of supplies</th>
              <th scope="col" className="is-num">
                Inter-state
              </th>
              <th scope="col" className="is-num">
                Intra-state
              </th>
            </tr>
          </thead>
          <tbody>
            {s.inward.map((r) => (
              <tr key={r.ty}>
                <th scope="row">{r.label}</th>
                <td className="is-num">{money(r.inter)}</td>
                <td className="is-num">{money(r.intra)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="5.1 Interest and late fee" headingLevel={2}>
        <HeadTable
          rows={[
            { key: 'interest', row: '', label: 'Interest', values: s.interest },
            { key: 'lateFee', row: '', label: 'Late fee', values: s.lateFee, blank: ['igst', 'cess'] },
          ]}
        />
      </Panel>

      <EntriesPanel summary={s} draft={draft} onDraft={onDraft} canEdit={canEdit} fieldErrors={fieldErrors} onSave={onSave} />

      <Panel
        title="6.1 Payment of tax"
        headingLevel={2}
        description="As on the portal: (A) tax other than reverse charge is paid first from your input tax credit, the rest in cash; (B) reverse-charge tax, interest and late fee are always paid in cash."
      >
        <PaymentTable summary={s} />
      </Panel>

      <SetOffPanel summary={s} />

      {s.notes.length > 0 ? (
        <Banner tone="info" title="Notes">
          <ul className="bx-gst-list">
            {s.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </div>
  );
}

const sumHeads = (t: { igst: number; cgst: number; sgst: number; cess: number }): number => t.igst + t.cgst + t.sgst + t.cess;

function Num({ value, blank }: { value: number; blank?: boolean }) {
  return blank ? <td className="is-num is-blank" aria-label="Not applicable" /> : <td className="is-num">{money(value)}</td>;
}

/** Heads not reported for a 3.1 row (portal greys them out). */
function blankHeads(key: Gstr3bSupplyRow['key']): ReadonlySet<TaxHead> {
  if (key === 'osup_zero') return new Set<TaxHead>(['cgst', 'sgst']);
  if (key === 'osup_nil_exmp' || key === 'osup_nongst' || key === 'eco_reg_sup') return new Set<TaxHead>(TAX_HEADS);
  return new Set<TaxHead>();
}

function TaxHeaders({ first, taxable = true }: { first: ReactNode; taxable?: boolean }) {
  return (
    <thead>
      <tr>
        <th scope="col" className="bx-gst-form__row">
          Table
        </th>
        <th scope="col">{first}</th>
        {taxable ? (
          <th scope="col" className="is-num">
            Taxable value
          </th>
        ) : null}
        {TAX_HEADS.map((h) => (
          <th key={h} scope="col" className="is-num">
            {HEAD_LABELS[h]}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function SupplyTable({ rows, caption }: { rows: readonly Gstr3bSupplyRow[]; caption: string }) {
  return (
    <table className="bx-gst-form">
      <caption>{caption}</caption>
      <TaxHeaders first="Nature of supplies" />
      <tbody>
        {rows.map((r) => {
          const blank = blankHeads(r.key);
          return (
            <tr key={r.key}>
              <td className="bx-gst-form__row">{r.row}</td>
              <th scope="row">{r.label}</th>
              <Num value={r.taxable} />
              {TAX_HEADS.map((h) => (
                <Num key={h} value={r[h]} blank={blank.has(h)} />
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function InterStateTable({ summary }: { summary: Gstr3bSummary }) {
  const rows = useMemo(() => interStateTable(summary.interState), [summary.interState]);
  if (rows.length === 0) return <p className="bx-muted">No inter-state supplies to unregistered persons, composition taxpayers or UIN holders in this period.</p>;
  return (
    <WideTable label="3.2 inter-state supplies by place of supply">
    <table className="bx-gst-form">
      <thead>
        <tr>
          <th scope="col">Place of supply</th>
          <th scope="col" className="is-num">
            Unregistered — taxable
          </th>
          <th scope="col" className="is-num">
            IGST
          </th>
          <th scope="col" className="is-num">
            Composition — taxable
          </th>
          <th scope="col" className="is-num">
            IGST
          </th>
          <th scope="col" className="is-num">
            UIN holders — taxable
          </th>
          <th scope="col" className="is-num">
            IGST
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.pos}>
            <th scope="row">{`${r.pos}-${r.posName}`}</th>
            <td className="is-num">{money(r.unregistered.taxable)}</td>
            <td className="is-num">{money(r.unregistered.igst)}</td>
            <td className="is-num">{money(r.composition.taxable)}</td>
            <td className="is-num">{money(r.composition.igst)}</td>
            <td className="is-num">{money(r.uin.taxable)}</td>
            <td className="is-num">{money(r.uin.igst)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </WideTable>
  );
}

function SourceBadge({ source }: { source: Gstr3bItcRow['source'] }) {
  if (source === 'books') return null;
  return (
    <Badge size="sm" tone={source === 'manual' ? 'info' : 'neutral'}>
      {source === 'manual' ? 'Your entry' : 'Books + your entry'}
    </Badge>
  );
}

function ItcRows({ title, rows }: { title: string; rows: readonly Gstr3bItcRow[] }) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={6} className="bx-gst-section-title">
          {title}
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.row} className="is-sub">
          <td className="bx-gst-form__row">{r.row}</td>
          <th scope="row">
            {r.label} <SourceBadge source={r.source} />
          </th>
          {TAX_HEADS.map((h) => (
            <Num key={h} value={r[h]} />
          ))}
        </tr>
      ))}
    </>
  );
}

function ItcTable({ summary: s }: { summary: Gstr3bSummary }) {
  return (
    <table className="bx-gst-form">
      <TaxHeaders first="Details" taxable={false} />
      <tbody>
        <ItcRows title="(A) ITC available (whether in full or part)" rows={s.itc.available} />
        <ItcRows title="(B) ITC reversed" rows={s.itc.reversed} />
        <tr className="is-total">
          <td className="bx-gst-form__row">4(C)</td>
          <th scope="row">Net ITC available (A) − (B)</th>
          {TAX_HEADS.map((h) => (
            <Num key={h} value={s.itc.net[h]} />
          ))}
        </tr>
        <ItcRows title="(D) Other details" rows={s.itc.ineligible} />
      </tbody>
    </table>
  );
}

function HeadTable({ rows }: { rows: Array<{ key: string; row: string; label: string; values: { igst: number; cgst: number; sgst: number; cess: number }; blank?: TaxHead[] }> }) {
  return (
    <table className="bx-gst-form">
      <thead>
        <tr>
          <th scope="col">Details</th>
          {TAX_HEADS.map((h) => (
            <th key={h} scope="col" className="is-num">
              {HEAD_LABELS[h]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.label}</th>
            {TAX_HEADS.map((h) => (
              <Num key={h} value={r.values[h]} blank={r.blank?.includes(h)} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ───────────────────────────── Manual entries ─────────────────────────────

function EntriesPanel({
  summary,
  draft,
  onDraft,
  canEdit,
  fieldErrors,
  onSave,
}: {
  summary: Gstr3bSummary;
  draft: AdjustmentDraft;
  onDraft: (d: AdjustmentDraft) => void;
  canEdit: boolean;
  fieldErrors: Record<string, string>;
  onSave: () => void;
}) {
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: onSave });
  const errors = Object.entries(fieldErrors);
  return (
    <Panel
      title="Your entries for this return"
      headingLevel={2}
      description={
        summary.adjustmentsUpdatedAt
          ? `Figures from the portal or your records. Last saved ${formatDateTime(summary.adjustmentsUpdatedAt)}.`
          : 'Figures from the portal or your records (amounts in ₹). Leave blank when they do not apply.'
      }
    >
      <Stack gap={2}>
        {errors.length > 0 ? (
          <Banner tone="danger" title="Some figures could not be saved">
            <ul className="bx-gst-list">
              {errors.map(([path, msg]) => (
                <li key={path}>{msg}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {!canEdit ? (
          <Banner tone="info" inline>
            You can view these entries; changing them needs the “Prepare GST filings” permission.
          </Banner>
        ) : null}
        <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Your GSTR-3B entries">
          <WideTable label="Your GSTR-3B entries">
          <table className="bx-gst-form">
            <TaxHeaders first="Entry" taxable={false} />
            <tbody>
              {ADJUSTMENT_FIELDS.map((f) => (
                <tr key={f.key}>
                  <td className="bx-gst-form__row">{f.row}</td>
                  <th scope="row">
                    <span>{f.label}</span>
                    <span className="bx-gst-form__help">{f.help}</span>
                  </th>
                  {TAX_HEADS.map((h) =>
                    f.heads.includes(h) ? (
                      <td key={h} className="is-input">
                        <AmountInput
                          size="sm"
                          value={draft[f.key][h]}
                          onChange={(v) => onDraft(setDraftCell(draft, f.key, h, v))}
                          blankZero
                          min={0}
                          readOnly={!canEdit}
                          invalid={!!fieldErrors[`values.${f.key}.${h}`]}
                          aria-label={`${f.row} ${f.label} — ${HEAD_LABELS[h]}`}
                        />
                      </td>
                    ) : (
                      <td key={h} className="is-blank" aria-label="Not applicable" />
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </WideTable>
        </form>
      </Stack>
    </Panel>
  );
}

// ───────────────────────────── 6.1 ─────────────────────────────

function PaymentTable({ summary: s }: { summary: Gstr3bSummary }) {
  const sections = useMemo(() => paymentSections(s.payment), [s.payment]);
  const cell = (v: number | null) => (v === null ? <td className="is-num is-blank" aria-label="Not applicable" /> : <td className="is-num">{money(v)}</td>);
  const row = (l: PaymentLine, id: 'A' | 'B') => (
    <tr key={`${id}:${l.head}`} className="is-sub">
      <th scope="row">{l.label}</th>
      <td className="is-num">{money(l.payable)}</td>
      {TAX_HEADS.map((h) => (
        <Fragment key={h}>{cell(l.itc[h])}</Fragment>
      ))}
      <td className="is-num">{money(l.cash)}</td>
      {cell(l.interest)}
      {cell(l.lateFee)}
    </tr>
  );
  return (
    <WideTable label="6.1 payment of tax">
      <table className="bx-gst-form">
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              Description
            </th>
            <th scope="col" rowSpan={2} className="is-num">
              Tax payable
            </th>
            <th scope="colgroup" colSpan={4} className="is-num">
              Paid through ITC
            </th>
            <th scope="col" rowSpan={2} className="is-num">
              Tax paid in cash
            </th>
            <th scope="col" rowSpan={2} className="is-num">
              Interest paid in cash
            </th>
            <th scope="col" rowSpan={2} className="is-num">
              Late fee paid in cash
            </th>
          </tr>
          <tr>
            {TAX_HEADS.map((h) => (
              <th key={h} scope="col" className="is-num">
                {HEAD_LABELS[h]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((sec) => (
            <Fragment key={sec.id}>
              <tr>
                <th scope="rowgroup" colSpan={9} className="bx-gst-section-title">
                  {sec.title}
                </th>
              </tr>
              {sec.lines.map((l) => row(l, sec.id))}
            </Fragment>
          ))}
          <tr className="is-total">
            <th scope="row" colSpan={6}>
              Total to pay in cash (tax, interest and late fee)
            </th>
            <td className="is-num bx-gst-cash" colSpan={3}>
              {formatMoney(s.payment.cashTotal, { symbol: true })}
            </td>
          </tr>
        </tbody>
      </table>
    </WideTable>
  );
}

function SetOffPanel({ summary: s }: { summary: Gstr3bSummary }) {
  const lines = useMemo(
    () => setOffLines(s.payment.setOff, s.payment.creditAvailable, s.payment.broughtForward),
    [s.payment.setOff, s.payment.creditAvailable, s.payment.broughtForward],
  );
  return (
    <Panel title="How your ITC is used" headingLevel={2} description={SET_OFF_RULE} collapsible>
      <Stack gap={3}>
        <ul className="bx-gst-setoff">
          {lines.map((l) => (
            <li key={l.credit}>{setOffSentence(l)}</li>
          ))}
        </ul>
        <table className="bx-gst-form">
          <thead>
            <tr>
              <th scope="col">Credit</th>
              <th scope="col" className="is-num">
                Brought forward
              </th>
              <th scope="col" className="is-num">
                Available
              </th>
              {TAX_HEADS.map((h) => (
                <th key={h} scope="col" className="is-num">
                  Used for {HEAD_LABELS[h]}
                </th>
              ))}
              <th scope="col" className="is-num">
                Carried forward
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.credit}>
                <th scope="row">{HEAD_LABELS[l.credit]} credit</th>
                <td className="is-num">{money(l.broughtForward)}</td>
                <td className="is-num">{money(l.available)}</td>
                {TAX_HEADS.map((h) => (
                  <Num key={h} value={s.payment.setOff.utilisation[l.credit][h]} blank={!creditMayPay(l.credit, h)} />
                ))}
                <td className="is-num">{money(l.carriedForward)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Stack>
    </Panel>
  );
}


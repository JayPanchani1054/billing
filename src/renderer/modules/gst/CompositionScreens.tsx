/**
 * Composition levy (s.10 CGST Act) screens:
 *   'gst.cmp08'       {period?} — CMP-08 quarterly statement from the books: Table 3 (outward supplies
 *                     incl. exempt, inward reverse-charge supplies incl. import of services, tax payable,
 *                     interest) and Table 4 (paid through the set-off). Alt+I interest, Alt+S set-off,
 *                     Alt+F mark filed, Alt+J / Alt+K save the statement (JSON / CSV, Bahi's own format).
 *   'gst.gstr4'       {fy?}     — GSTR-4 annual return data: tables 4A–4D, 5, 6 and 8.
 *   'gst.composition' —         — the company's composition category and the effective-dated rate
 *                     master (Alt+C create, Enter / Alt+A alter, Alt+D delete).
 * The screens explain themselves for a regular taxpayer (they file GSTR-1 / GSTR-3B instead).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Cmp08Row, Cmp08Summary, CompositionCategory, CompositionRate, Gstr4InwardRow, Gstr4QuarterRow, Gstr4RateRow, Gstr4Summary } from '../../../shared/types/gst-plus.ts';
import { COMPOSITION_CATEGORIES, COMPOSITION_CATEGORY_LABELS } from '../../../shared/types/gst-plus.ts';
import type { TaxAmounts } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import { api, formatDate, formatMoney, ReportScreen, Screen, useApiMutation, useApiQuery, useCan, useConfirm, useNav, useWorkingDate, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { AmountInput, Badge, Banner, Button, DataTable, DateInput, EmptyState, Field, Grid, Hotkeys, KpiCard, Modal, Panel, PercentInput, Select, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { FileResultDialog, GstHelp, WideTable } from './components.tsx';
import type { FileResult } from './components.tsx';
import { cmp08TableExport, gstr4TableExport, HEAD_NAMES, rateFormErrors, taxSum } from './lib/gstplus.ts';
import { fyList, initialFy } from './lib/periods.ts';
import { MarkFiledDialog, saveTextFile, useFiling, usePlusPeriod } from './plusComponents.tsx';

const money = (p: number): string => formatMoney(p);

function NotComposition({ onOpen, form }: { onOpen: () => void; form: string }) {
  return (
    <EmptyState
      icon="gst"
      title={`${form} is for composition taxpayers`}
      body="This company is registered as a regular taxpayer (Company › GST details): it files GSTR-1 and GSTR-3B. Change the registration type there if you opted for composition."
      action={<Button onClick={onOpen}>Open GSTR-3B</Button>}
    />
  );
}

// ───────────────────────────── CMP-08 ─────────────────────────────

export function Cmp08Screen({ params }: ScreenProps<{ period?: string }>) {
  const nav = useNav();
  const canFile = useCan('gst.file');
  const pp = usePlusPeriod(params?.period);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const enabled = pp.composition && pp.key !== null;
  const q = useApiQuery('gst.cmp08.summary', { period: pp.key ?? '' }, { enabled, keepPrevious: true });
  const s = enabled ? q.data : undefined;
  const { filing, refetch: refetchFiling } = useFiling('cmp08', pp.key);
  const [dialog, setDialog] = useState<'interest' | 'filed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FileResult | null>(null);
  const toast = useToast();

  const save = async (format: 'json' | 'csv'): Promise<void> => {
    if (!s || !pp.key || busy) return;
    setBusy(true);
    try {
      const file = await api('gst.cmp08.export', { period: pp.key, format });
      const path = await saveTextFile(file, `Save CMP-08 ${format.toUpperCase()}`);
      if (path) {
        setResult({
          title: 'CMP-08 statement saved',
          path,
          summary: `CMP-08 for ${s.period.label}${s.gstin ? ` · GSTIN ${s.gstin}` : ''}`,
          warnings: file.warnings,
          nextStep: 'File CMP-08 on the GST portal (Services › Returns › Statement for payment of self-assessed tax) using these figures, then press Alt+F here.',
        });
      }
    } catch (err) {
      toast.error('Could not create the CMP-08 file', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const actions: ScreenActionItem[] = [
    { key: 'Alt+F2', label: 'Quarter', icon: 'calendar', onClick: () => selectRef.current?.focus(), group: 'period' },
    { key: 'Alt+J', label: 'Save JSON', icon: 'download', primary: true, onClick: () => void save('json'), disabled: !s || busy || !canFile, group: 'file' },
    { key: 'Alt+K', label: 'Save CSV', icon: 'download', onClick: () => void save('csv'), disabled: !s || busy || !canFile, group: 'file' },
    { key: 'Alt+I', label: 'Interest', icon: 'edit', onClick: () => setDialog('interest'), disabled: !s || !canFile, group: 'edit' },
    { key: 'Alt+F', label: filing ? 'Filed' : 'Mark filed', icon: 'check', onClick: () => setDialog('filed'), disabled: !s || !canFile || filing !== null, group: 'edit' },
    { key: 'Alt+S', label: 'GST set-off', icon: 'gst', onClick: () => pp.key && nav.push('gst.setoff', { period: pp.key }), disabled: !pp.key, group: 'go' },
    { key: 'Alt+R', label: 'GSTR-4', icon: 'gst', onClick: () => nav.push('gst.gstr4', s ? { fy: s.period.key?.slice(0, 7) } : {}), group: 'go' },
  ];
  return (
    <>
      <ReportScreen
        title="CMP-08"
        subtitle={pp.label ? `Statement for payment of self-assessed tax · ${pp.label}` : 'Statement for payment of self-assessed tax'}
        periodMode="none"
        filters={pp.composition ? pp.select(selectRef) : undefined}
        actions={actions}
        exportDef={s ? () => ({ ...cmp08TableExport(s), title: 'CMP-08', period: s.period.label }) : undefined}
        loading={pp.loading || (enabled && q.loading && !s)}
        refreshing={q.refreshing || busy}
        error={pp.error ?? (enabled ? q.error : null)}
        onRetry={() => (pp.error ? pp.refetch() : void q.refetch())}
        hint="Alt+J JSON · Alt+K CSV · Alt+I Interest · Alt+F Mark filed · Alt+S Set-off · Alt+F2 Quarter · Alt+E Export · Esc Back"
      >
        {!pp.loading && !pp.composition && pp.key !== null ? (
          <NotComposition form="CMP-08" onOpen={() => nav.push('gst.gstr3b')} />
        ) : s ? (
          <Cmp08Body s={s} filed={filing?.filedOn ?? null} />
        ) : pp.key === null && !pp.loading ? (
          <EmptyState icon="calendar" title="No quarter yet" body="Record a sale or purchase to prepare CMP-08." />
        ) : null}
      </ReportScreen>
      {dialog === 'interest' && s ? <InterestDialog s={s} onClose={() => setDialog(null)} /> : null}
      {dialog === 'filed' && s && s.period.key ? (
        <MarkFiledDialog
          form="cmp08"
          period={s.period.key}
          periodLabel={s.period.label}
          onClose={(done) => {
            setDialog(null);
            if (done) refetchFiling();
          }}
        />
      ) : null}
      <FileResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

function Cmp08Body({ s, filed }: { s: Cmp08Summary; filed: string | null }) {
  const cols = useMemo<Column<Cmp08Row>[]>(
    () => [
      { key: 'row', header: 'Sl.', width: 60 },
      { key: 'label', header: 'Description', minWidth: 260 },
      { key: 'taxable', header: 'Value', kind: 'amount', width: 150, blankZero: true },
      ...TAX_HEADS.map((h): Column<Cmp08Row> => ({ key: h, header: HEAD_NAMES[h], kind: 'amount', width: 130, blankZero: true })),
    ],
    [],
  );
  const payable = s.table3.find((r) => r.key === 'payable');
  const paidTotal = taxSum(s.paid) + s.paid.interest;
  return (
    <div className="bx-gst-scroll">
      <GstHelp>
        Composition tax on your turnover for the quarter, plus tax on purchases under reverse charge, paid in cash with CMP-08 by the 18th of the month after the quarter.
        Bills of Supply carry no tax: it comes out of your own pocket.
      </GstHelp>
      {filed ? (
        <Banner tone="success" title={`Marked filed on ${formatDate(filed)}`}>
          Later changes to this quarter's documents do not change what was filed; correct them in the next statement or GSTR-4.
        </Banner>
      ) : null}
      <Grid minItemWidth={180} gap={3}>
        <KpiCard label="Turnover" value={s.turnover.total} amount caption={`Taxable ${money(s.turnover.taxable)} · Exempt ${money(s.turnover.exempt)}`} />
        <KpiCard label="Tax base" value={s.turnover.taxBase} amount caption={`${s.rate}% · ${s.basis === 'turnover' ? 'on turnover' : 'on taxable turnover'}`} />
        <KpiCard label="Tax payable" value={payable ? taxSum(payable) : 0} amount caption="Row 3 (1 + 2)" />
        <KpiCard label="Paid (set-off)" value={paidTotal} amount caption={paidTotal === 0 ? 'Not posted yet — Alt+S' : 'Cash used by the set-off'} />
      </Grid>
      {s.notes.length > 0 ? (
        <Banner tone="info" title="Notes">
          <ul className="bx-gst-list">
            {s.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <Panel title={`Table 3 · Summary of self-assessed liability (${COMPOSITION_CATEGORY_LABELS[s.category]})`} headingLevel={2} description={`${s.outwardDocs} outward and ${s.rcmDocs} reverse-charge document(s).`}>
        <DataTable<Cmp08Row> aria-label="CMP-08 table 3" autoFocus columns={cols} rows={s.table3} getRowKey={(r) => r.key} height={40 + 32 * (s.table3.length + 1)} />
      </Panel>
      <Panel title="Table 4 · Tax paid (from the set-off journal)" headingLevel={2}>
        <WideTable label="CMP-08 table 4">
          <thead>
            <tr>
              <th scope="col">Paid in cash</th>
              {TAX_HEADS.map((h) => (
                <th key={h} scope="col" className="is-num">
                  {HEAD_NAMES[h]}
                </th>
              ))}
              <th scope="col" className="is-num">Interest</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Tax and interest</th>
              {TAX_HEADS.map((h) => (
                <td key={h} className="is-num">
                  {money(s.paid[h])}
                </td>
              ))}
              <td className="is-num">{money(s.paid.interest)}</td>
            </tr>
          </tbody>
        </WideTable>
      </Panel>
    </div>
  );
}

function InterestDialog({ s, onClose }: { s: Cmp08Summary; onClose: () => void }) {
  const toast = useToast();
  const current = s.table3.find((r) => r.key === 'interest');
  const [t, setT] = useState<TaxAmounts>({ igst: current?.igst ?? 0, cgst: current?.cgst ?? 0, sgst: current?.sgst ?? 0, cess: current?.cess ?? 0 });
  const save = useApiMutation('gst.cmp08.saveInterest', { invalidates: ['gst'] });
  const accept = async (): Promise<void> => {
    if (!s.period.key || save.pending) return;
    try {
      await save.mutate({ period: s.period.key, interest: t });
      toast.success('Interest saved');
      onClose();
    } catch (err) {
      toast.error('Could not save the interest', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void accept() });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Interest for ${s.period.label}`}
      description="Interest under s.50 on tax paid late (row 4). It is paid in cash with the statement."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} onClick={() => void accept()}>
            Save
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void accept() }} />
      <div ref={formRef}>
        <div className="bx-gst-formgrid">
          {TAX_HEADS.map((h, i) => (
            <Field key={h} label={HEAD_NAMES[h]}>
              <AmountInput data-autofocus={i === 1 ? true : undefined} value={t[h] || null} onChange={(v) => setT({ ...t, [h]: v ?? 0 })} />
            </Field>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────────── GSTR-4 ─────────────────────────────

export function Gstr4Screen({ params }: ScreenProps<{ fy?: string }>) {
  const nav = useNav();
  const toast = useToast();
  const canFile = useCan('gst.file');
  const { date: workingDate } = useWorkingDate();
  const periods = useApiQuery('gst.periods', {}, { staleTime: 60_000 });
  const composition = periods.data?.registration === 'composition';
  const years = useMemo(() => fyList(periods.data), [periods.data]);
  const [fy, setFy] = useState<string | null>(null);
  useEffect(() => {
    if (fy === null && periods.data) setFy(initialFy(periods.data, workingDate, params?.fy));
  }, [fy, periods.data, workingDate, params?.fy]);
  const enabled = composition && fy !== null;
  const q = useApiQuery('gst.gstr4.summary', { fy: fy ?? '' }, { enabled, keepPrevious: true });
  const s = enabled ? q.data : undefined;
  const { filing, refetch: refetchFiling } = useFiling('gstr4', fy);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FileResult | null>(null);
  const [marking, setMarking] = useState(false);

  const save = async (format: 'json' | 'csv'): Promise<void> => {
    if (!s || busy) return;
    setBusy(true);
    try {
      const file = await api('gst.gstr4.export', { fy: s.fy, format });
      const path = await saveTextFile(file, `Save GSTR-4 ${format.toUpperCase()}`);
      if (path) {
        setResult({
          title: 'GSTR-4 data saved',
          path,
          summary: `GSTR-4 for FY ${s.fy}${s.gstin ? ` · GSTIN ${s.gstin}` : ''}`,
          warnings: file.warnings,
          nextStep: 'Fill GSTR-4 on the GST portal (or in the GSTR-4 offline tool) from these tables, by 30 April after the year, then press Alt+F here.',
        });
      }
    } catch (err) {
      toast.error('Could not create the GSTR-4 file', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const actions: ScreenActionItem[] = [
    { key: 'Alt+F2', label: 'Financial year', icon: 'calendar', onClick: () => selectRef.current?.focus(), group: 'period' },
    { key: 'Alt+J', label: 'Save JSON', icon: 'download', primary: true, onClick: () => void save('json'), disabled: !s || busy || !canFile, group: 'file' },
    { key: 'Alt+K', label: 'Save CSV', icon: 'download', onClick: () => void save('csv'), disabled: !s || busy || !canFile, group: 'file' },
    { key: 'Alt+F', label: filing ? 'Filed' : 'Mark filed', icon: 'check', onClick: () => setMarking(true), disabled: !s || !canFile || filing !== null, group: 'edit' },
  ];
  return (
    <>
      <ReportScreen
        title="GSTR-4"
        subtitle={fy ? `Annual return for composition taxpayers · FY ${fy}` : 'Annual return for composition taxpayers'}
        periodMode="none"
        filters={
          composition ? (
            <label className="bx-gst-period">
              <span className="bx-gst-period__label">Financial year</span>
              <Select
                ref={selectRef}
                size="sm"
                aria-label="Financial year"
                aria-keyshortcuts="Alt+F2"
                value={fy ?? ''}
                placeholder={periods.data ? 'Choose a year' : 'Loading…'}
                disabled={years.length === 0}
                options={years.map((y) => ({ value: y, label: `FY ${y}` }))}
                onChange={(v) => setFy(v)}
              />
            </label>
          ) : undefined
        }
        actions={actions}
        exportDef={s ? () => ({ ...gstr4TableExport(s), title: 'GSTR-4', period: `FY ${s.fy}` }) : undefined}
        loading={periods.loading || (enabled && q.loading && !s)}
        refreshing={q.refreshing || busy}
        error={periods.error ?? (enabled ? q.error : null)}
        onRetry={() => void (periods.error ? periods.refetch() : q.refetch())}
        hint="Enter Open quarter's CMP-08 · Alt+J JSON · Alt+K CSV · Alt+F Mark filed · Alt+F2 Year · Alt+E Export · Esc Back"
      >
        {periods.data && !composition ? (
          <NotComposition form="GSTR-4" onOpen={() => nav.push('gst.gstr3b')} />
        ) : s ? (
          <Gstr4Body s={s} filed={filing?.filedOn ?? null} onQuarter={(r) => nav.push('gst.cmp08', { period: r.quarter })} />
        ) : years.length === 0 && periods.data ? (
          <EmptyState icon="calendar" title="No financial year to show" body="Record sales or purchases to prepare GSTR-4." />
        ) : null}
      </ReportScreen>
      {marking && s ? (
        <MarkFiledDialog
          form="gstr4"
          period={s.fy}
          periodLabel={`FY ${s.fy}`}
          onClose={(done) => {
            setMarking(false);
            if (done) refetchFiling();
          }}
        />
      ) : null}
      <FileResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

function Gstr4Body({ s, filed, onQuarter }: { s: Gstr4Summary; filed: string | null; onQuarter: (r: Gstr4QuarterRow) => void }) {
  const qCols = useMemo<Column<Gstr4QuarterRow>[]>(
    () => [
      { key: 'label', header: 'Quarter', minWidth: 170, render: (r) => (r.filed ? r.label : `${r.label} · not filed`) },
      { key: 'outwardValue', header: 'Outward value', kind: 'amount', width: 140, total: true },
      { key: 'outTax', header: 'Composition tax', kind: 'amount', width: 140, total: true, value: (r) => taxSum(r.outwardTax) },
      { key: 'rcmValue', header: 'RCM value', kind: 'amount', width: 130, total: true, blankZero: true },
      { key: 'rcmTax', header: 'RCM tax', kind: 'amount', width: 120, total: true, blankZero: true, value: (r) => taxSum(r.rcmTax) },
      { key: 'interest', header: 'Interest', kind: 'amount', width: 110, total: true, blankZero: true, value: (r) => taxSum(r.interest) },
      { key: 'paid', header: 'Paid', kind: 'amount', width: 130, total: true },
    ],
    [],
  );
  const inCols = useMemo<Column<Gstr4InwardRow>[]>(
    () => [
      { key: 'key', header: 'Table', width: 70 },
      { key: 'who', header: 'Supplier / rate', minWidth: 220, value: (r) => r.partyName ?? (r.rate !== null ? `${r.rate}%` : r.label) },
      { key: 'gstin', header: 'GSTIN', width: 160, value: (r) => r.gstin ?? '' },
      { key: 'documents', header: 'Docs', kind: 'number', width: 70, total: true },
      { key: 'taxable', header: 'Value', kind: 'amount', width: 140, total: true },
      ...TAX_HEADS.map((h): Column<Gstr4InwardRow> => ({ key: h, header: HEAD_NAMES[h], kind: 'amount', width: 120, total: true, blankZero: true })),
    ],
    [],
  );
  const rCols = useMemo<Column<Gstr4RateRow>[]>(
    () => [
      { key: 'kind', header: 'Supplies', minWidth: 220, value: (r) => (r.kind === 'outward' ? 'Outward (composition rate)' : 'Inward under reverse charge') },
      { key: 'rate', header: 'Rate', width: 80, value: (r) => `${r.rate}%` },
      { key: 'taxable', header: 'Value', kind: 'amount', width: 140 },
      ...TAX_HEADS.map((h): Column<Gstr4RateRow> => ({ key: h, header: HEAD_NAMES[h], kind: 'amount', width: 120, blankZero: true })),
    ],
    [],
  );
  return (
    <div className="bx-gst-scroll">
      <Banner tone="warning" title={s.caption}>
        Prepared from your books. Compare with your CMP-08 statements and GSTR-4A on the portal before filing.
      </Banner>
      {filed ? <Badge tone="success">Marked filed on {formatDate(filed)}</Badge> : null}
      {s.notes.length > 0 ? (
        <Banner tone="info" title="Notes">
          <ul className="bx-gst-list">
            {s.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <Panel title="Table 5 · Summary of CMP-08 for each quarter" headingLevel={2} description="Enter opens the quarter's CMP-08.">
        <DataTable<Gstr4QuarterRow> aria-label="GSTR-4 table 5" autoFocus columns={qCols} rows={s.table5} getRowKey={(r) => r.quarter} onRowActivate={onQuarter} height={40 + 32 * (s.table5.length + 2)} />
      </Panel>
      <Panel title="Table 4 · Inward supplies (4A registered, 4B registered under reverse charge, 4C unregistered, 4D import of services)" headingLevel={2}>
        <DataTable<Gstr4InwardRow>
          aria-label="GSTR-4 table 4"
          columns={inCols}
          rows={s.table4}
          getRowKey={(r, i) => `${r.key}:${i}`}
          height={Math.min(420, 40 + 32 * (s.table4.length + 2))}
          empty={<EmptyState size="sm" title="No inward supplies in the year" />}
        />
      </Panel>
      <Panel title="Table 6 · Tax rate-wise outward supplies and inward reverse-charge supplies" headingLevel={2}>
        <DataTable<Gstr4RateRow> aria-label="GSTR-4 table 6" columns={rCols} rows={s.table6} getRowKey={(r) => `${r.kind}:${r.rate}`} height={40 + 32 * (s.table6.length + 1)} empty={<EmptyState size="sm" title="Nothing to show" />} />
      </Panel>
      <Panel title="Table 8 · Tax payable and paid" headingLevel={2}>
        <WideTable label="GSTR-4 table 8">
          <thead>
            <tr>
              <th scope="col">Particulars</th>
              {TAX_HEADS.map((h) => (
                <th key={h} scope="col" className="is-num">
                  {HEAD_NAMES[h]}
                </th>
              ))}
              <th scope="col" className="is-num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Tax payable</th>
              {TAX_HEADS.map((h) => (
                <td key={h} className="is-num">
                  {money(s.table8.payable[h])}
                </td>
              ))}
              <td className="is-num">{money(taxSum(s.table8.payable))}</td>
            </tr>
            <tr>
              <th scope="row">Interest</th>
              {TAX_HEADS.map((h) => (
                <td key={h} className="is-num">
                  {money(s.table8.interest[h])}
                </td>
              ))}
              <td className="is-num">{money(taxSum(s.table8.interest))}</td>
            </tr>
            <tr>
              <th scope="row">Paid (through CMP-08)</th>
              <td colSpan={TAX_HEADS.length} />
              <td className="is-num bx-gst-cash">{money(s.table8.paid)}</td>
            </tr>
          </tbody>
        </WideTable>
      </Panel>
    </div>
  );
}

// ───────────────────────────── Composition rates ─────────────────────────────

export function CompositionRatesScreen() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canFile = useCan('gst.file');
  const q = useApiQuery('gst.composition.settings', {});
  const periods = useApiQuery('gst.periods', {}, { staleTime: 60_000 });
  const saveCategory = useApiMutation('gst.composition.saveCategory', { invalidates: ['gst'] });
  const del = useApiMutation('gst.composition.deleteRate', { invalidates: ['gst'] });
  const [editing, setEditing] = useState<CompositionRate | 'new' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const st = q.data;
  const rows = st?.rates ?? [];
  const current = rows.find((r) => String(r.id) === selected) ?? rows[0] ?? null;
  const cols = useMemo<Column<CompositionRate>[]>(
    () => [
      { key: 'category', header: 'Category', minWidth: 200, value: (r) => COMPOSITION_CATEGORY_LABELS[r.category] },
      { key: 'effectiveFrom', header: 'Effective from', kind: 'date', width: 130 },
      { key: 'rate', header: 'Rate (CGST + SGST)', width: 150, align: 'right', value: (r) => `${r.rate}%` },
      { key: 'basis', header: 'On', width: 170, value: (r) => (r.basis === 'turnover' ? 'Turnover in the State' : 'Taxable turnover') },
      { key: 'note', header: 'Note', minWidth: 260, value: (r) => r.note ?? '' },
    ],
    [],
  );
  const changeCategory = async (c: CompositionCategory): Promise<void> => {
    try {
      await saveCategory.mutate({ category: c });
      toast.success(`Category set to ${COMPOSITION_CATEGORY_LABELS[c]}`);
    } catch (err) {
      toast.error('Could not change the category', { message: userMessage(err) });
    }
  };
  const remove = async (r: CompositionRate | null): Promise<void> => {
    if (!r || !canFile) return;
    const ok = await confirm({ title: 'Delete this rate?', message: `${COMPOSITION_CATEGORY_LABELS[r.category]} ${r.rate}% from ${formatDate(r.effectiveFrom)}. Documents from that date will use the previous rate.`, confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try {
      await del.mutate({ id: r.id });
      toast.success('Rate deleted');
    } catch (err) {
      toast.error('Could not delete the rate', { message: userMessage(err) });
    }
  };
  const actions: ScreenActionItem[] = [
    { key: 'Alt+C', label: 'Create rate', icon: 'plus', primary: true, onClick: () => setEditing('new'), disabled: !canFile, group: 'edit' },
    { key: 'Alt+A', label: 'Alter rate', icon: 'edit', onClick: () => current && setEditing(current), disabled: !canFile || !current, group: 'edit' },
    { key: 'Alt+D', label: 'Delete rate', icon: 'trash', onClick: () => void remove(current), disabled: !canFile || !current, group: 'danger' },
    { key: 'Alt+R', label: 'CMP-08', icon: 'gst', onClick: () => nav.push('gst.cmp08'), group: 'go' },
  ];
  return (
    <>
      <Screen
        title="Composition Rates"
        subtitle="Composition levy rate master (effective-dated)"
        icon="gst"
        actions={actions}
        loading={q.loading}
        error={q.error}
        onRetry={() => void q.refetch()}
        hint="Alt+C Create · Enter / Alt+A Alter · Alt+D Delete · Esc Back"
      >
        {st ? (
          <Stack gap={3}>
            {periods.data && periods.data.registration !== 'composition' ? (
              <Banner tone="info" inline>
                This company is not registered under composition: these rates are used only if you opt in (Company › GST details).
              </Banner>
            ) : null}
            <GstHelp>
              Composition tax = rate × turnover of each document's date. Rates as notified under Rule 7 (manufacturers 1%, traders 1% of taxable turnover, restaurants
              5%, s.10(2A) service providers 6%; half CGST, half SGST/UTGST). Check them against the current notifications and correct them here if they change.
            </GstHelp>
            <Field label="Your category" hint="Decides which rate applies to your turnover" htmlFor="bx-cmp-category">
              <Select
                id="bx-cmp-category"
                value={st.category}
                disabled={!canFile || saveCategory.pending}
                options={COMPOSITION_CATEGORIES.map((c) => ({ value: c, label: COMPOSITION_CATEGORY_LABELS[c] }))}
                onChange={(v) => void changeCategory(v as CompositionCategory)}
              />
            </Field>
            <DataTable<CompositionRate>
              aria-label="Composition rates"
              autoFocus
              columns={cols}
              rows={rows}
              getRowKey={(r) => String(r.id)}
              selectedKey={current ? String(current.id) : null}
              onSelect={(k) => setSelected(k)}
              onRowActivate={(r) => canFile && setEditing(r)}
              height={Math.min(420, 40 + 32 * (rows.length + 1))}
              empty={<EmptyState size="sm" title="No rates" body="Press Alt+C to add the rate for your category." />}
            />
          </Stack>
        ) : null}
      </Screen>
      {editing ? <RateDialog rate={editing === 'new' ? null : editing} category={st?.category ?? 'trader'} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function RateDialog({ rate, category, onClose }: { rate: CompositionRate | null; category: CompositionCategory; onClose: () => void }) {
  const toast = useToast();
  const { date } = useWorkingDate();
  const [cat, setCat] = useState<CompositionCategory>(rate?.category ?? category);
  const [from, setFrom] = useState<string | null>(rate?.effectiveFrom ?? date);
  const [pct, setPct] = useState<number | null>(rate?.rate ?? null);
  const [basis, setBasis] = useState<'turnover' | 'taxable_turnover'>(rate?.basis ?? 'turnover');
  const [note, setNote] = useState(rate?.note ?? '');
  const save = useApiMutation('gst.composition.saveRate', { invalidates: ['gst'] });
  const errs = rateFormErrors({ effectiveFrom: from, rate: pct });
  const accept = async (): Promise<void> => {
    if (save.pending || errs.effectiveFrom || errs.rate) return;
    try {
      await save.mutate({ id: rate?.id, category: cat, effectiveFrom: from as string, rate: pct as number, basis, note: note.trim() || undefined });
      toast.success(rate ? 'Rate altered' : 'Rate created');
      onClose();
    } catch (err) {
      toast.error('Could not save the rate', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void accept() });
  return (
    <Modal
      open
      onClose={onClose}
      title={rate ? 'Alter composition rate' : 'Create composition rate'}
      description="The rate applies to documents dated on or after the effective date, until a later rate starts."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} disabled={Boolean(errs.effectiveFrom || errs.rate)} onClick={() => void accept()}>
            Save
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void accept() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="Category" required>
            <Select data-autofocus value={cat} options={COMPOSITION_CATEGORIES.map((c) => ({ value: c, label: COMPOSITION_CATEGORY_LABELS[c] }))} onChange={(v) => setCat(v as CompositionCategory)} />
          </Field>
          <Field label="Effective from" required error={from !== null ? (save.fieldErrors.effectiveFrom ?? undefined) : errs.effectiveFrom}>
            <DateInput value={from} onChange={setFrom} referenceDate={date} />
          </Field>
          <Field label="Rate (CGST + SGST together)" required hint="e.g. 1 for 0.5% CGST + 0.5% SGST" error={pct !== null ? (errs.rate ?? save.fieldErrors.rate) : undefined}>
            <PercentInput value={pct} onChange={setPct} />
          </Field>
          <Field label="Charged on">
            <Select
              value={basis}
              options={[
                { value: 'turnover', label: 'Turnover in the State (incl. exempt supplies)' },
                { value: 'taxable_turnover', label: 'Turnover of taxable supplies only' },
              ]}
              onChange={(v) => setBasis(v as 'turnover' | 'taxable_turnover')}
            />
          </Field>
          <Field label="Note" optional hint="Notification reference">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}

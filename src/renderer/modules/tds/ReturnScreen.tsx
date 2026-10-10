/**
 * 'tds.return' { form?, fyStart?, quarter? } — quarterly statement data: Form 26Q (TDS, residents),
 * 27Q (TDS, non-residents) or 27EQ (TCS). Deductee / collectee rows linked to the challans that paid
 * them, and the challan rows, with warnings (undeposited tax, missing PAN, no TAN).
 * Ctrl+1 deductees, Ctrl+2 challans, Alt+S save the two CSV files for the return preparation utility
 * (needs "File TDS/TCS statements"), Alt+R record the filing (date + token; the s.234E fee stops),
 * Alt+E / Alt+P export / print the table on screen. Enter on a row opens its voucher.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { FORM_LABEL, type Quarter, type TdsForm } from '../../../shared/tds/rules.ts';
import type { TdsReturnChallanRow, TdsReturnDeducteeRow } from '../../../shared/types/tds.ts';
import { api } from '../../app/api.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReportScreen } from '../../app/Screen.tsx';
import { useCan, useFeatures } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import { Badge, Banner, Button, DataTable, DateInput, EmptyState, Field, Hotkeys, Inline, Modal, SegmentedControl, Select, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { saveCsvFile, TdsOff } from './components.tsx';
import { earliestFilingDate, enabledKinds, formsFor, fyLabel, QUARTER_LABEL, quarterChoices, returnChallansExport, returnDeducteesExport, statementStatusText } from './lib/model.ts';

export interface ReturnParams {
  form?: TdsForm;
  fyStart?: number;
  quarter?: Quarter;
}

type View = 'deductees' | 'challans';

export function ReturnScreen({ params }: ScreenProps<ReturnParams>) {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canFile = useCan('tds.file');
  const { date: workingDate } = useWorkingDate();
  const kinds = enabledKinds(features);
  const forms = kinds.flatMap((k) => formsFor(k));
  const choice = quarterChoices(workingDate);
  const p = params ?? {};
  const [form, setForm] = useState<TdsForm | null>(p.form && forms.includes(p.form) ? p.form : (forms[0] ?? null));
  const [fyStart, setFyStart] = useState<number>(p.fyStart ?? (choice.quarter === 1 ? choice.fyStart - 1 : choice.fyStart));
  const [quarter, setQuarter] = useState<Quarter>(p.quarter ?? (choice.quarter === 1 ? 4 : ((choice.quarter - 1) as Quarter)));
  const [view, setView] = useState<View>('deductees');
  const [filing, setFiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const f = form && forms.includes(form) ? form : (forms[0] ?? null);
  const q = useApiQuery('tds.return.data', { form: f ?? '26Q', fyStart, quarter }, { enabled: f !== null, keepPrevious: true });
  const d = q.data && q.data.form === f && q.data.fyStart === fyStart && q.data.quarter === quarter ? q.data : undefined;
  const isTcs = f === '27EQ';
  const years = [...new Set([...choice.years, fyStart])].sort((a, b) => b - a);

  const deducteeCols = useMemo<Column<TdsReturnDeducteeRow & { key: string }>[]>(
    () => [
      { key: 'challanSr', header: 'Challan', width: 72, kind: 'number', value: (r) => r.challanSr ?? '', render: (r) => (r.challanSr === null ? <Badge size="sm" tone="danger">Unpaid</Badge> : String(r.challanSr)) },
      { key: 'section', header: 'Section', width: 80 },
      { key: 'deducteeCode', header: 'Code', width: 56, title: () => '01 company, 02 other than company' },
      { key: 'pan', header: 'PAN', width: 120, render: (r) => (r.pan === 'PANNOTAVBL' ? <Badge size="sm" tone="warning">PANNOTAVBL</Badge> : <span className="bx-num">{r.pan}</span>) },
      { key: 'name', header: isTcs ? 'Collectee' : 'Deductee', minWidth: 180 },
      { key: 'paymentDate', header: isTcs ? 'Received / debited' : 'Paid / credited', kind: 'date', width: 110 },
      { key: 'amountPaid', header: 'Amount', kind: 'amount', width: 130, total: true },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 110, total: true },
      { key: 'deposited', header: 'Deposited', kind: 'amount', width: 110, total: true, blankZero: true },
      { key: 'rate', header: 'Rate', width: 70, align: 'right', value: (r) => `${r.rate}%` },
      { key: 'reasonCode', header: 'Reason', width: 70, title: () => 'A = lower / nil certificate (s.197), C = higher rate, no PAN' },
      { key: 'certificateNo', header: 'Certificate', width: 120, value: (r) => r.certificateNo ?? '' },
    ],
    [isTcs],
  );
  const challanCols = useMemo<Column<TdsReturnChallanRow>[]>(
    () => [
      { key: 'sr', header: 'Sr.', kind: 'number', width: 56 },
      { key: 'section', header: 'Section', width: 80 },
      { key: 'period', header: 'Month', width: 90 },
      { key: 'bsrCode', header: 'BSR code', width: 90 },
      { key: 'depositDate', header: 'Deposited', kind: 'date', width: 100 },
      { key: 'challanNo', header: 'Challan no.', width: 90 },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 110, total: true, value: (r) => r.tax + r.surcharge + r.cess },
      { key: 'interest', header: 'Interest', kind: 'amount', width: 100, total: true, blankZero: true },
      { key: 'fee', header: 'Fee', kind: 'amount', width: 90, total: true, blankZero: true },
      { key: 'others', header: 'Others', kind: 'amount', width: 90, total: true, blankZero: true },
      { key: 'total', header: 'Total', kind: 'amount', width: 120, total: true },
      { key: 'allocated', header: 'Allocated', kind: 'amount', width: 120, total: true },
    ],
    [],
  );
  const deductees = useMemo(() => (d?.deductees ?? []).map((r, i) => ({ ...r, key: String(i) })), [d]);

  const saveFiles = async (): Promise<void> => {
    if (!f || !canFile || saving) return;
    setSaving(true);
    try {
      const saved: string[] = [];
      for (const part of ['deductees', 'challans'] as const) {
        const out = await api('tds.return.export', { form: f, fyStart, quarter, part });
        const path = await saveCsvFile(out.fileName, out.content, part === 'deductees' ? `Save the ${isTcs ? 'collectee' : 'deductee'} rows (${f})` : `Save the challan rows (${f})`);
        if (!path) break;
        saved.push(path.split(/[\\/]/).pop() ?? path);
      }
      if (saved.length > 0) toast.success(`Saved ${saved.join(' and ')}`, { message: 'Copy the rows into the return preparation utility, or give the files to your tax practitioner.' });
    } catch (err) {
      toast.error('Could not save the statement files', { message: userMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  if (f === null) return <TdsOff title="TDS / TCS Quarterly Return" />;
  return (
    <ReportScreen
      title={`Form ${f} — ${QUARTER_LABEL[quarter]} ${fyLabel(fyStart)}`}
      subtitle={d ? statementStatusText(d) : FORM_LABEL[f]}
      periodMode="none"
      loading={q.loading && !d}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={
        <Inline gap={2}>
          <Select<TdsForm> aria-label="Form" size="sm" value={f} options={forms.map((x) => ({ value: x, label: FORM_LABEL[x] }))} onChange={setForm} />
          <Select aria-label="Financial year" size="sm" value={String(fyStart)} options={years.map((y) => ({ value: String(y), label: `FY ${fyLabel(y)}` }))} onChange={(v) => setFyStart(Number(v))} />
          <Select aria-label="Quarter" size="sm" value={String(quarter)} options={([1, 2, 3, 4] as const).map((x) => ({ value: String(x), label: QUARTER_LABEL[x] }))} onChange={(v) => setQuarter(Number(v) as Quarter)} />
          <SegmentedControl<View>
            aria-label="Rows"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'deductees', label: isTcs ? 'Collectees' : 'Deductees' },
              { value: 'challans', label: 'Challans' },
            ]}
          />
        </Inline>
      }
      exportDef={() => (d ? (view === 'deductees' ? returnDeducteesExport(d) : returnChallansExport(d)) : { columns: [], rows: [] })}
      actions={[
        { key: 'Ctrl+1', label: isTcs ? 'Collectees' : 'Deductees', group: 'view', disabled: view === 'deductees', onClick: () => setView('deductees') },
        { key: 'Ctrl+2', label: 'Challans', group: 'view', disabled: view === 'challans', onClick: () => setView('challans') },
        { key: 'Alt+S', label: 'Save CSV files', icon: 'download', primary: true, disabled: !canFile || !d || saving, hint: canFile ? undefined : 'Needs the "File TDS/TCS statements" permission', onClick: () => void saveFiles() },
        { key: 'Alt+R', label: 'Record filing', icon: 'check', disabled: !canFile || !d, onClick: () => setFiling(true) },
      ]}
      hint="Ctrl+1 Deductees · Ctrl+2 Challans · Alt+S Save CSV files · Alt+R Record filing · Enter Open voucher · Esc Back"
    >
      <Stack gap={3}>
        {d && d.warnings.length > 0 ? (
          <Banner tone="warning" title={`${d.warnings.length} thing(s) to check before filing`}>
            <ul>
              {d.warnings.slice(0, 12).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {d.warnings.length > 12 ? <li>… and {d.warnings.length - 12} more</li> : null}
            </ul>
          </Banner>
        ) : null}
        {view === 'deductees' ? (
          <DataTable
            aria-label={isTcs ? 'Collectee rows' : 'Deductee rows'}
            autoFocus
            columns={deducteeCols}
            rows={deductees}
            getRowKey={(r) => r.key}
            onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
            empty={<EmptyState title="No rows for this quarter" body="No tax was deducted or collected in it." />}
          />
        ) : (
          <DataTable<TdsReturnChallanRow>
            aria-label="Challan rows"
            autoFocus
            columns={challanCols}
            rows={d?.challans ?? []}
            getRowKey={(r) => String(r.sr)}
            onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
            empty={<EmptyState title="No challans for this quarter" body="Record the challans you paid (TDS/TCS › Challan)." />}
          />
        )}
        <span className="bx-muted">
          The CSV files carry every field the deductee and challan sheets of the return preparation utility ask for, under plain headings. They are not the
          NSDL / Protean FVU text file: validate the statement with the current FVU before filing.
        </span>
      </Stack>
      {filing && d ? (
        <FilingDialog
          form={f}
          fyStart={fyStart}
          quarter={quarter}
          filedOn={d.filedOn}
          tokenNo={d.tokenNo}
          referenceDate={workingDate}
          minDate={earliestFilingDate(d.to)}
          onClose={() => setFiling(false)}
        />
      ) : null}
    </ReportScreen>
  );
}

function FilingDialog(props: { form: TdsForm; fyStart: number; quarter: Quarter; filedOn: string | null; tokenNo: string | null; referenceDate: string; minDate: string; onClose: () => void }) {
  const toast = useToast();
  const [filedOn, setFiledOn] = useState<string | null>(props.filedOn ?? props.referenceDate);
  const [token, setToken] = useState(props.tokenNo ?? '');
  const save = useApiMutation('tds.statement.save', { invalidates: ['tds'] });
  const accept = async (clear = false): Promise<void> => {
    if (save.pending) return;
    try {
      await save.mutate({ form: props.form, fyStart: props.fyStart, quarter: props.quarter, filedOn: clear ? null : filedOn, ...(token.trim() && !clear ? { tokenNo: token.trim() } : {}) });
      toast.success(clear ? 'Filing record removed' : `Form ${props.form} marked filed on ${formatDate(filedOn ?? '')}`);
      props.onClose();
    } catch {
      /* fieldErrors shown */
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void accept() });
  return (
    <Modal
      open
      onClose={props.onClose}
      size="sm"
      title={`Record filing of Form ${props.form}`}
      description={`${QUARTER_LABEL[props.quarter]} ${fyLabel(props.fyStart)} — the late fee u/s 234E stops on the filing date.`}
      footer={
        <>
          {props.filedOn ? (
            <Button variant="ghost" onClick={() => void accept(true)}>
              Not filed
            </Button>
          ) : null}
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} disabled={!filedOn} onClick={() => void accept()}>
            Save
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void accept() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="Filed on" required error={save.fieldErrors.filedOn}>
            <DateInput data-autofocus value={filedOn} onChange={setFiledOn} referenceDate={props.referenceDate} minDate={props.minDate} />
          </Field>
          <Field label="Token / receipt no." optional hint="15-digit provisional receipt number of the statement.">
            <TextInput value={token} onValueChange={(v) => setToken(v.slice(0, 40))} mono />
          </Field>
          {save.error && Object.keys(save.fieldErrors).length === 0 ? <Banner tone="danger" inline>{userMessage(save.error)}</Banner> : null}
        </Stack>
      </div>
    </Modal>
  );
}

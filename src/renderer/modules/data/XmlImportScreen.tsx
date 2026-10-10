/**
 * 'data.xmlImport' — XML data import wizard: 1 how to export from the previous program + choose the XML → 2 what is in
 * the file, issues and options (nothing saved yet) → 3 importing (progress) → 4 result with
 * "Check books". Vouchers are imported exactly as recorded in the file.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { XmlImportResult, XmlImportIssue, XmlPreviewResult, XmlImportProgress } from '../../../shared/types/data.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { formatBytes, formatDate, formatMoney } from '../../app/display.ts';
import { userMessage, isBusyConflict, retryWhileBusy } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { invalidate } from '../../app/queryClient.ts';
import { Screen } from '../../app/Screen.tsx';
import { useCompany } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import { Badge, Banner, Button, Checkbox, DataTable, DateInput, Field, FieldGroup, Grid, Icon, Inline, KeyValueList, Panel, ProgressBar, RadioGroup, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { chooseFile, Steps, type ChosenFile } from './components.tsx';
import { issueCounts, issueTone, progressPercent, XML_FILTERS, xmlCountRows, xmlFileProblem, xmlOptionsProblem, xmlResultSummary, type XmlImportCountRow } from './lib/importView.ts';

type Step = 'file' | 'preview' | 'import' | 'done';

const STEPS = [
  { id: 'file', label: 'Export your data' },
  { id: 'preview', label: 'Check the file' },
  { id: 'import', label: 'Import' },
  { id: 'done', label: 'Done' },
] as const;

export function XmlImportScreen() {
  const nav = useNav();
  const company = useCompany();
  const confirm = useConfirm();
  const { date: workingDate } = useWorkingDate();
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [preview, setPreview] = useState<XmlPreviewResult | null>(null);
  const [masters, setMasters] = useState(true);
  const [vouchers, setVouchers] = useState(true);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'update'>('skip');
  const [busy, setBusy] = useState<null | 'file' | 'import'>(null);
  const [progress, setProgress] = useState<XmlImportProgress | null>(null);
  const [result, setResult] = useState<XmlImportResult | null>(null);
  // `retry`: refused only because another task holds the company (an Excel import job, …): "Wait and retry".
  const [error, setError] = useState<{ title: string; message: string; retry?: () => void } | null>(null);
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  const step: Step = result ? 'done' : busy === 'import' ? 'import' : preview ? 'preview' : 'file';
  const options = { masters, vouchers, from: vouchers ? from ?? undefined : undefined, to: vouchers ? to ?? undefined : undefined, onDuplicate };
  const optionsProblem = preview ? xmlOptionsProblem(preview, options) : null;

  const pick = async () => {
    if (busy) return;
    setBusy('file');
    setError(null);
    try {
      const f = await chooseFile('Choose the XML export file', XML_FILTERS);
      if (!f) return;
      const problem = xmlFileProblem(f.name);
      if (problem) {
        setError({ title: `“${f.name}” cannot be used`, message: problem });
        return;
      }
      const p = await api('data.xmlImport.preview', { fileName: f.name, bytes: f.bytes });
      setFile(f);
      setPreview(p);
      setResult(null);
      setMasters(Object.entries(p.counts).some(([k, n]) => k !== 'VOUCHER' && n > 0));
      setVouchers(p.counts.VOUCHER > 0);
      setFrom(p.dateRange?.from ?? null);
      setTo(p.dateRange?.to ?? null);
    } catch (err) {
      setError({ title: 'The file could not be read', message: userMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  // Poll progress while the import runs.
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (busy !== 'import') return;
    polling.current = setInterval(() => {
      void api('data.xmlImport.progress')
        .then((p) => setProgress(p))
        .catch(() => undefined);
    }, 500);
    return () => {
      if (polling.current) clearInterval(polling.current);
      polling.current = null;
    };
  }, [busy]);

  const runImport = async () => {
    if (!file || !preview || busy || optionsProblem) return;
    const errs = issueCounts(preview.issues).error;
    const ok = await confirm({
      title: `Import this XML data${company ? ` into ${company.name}` : ''}?`,
      message: `${masters ? 'Masters' : ''}${masters && vouchers ? ' and ' : ''}${vouchers ? `vouchers${from && to ? ` from ${formatDate(from)} to ${formatDate(to)}` : ''}` : ''} will be added.${onDuplicate === 'update' ? ' Masters that already exist here are changed to match the file.' : ''} ${errs ? `${errs} record${errs === 1 ? '' : 's'} with errors will be left out. ` : ''}Take a backup first if this company already has data.`,
      tone: onDuplicate === 'update' ? 'danger' : undefined,
      confirmLabel: 'Start import',
    });
    if (!ok) return;
    await startImport(false);
  };

  /** The import itself (after the confirmation); `wait`: the user chose "Wait and retry". */
  const startImport = async (wait: boolean) => {
    if (!file) return;
    setBusy('import');
    setProgress({ running: true, phase: 'parse', done: 0, total: 0, message: wait ? 'Waiting for the other task to finish…' : 'Reading the file…' });
    setError(null);
    const input = { fileName: file.name, bytes: file.bytes, options };
    try {
      const call = () => api('data.xmlImport.commit', input);
      const r = wait ? await retryWhileBusy(call, { cancelled: () => closed.current }) : await call();
      invalidate();
      setResult(r);
    } catch (err) {
      if (isBusyConflict(err)) {
        setError({
          title: 'Another task is running in this company',
          message: `${userMessage(err)} Choose Wait and retry: Pevqori tries again every few seconds until it can start.`,
          retry: () => void startImport(true),
        });
      } else {
        setError({ title: 'The import did not finish', message: userMessage(err) });
        invalidate();
      }
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const restart = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
  };

  const primary =
    step === 'file'
      ? { label: 'Choose XML file…', icon: 'upload' as const, run: () => void pick(), disabled: busy !== null }
      : step === 'preview'
        ? { label: 'Start import', icon: 'check' as const, run: () => void runImport(), disabled: !!optionsProblem }
        : step === 'done'
          ? { label: 'Check books', icon: 'shield' as const, run: () => nav.push('data.verify'), disabled: false }
          : { label: 'Importing…', icon: 'sync' as const, run: () => undefined, disabled: true };

  return (
    <Screen
      title="XML Data Import"
      subtitle="Import from another accounting program (XML): bring your masters and vouchers over from its XML export."
      icon="sync"
      width="form"
      dirty={step === 'preview' || step === 'import'}
      hint={step === 'preview' ? 'Ctrl+A Start import · Alt+O Another file · Esc Back' : step === 'done' ? 'Ctrl+A Check books · Alt+T Trial Balance · Esc Close' : 'Ctrl+A Choose file · Esc Back'}
      actions={[
        { key: 'Ctrl+A', label: primary.label, icon: primary.icon, primary: true, onClick: primary.run, disabled: primary.disabled },
        { key: 'Alt+O', label: 'Choose another file', icon: 'folder', onClick: () => void pick(), hidden: step !== 'preview' },
        { key: 'Alt+T', label: 'Trial Balance', icon: 'scale', onClick: () => nav.push('reports.trialBalance'), hidden: step !== 'done' },
        { key: 'Alt+N', label: 'Import another file', icon: 'refresh', onClick: restart, hidden: step !== 'done' },
        { key: 'Alt+B', label: 'Back up first', icon: 'database', onClick: () => nav.push('data.backup'), hidden: step === 'done' || step === 'import', group: 'more' },
      ]}
    >
      <Stack gap={4}>
        <Steps steps={STEPS} current={step} label="XML data import steps" />
        {error ? (
          <Banner
            tone={error.retry ? 'warning' : 'danger'}
            title={error.title}
            onDismiss={() => setError(null)}
            action={
              error.retry ? (
                <Button size="sm" icon="refresh" onClick={error.retry} disabled={busy !== null}>
                  Wait and retry
                </Button>
              ) : undefined
            }
          >
            {error.message}
          </Banner>
        ) : null}
        {step === 'file' ? <HowTo busy={busy === 'file'} onChoose={() => void pick()} /> : null}
        {step === 'preview' && preview && file ? (
          <>
            <PreviewPanel preview={preview} file={file} />
            <Panel title="What to import">
              <Stack gap={3}>
                <FieldGroup columns={2}>
                  <Checkbox label="Masters" description="Groups, ledgers with opening balances and bills, units, godowns, items with opening stock" checked={masters} onChange={setMasters} />
                  <Checkbox label="Vouchers" description="Exactly as recorded in your previous program — amounts and GST are not recalculated" checked={vouchers} onChange={setVouchers} disabled={preview.counts.VOUCHER === 0} />
                </FieldGroup>
                {vouchers && preview.dateRange ? (
                  <FieldGroup legend="Vouchers dated" columns={2}>
                    <Field label="From">
                      <DateInput value={from} onChange={setFrom} referenceDate={workingDate} />
                    </Field>
                    <Field label="To">
                      <DateInput value={to} onChange={setTo} referenceDate={workingDate} />
                    </Field>
                  </FieldGroup>
                ) : null}
                <RadioGroup<'skip' | 'update'>
                  label="Records that already exist here"
                  value={onDuplicate}
                  onChange={setOnDuplicate}
                  orientation="horizontal"
                  options={[
                    { value: 'skip', label: 'Keep mine (skip)', description: 'Safe to import the same file twice' },
                    { value: 'update', label: 'Update from the file', description: 'Masters change to match the file; vouchers brought in by an earlier XML import are refreshed. Vouchers entered here are never overwritten.' },
                  ]}
                />
                {optionsProblem ? <p className="bx-muted" role="status">{optionsProblem}</p> : null}
                <div>
                  <Button variant="primary" icon="check" disabled={!!optionsProblem} shortcut="Ctrl+A" onClick={() => void runImport()}>
                    Start import
                  </Button>
                </div>
              </Stack>
            </Panel>
          </>
        ) : null}
        {step === 'import' ? <ImportProgress progress={progress} /> : null}
        {step === 'done' && result ? <ResultPanel result={result} onVerify={() => nav.push('data.verify')} onTb={() => nav.push('reports.trialBalance')} /> : null}
      </Stack>
    </Screen>
  );
}

function HowTo({ busy, onChoose }: { busy: boolean; onChoose: () => void }) {
  return (
    <Stack gap={4}>
      <Panel title="1. Export your data from your previous accounting program" description="Do this on the computer that has that program. Exporting does not change anything there.">
        <ol className="bx-data-howto">
          <li>
            Open the company in that program and choose its <strong>Export</strong> option (it may be called <strong>Data Interchange</strong>).
          </li>
          <li>
            Choose <strong>Masters</strong> (All Masters) and set <strong>Format = XML (Data Interchange)</strong>, then export.
          </li>
          <li>
            For vouchers, choose <strong>Transactions</strong> (Day Book) with the same XML format and the period you need — usually the whole financial year.
          </li>
          <li>Copy the .xml files to this computer (a USB drive is fine). If you cannot find them, check the export folder the program shows when exporting.</li>
        </ol>
      </Panel>
      <Panel title="2. Choose the exported file" description="Import masters first, then transactions. You will see what is in the file before anything is saved.">
        <Button variant="primary" icon="upload" loading={busy} onClick={onChoose} shortcut="Ctrl+A" data-autofocus>
          {busy ? 'Reading the file…' : 'Choose XML file…'}
        </Button>
      </Panel>
    </Stack>
  );
}

function PreviewPanel({ preview, file }: { preview: XmlPreviewResult; file: ChosenFile }) {
  const rows = useMemo(() => xmlCountRows(preview), [preview]);
  const counts = issueCounts(preview.issues);
  const countCols = useMemo<Column<XmlImportCountRow>[]>(
    () => [
      { key: 'label', header: 'In the file' },
      { key: 'count', header: 'Count', kind: 'number', width: 100 },
      { key: 'existing', header: 'Already here', kind: 'number', width: 120, value: (r) => r.existing ?? 0, render: (r) => (r.existing === null ? <span className="bx-muted">—</span> : <span className="bx-num">{r.existing}</span>) },
    ],
    [],
  );
  const typeCols = useMemo<Column<XmlPreviewResult['vouchersByType'][number]>[]>(
    () => [
      { key: 'voucherType', header: 'Voucher type in the file' },
      { key: 'baseType', header: 'Imported as', width: 160, value: (r) => r.baseType ?? '', render: (r) => (r.baseType ? r.baseType.replace(/_/g, ' ') : <Badge size="sm" tone="danger">Not supported</Badge>) },
      { key: 'count', header: 'Vouchers', kind: 'number', width: 100 },
    ],
    [],
  );
  const issueCols = useMemo<Column<XmlImportIssue & { i: number }>[]>(
    () => [
      { key: 'severity', header: 'Type', width: 110, render: (r) => <Badge size="sm" tone={issueTone(r.severity)}>{r.severity === 'error' ? 'Left out' : r.severity === 'warning' ? 'Warning' : 'Note'}</Badge> },
      { key: 'object', header: 'Record', width: 260, value: (r) => r.object ?? '' },
      { key: 'message', header: 'What happens' },
    ],
    [],
  );
  const issues = useMemo(() => preview.issues.map((x, i) => ({ ...x, i })), [preview.issues]);
  return (
    <Stack gap={4}>
      <Panel
        title={
          <span className="bx-data-file">
            <Icon name="file" size="sm" />
            <span className="bx-data-file__name">{file.name}</span>
            <span>{formatBytes(file.size)}</span>
          </span>
        }
      >
        <KeyValueList
          columns={2}
          items={[
            { key: 'company', label: 'Company in the file', value: preview.companyName ?? '—', strong: true },
            { key: 'dates', label: 'Vouchers dated', value: preview.dateRange ? `${formatDate(preview.dateRange.from)} to ${formatDate(preview.dateRange.to)}` : 'No vouchers' },
            { key: 'issues', label: 'Issues', value: `${counts.error} left out · ${counts.warning} warnings · ${counts.info} notes` },
            { key: 'encoding', label: 'File encoding', value: preview.encoding.toUpperCase() },
          ]}
        />
      </Panel>
      <Grid columns={2} gap={4}>
        <Panel title="Masters and vouchers">
          <DataTable aria-label="Objects in the file" columns={countCols} rows={rows} getRowKey={(r) => r.key} virtualize={false} />
        </Panel>
        {preview.vouchersByType.length ? (
          <Panel title="Voucher types">
            <DataTable aria-label="Vouchers by type" columns={typeCols} rows={preview.vouchersByType} getRowKey={(r) => r.voucherType} virtualize={false} />
          </Panel>
        ) : null}
      </Grid>
      {preview.samples.ledgers.length ? (
        <Panel title="A few ledgers from the file" collapsible defaultCollapsed>
          <ul className="bx-data-details">
            {preview.samples.ledgers.map((l) => (
              <li key={l.name}>
                <strong>{l.name}</strong> — under {l.parent ?? 'Primary'}
                {l.openingBalance ? ` · opening ₹ ${formatMoney(Math.abs(l.openingBalance))} ${l.openingBalance > 0 ? 'Dr' : 'Cr'}` : ''}
                {l.gstin ? ` · GSTIN ${l.gstin}` : ''}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Panel title={preview.issues.length ? `Issues (${preview.issues.length})` : 'Issues'}>
        {preview.issues.length ? (
          <DataTable aria-label="Issues found in the file" columns={issueCols} rows={issues} getRowKey={(r) => String(r.i)} height="min(40vh, 360px)" />
        ) : (
          <p className="bx-muted">No problems found — everything in the file can be imported.</p>
        )}
      </Panel>
    </Stack>
  );
}

function ImportProgress({ progress }: { progress: XmlImportProgress | null }) {
  const pct = progressPercent(progress);
  return (
    <Panel title="Importing your data" description="Keep Pevqori open. Large files take a few minutes; each batch is saved as it completes.">
      <Stack gap={2}>
        <ProgressBar value={pct ?? undefined} indeterminate={pct === null} label={progress?.message || 'Working…'} showValue={pct !== null} aria-label="Import progress" />
        {progress && progress.total > 0 ? (
          <p className="bx-muted" role="status">
            {progress.phase === 'masters' ? 'Masters' : progress.phase === 'vouchers' ? 'Vouchers' : 'Records'}: {progress.done} of {progress.total}
          </p>
        ) : null}
      </Stack>
    </Panel>
  );
}

function ResultPanel({ result, onVerify, onTb }: { result: XmlImportResult; onVerify: () => void; onTb: () => void }) {
  const s = xmlResultSummary(result);
  const issues = useMemo(() => result.issues.map((x, i) => ({ ...x, i })), [result.issues]);
  const cols = useMemo<Column<XmlImportIssue & { i: number }>[]>(
    () => [
      { key: 'severity', header: 'Type', width: 110, render: (r) => <Badge size="sm" tone={issueTone(r.severity)}>{r.severity === 'error' ? 'Left out' : r.severity === 'warning' ? 'Warning' : 'Note'}</Badge> },
      { key: 'object', header: 'Record', width: 260, value: (r) => r.object ?? '' },
      { key: 'message', header: 'Reason' },
    ],
    [],
  );
  return (
    <Stack gap={4}>
      <Banner tone={s.tone} title={s.title}>
        {s.lines.map((l, i) => (
          <span key={l}>
            {i > 0 ? <br /> : null}
            {l}
          </span>
        ))}
      </Banner>
      <Panel title="Next: check that the books agree with your previous program" description="Compare the Trial Balance with the one in your previous program for the same date, then run Check books to confirm every voucher balances.">
        <Inline gap={2}>
          <Button variant="primary" icon="shield" onClick={onVerify} shortcut="Ctrl+A">
            Check books
          </Button>
          <Button icon="scale" onClick={onTb} shortcut="Alt+T">
            Trial Balance
          </Button>
        </Inline>
      </Panel>
      {issues.length ? (
        <Panel title={`Issues (${issues.length})`}>
          <DataTable aria-label="Import issues" columns={cols} rows={issues} getRowKey={(r) => String(r.i)} height="min(40vh, 360px)" />
        </Panel>
      ) : null}
    </Stack>
  );
}

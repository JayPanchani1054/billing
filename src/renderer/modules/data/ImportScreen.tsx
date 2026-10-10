/**
 * 'data.import' — Excel/CSV import wizard: 1 choose what to import → 2 template & file → 3 check every
 * row (nothing is saved yet) and choose options → 4 result. Params: { kind?: ImportKind }.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { IMPORT_KINDS, type ImportCommitResult, type ImportKind, type ImportKindInfo, type ImportPreviewResult, type ImportRowResult } from '../../../shared/types/data.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { formatBytes } from '../../app/display.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage, errorDetailsText, isBusyConflict, retryWhileBusy } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { invalidate } from '../../app/queryClient.ts';
import type { ScreenProps } from '../../app/registry.ts';
import { Screen } from '../../app/Screen.tsx';
import { useCompany } from '../../app/state.tsx';
import { Badge, Banner, Button, Checkbox, DataTable, EmptyState, FieldGroup, Icon, Inline, Panel, SegmentedControl, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { chooseFile, Steps, useSaveFile, type ChosenFile } from './components.tsx';
import {
  actionText,
  commitBlockReason,
  commitResultText,
  filterRows,
  invalidatesFor,
  isVoucherKind,
  previewSummaryText,
  SPREADSHEET_FILTERS,
  spreadsheetFileProblem,
  statusBadge,
  type RowFilter,
} from './lib/importView.ts';

type Step = 'kind' | 'file' | 'preview' | 'result';

const STEPS = [
  { id: 'kind', label: 'What to import' },
  { id: 'file', label: 'Choose file' },
  { id: 'preview', label: 'Check rows' },
  { id: 'result', label: 'Done' },
] as const;

const FILTERS: Array<{ value: RowFilter; label: string }> = [
  { value: 'all', label: 'All rows' },
  { value: 'problems', label: 'Needs attention' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
];

const isKind = (k: unknown): k is ImportKind => typeof k === 'string' && (IMPORT_KINDS as readonly string[]).includes(k);

export function ImportScreen({ params }: ScreenProps<{ kind?: ImportKind }>) {
  const nav = useNav();
  const company = useCompany();
  const confirm = useConfirm();
  const save = useSaveFile();
  const kindsQ = useApiQuery('data.import.kinds', {}, { staleTime: 5 * 60_000 });
  const [kind, setKind] = useState<ImportKind | null>(isKind(params.kind) ? params.kind : null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [busy, setBusy] = useState<null | 'template' | 'file' | 'preview' | 'commit'>(null);
  /**
   * `retry`: the request was refused only because another task holds the company (the automatic backup
   * right after login, an export, a Tally import) — the banner offers "Wait and retry", which repeats
   * it until that task finishes (apiErrors.ts retryWhileBusy).
   */
  const [error, setError] = useState<{ title: string; message: string; details?: string; retry?: () => void } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  const busyText = (err: unknown) => `${userMessage(err)} Choose Wait and retry: Pevqori tries again every few seconds until it can start.`;
  /** Run `fn`, waiting while another task holds the company (only when the user chose "Wait and retry"). */
  const attempt = async <T,>(fn: () => Promise<T>, wait: boolean): Promise<T> => {
    if (!wait) return fn();
    setWaiting(true);
    try {
      return await retryWhileBusy(fn, { cancelled: () => closed.current });
    } finally {
      setWaiting(false);
    }
  };

  const info: ImportKindInfo | null = kindsQ.data?.find((k) => k.kind === kind) ?? null;
  const kindCursor: ImportKind | null = isKind(cursor) ? cursor : (kindsQ.data?.[0]?.kind ?? null);
  const step: Step = result ? 'result' : preview ? 'preview' : kind ? 'file' : 'kind';
  const opts = { skipInvalid, updateExisting, acknowledgeWarnings };
  const blocked = preview ? commitBlockReason(preview, opts) : null;

  const runPreview = async (f: ChosenFile, k: ImportKind, update: boolean, wait = false) => {
    setBusy('preview');
    setError(null);
    try {
      const p = await attempt(() => api('data.import.preview', { kind: k, fileName: f.name, bytes: f.bytes, options: { updateExisting: update } }), wait);
      setPreview(p);
      setFilter(p.summary.error + p.summary.warning > 0 ? 'problems' : 'all');
    } catch (err) {
      setPreview(null);
      if (isBusyConflict(err)) setError({ title: 'Another task is running in this company', message: busyText(err), retry: () => void runPreview(f, k, update, true) });
      else setError({ title: 'The file could not be read', message: userMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const pickFile = async () => {
    if (!kind || busy) return;
    setBusy('file');
    setError(null);
    try {
      const f = await chooseFile(`Choose the ${info?.label.toLowerCase() ?? 'data'} file`, SPREADSHEET_FILTERS);
      if (!f) return;
      const problem = spreadsheetFileProblem(f.name);
      if (problem) {
        setError({ title: `“${f.name}” cannot be imported`, message: problem });
        return;
      }
      setFile(f);
      setResult(null);
      await runPreview(f, kind, updateExisting);
    } catch (err) {
      setError({ title: 'The file could not be opened', message: userMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const downloadTemplate = async () => {
    if (!kind || busy) return;
    setBusy('template');
    try {
      const out = await api('data.import.template', { kind });
      await save(out.bytes, out.fileName, 'Save the import template');
    } catch (err) {
      setError({ title: 'The template could not be made', message: userMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const changeUpdateExisting = (on: boolean) => {
    setUpdateExisting(on);
    if (file && kind && step === 'preview') void runPreview(file, kind, on);
  };

  const commit = async () => {
    if (!preview || !file || !kind || busy || blocked) return;
    const n = preview.summary.willCreate + preview.summary.willUpdate;
    const ok = await confirm({
      title: `Import ${n} record${n === 1 ? '' : 's'}${company ? ` into ${company.name}` : ''}?`,
      message: `${previewSummaryText(preview)}.${skipInvalid && preview.summary.error ? ' Rows with errors are left out.' : ''} Each saved record appears in the edit log.`,
      confirmLabel: 'Import',
    });
    if (!ok) return;
    await runCommit(false);
  };

  /** The import itself (after the confirmation); `wait`: the user chose "Wait and retry". */
  const runCommit = async (wait: boolean) => {
    if (!preview || !file || !kind) return;
    setBusy('commit');
    setError(null);
    const input = { kind, fileName: file.name, bytes: file.bytes, options: { skipInvalid, updateExisting, acknowledgeWarnings } };
    try {
      const r = await attempt(() => api('data.import.commit', input), wait);
      for (const prefix of invalidatesFor(input.kind)) invalidate(prefix);
      setResult(r);
    } catch (err) {
      if (isBusyConflict(err)) setError({ title: 'Nothing was imported yet', message: busyText(err), retry: () => void runCommit(true) });
      else setError({ title: 'Nothing was imported', message: userMessage(err), details: errorDetailsText(err) || undefined });
    } finally {
      setBusy(null);
    }
  };

  const restart = (keepKind: boolean) => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    setAcknowledgeWarnings(false);
    if (!keepKind) setKind(null);
  };

  const back = () => {
    if (step === 'preview') restart(true);
    else if (step === 'file') restart(false);
    else void nav.back();
  };

  const primary =
    step === 'kind'
      ? { label: 'Continue', icon: 'arrow-right' as const, run: () => kindCursor && setKind(kindCursor), disabled: !kindCursor }
      : step === 'file'
        ? { label: 'Choose file…', icon: 'upload' as const, run: () => void pickFile(), disabled: busy !== null }
        : step === 'preview'
          ? { label: 'Import', icon: 'check' as const, run: () => void commit(), disabled: busy !== null || !!blocked }
          : { label: 'Import another file', icon: 'refresh' as const, run: () => restart(true), disabled: false };

  return (
    <Screen
      title="Import from Excel"
      subtitle={info ? info.label : 'Bring masters, opening balances and invoices in from Excel or CSV.'}
      icon="upload"
      width="full"
      dirty={step === 'preview' && busy !== 'commit'}
      hint={
        step === 'kind'
          ? '↑/↓ Choose · Enter Continue · Esc Back'
          : step === 'file'
            ? 'Alt+T Template · Ctrl+A Choose file · Alt+B Back'
            : step === 'preview'
              ? 'Ctrl+A Import · Alt+O Another file · Alt+B Back'
              : 'Ctrl+A Import another · Esc Close'
      }
      actions={[
        { key: 'Ctrl+A', label: primary.label, icon: primary.icon, primary: true, onClick: primary.run, disabled: primary.disabled },
        { key: 'Alt+T', label: 'Download template', icon: 'download', onClick: () => void downloadTemplate(), hidden: !kind || step === 'result', disabled: busy !== null },
        { key: 'Alt+O', label: 'Choose another file', icon: 'folder', onClick: () => void pickFile(), hidden: step !== 'preview', disabled: busy !== null },
        { key: 'Alt+B', label: 'Previous step', icon: 'arrow-left', onClick: back, hidden: step === 'kind' || step === 'result' },
        { key: 'Alt+X', label: 'XML data import', icon: 'sync', onClick: () => nav.push('data.xmlImport'), group: 'more' },
      ]}
      loading={kindsQ.loading}
      error={kindsQ.error}
      onRetry={() => void kindsQ.refetch()}
    >
      <Stack gap={4}>
        <Steps steps={STEPS} current={step} label="Import steps" />
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
            {error.details ? <pre className="bx-data-messages">{error.details}</pre> : null}
          </Banner>
        ) : null}
        {waiting ? (
          <Banner tone="info" title="Waiting for the other task to finish…">
            The import starts by itself as soon as the company is free (Pevqori checks every 2 seconds, for up to 2 minutes).
          </Banner>
        ) : null}

        {step === 'kind' ? <KindStep kinds={kindsQ.data ?? []} cursor={cursor} setCursor={setCursor} onChoose={(k) => setKind(k)} /> : null}
        {step === 'file' && info ? <FileStep info={info} busy={busy} onTemplate={() => void downloadTemplate()} onChoose={() => void pickFile()} /> : null}
        {step === 'preview' && preview && file && kind ? (
          <PreviewStep
            preview={preview}
            file={file}
            kind={kind}
            filter={filter}
            setFilter={setFilter}
            skipInvalid={skipInvalid}
            setSkipInvalid={setSkipInvalid}
            updateExisting={updateExisting}
            setUpdateExisting={changeUpdateExisting}
            acknowledgeWarnings={acknowledgeWarnings}
            setAcknowledgeWarnings={setAcknowledgeWarnings}
            blocked={blocked}
            busy={busy}
            onCommit={() => void commit()}
          />
        ) : null}
        {step === 'result' && result ? <ResultStep result={result} onAgain={() => restart(true)} onOther={() => restart(false)} /> : null}
      </Stack>
    </Screen>
  );
}

// ───────────────────────────── Steps ─────────────────────────────

function KindStep({ kinds, cursor, setCursor, onChoose }: { kinds: readonly ImportKindInfo[]; cursor: string | null; setCursor: (k: string | null) => void; onChoose: (k: ImportKind) => void }) {
  const columns = useMemo<Column<ImportKindInfo>[]>(
    () => [
      { key: 'label', header: 'Import', width: 260, render: (k) => <strong>{k.label}</strong> },
      { key: 'description', header: 'What it brings in' },
      { key: 'group', header: 'Kind', width: 120, value: (k) => (isVoucherKind(k.kind) ? 'Transactions' : 'Masters'), render: (k) => <Badge size="sm" tone={isVoucherKind(k.kind) ? 'info' : 'neutral'}>{isVoucherKind(k.kind) ? 'Transactions' : 'Masters'}</Badge> },
    ],
    [],
  );
  return (
    <Panel title="What would you like to import?" description="Import masters first (groups → ledgers → units → items), then opening balances, then invoices.">
      <DataTable<ImportKindInfo>
        aria-label="Kinds of import"
        autoFocus
        columns={columns}
        rows={kinds}
        getRowKey={(k) => k.kind}
        selectedKey={cursor ?? kinds[0]?.kind ?? null}
        onSelect={(k) => setCursor(k)}
        onRowActivate={(k) => onChoose(k.kind)}
        virtualize={false}
      />
    </Panel>
  );
}

function FileStep({ info, busy, onTemplate, onChoose }: { info: ImportKindInfo; busy: string | null; onTemplate: () => void; onChoose: () => void }) {
  const columns = useMemo<Column<ImportKindInfo['columns'][number]>[]>(
    () => [
      { key: 'header', header: 'Column', width: 200, render: (c) => <strong>{c.header}</strong> },
      { key: 'required', header: 'Needed', width: 100, render: (c) => (c.required ? <Badge size="sm" tone="warning">Required</Badge> : <span className="bx-muted">Optional</span>) },
      { key: 'help', header: 'What to enter', render: (c) => (c.choices?.length ? `${c.help} (${c.choices.join(', ')})` : c.help) },
    ],
    [],
  );
  return (
    <Stack gap={4}>
      <Panel title={`1. Get the ${info.label.toLowerCase()} template`} description="An Excel file with the right headings, two example rows and an Instructions sheet. Delete the examples and type or paste your data.">
        <Inline gap={2}>
          <Button icon="download" loading={busy === 'template'} onClick={onTemplate} shortcut="Alt+T">
            Download template
          </Button>
          <span className="bx-muted">Your own sheet works too, as long as the first row has these headings.</span>
        </Inline>
      </Panel>
      <Panel title="2. Choose your filled-in file" description="Excel (.xlsx) or CSV. Nothing is saved until you have checked every row on the next step.">
        <Button variant="primary" icon="upload" loading={busy === 'file' || busy === 'preview'} onClick={onChoose} shortcut="Ctrl+A" data-autofocus>
          {busy === 'preview' ? 'Checking rows…' : 'Choose file…'}
        </Button>
      </Panel>
      <Panel title="Columns" description={info.groupByHeader ? `Rows with the same “${info.groupByHeader}” form one record.` : undefined} collapsible defaultCollapsed={false}>
        <DataTable aria-label={`${info.label} columns`} columns={columns} rows={info.columns} getRowKey={(c) => c.key} virtualize={false} />
      </Panel>
    </Stack>
  );
}

function PreviewStep(p: {
  preview: ImportPreviewResult;
  file: ChosenFile;
  kind: ImportKind;
  filter: RowFilter;
  setFilter: (f: RowFilter) => void;
  skipInvalid: boolean;
  setSkipInvalid: (v: boolean) => void;
  updateExisting: boolean;
  setUpdateExisting: (v: boolean) => void;
  acknowledgeWarnings: boolean;
  setAcknowledgeWarnings: (v: boolean) => void;
  blocked: string | null;
  busy: string | null;
  onCommit: () => void;
}) {
  const { preview } = p;
  const s = preview.summary;
  const rows = useMemo(() => filterRows(preview.rows, p.filter), [preview.rows, p.filter]);
  const columns = useMemo<Column<ImportRowResult>[]>(
    () => [
      { key: 'rowNumber', header: 'Row', width: 80, kind: 'number', value: (r) => r.rowNumber, render: (r) => <span className="bx-num">{r.rowNumbers.length > 1 ? `${r.rowNumbers[0]}–${r.rowNumbers[r.rowNumbers.length - 1]}` : r.rowNumber}</span> },
      { key: 'key', header: 'Record', width: 240 },
      {
        key: 'status',
        header: 'Status',
        width: 110,
        render: (r) => {
          const b = statusBadge(r.status);
          return (
            <Badge size="sm" tone={b.tone}>
              {b.label}
            </Badge>
          );
        },
      },
      { key: 'action', header: 'Will be', width: 170, value: (r) => actionText(r) },
      { key: 'messages', header: 'Messages', value: (r) => r.messages.join(' · '), render: (r) => (r.messages.length ? r.messages.join(' · ') : <span className="bx-muted">—</span>) },
    ],
    [],
  );
  const voucher = isVoucherKind(p.kind);
  return (
    <Stack gap={4}>
      <Panel
        title={
          <span className="bx-data-file">
            <Icon name="file" size="sm" />
            <span className="bx-data-file__name">{p.file.name}</span>
            <span>
              {formatBytes(p.file.size)}
              {preview.sheet ? ` · sheet “${preview.sheet}”` : ''} · headings on row {preview.headerRow}
            </span>
          </span>
        }
      >
        <Stack gap={3}>
          <Banner tone={s.error ? 'danger' : s.warning ? 'warning' : 'success'} title={previewSummaryText(preview)}>
            {s.error
              ? 'Rows with errors cannot be imported. Correct them in the file and choose it again (Alt+O), or skip them.'
              : s.warning
                ? 'Read the warnings below before importing.'
                : 'Every row can be imported.'}
          </Banner>
          {preview.unmappedHeaders.length ? (
            <Banner tone="info" title="Some columns were not recognised and will be ignored">
              {preview.unmappedHeaders.join(', ')}
            </Banner>
          ) : null}
        </Stack>
      </Panel>
      <Inline gap={3} align="center">
        <SegmentedControl aria-label="Show rows" options={FILTERS} value={p.filter} onChange={p.setFilter} size="sm" />
        <span className="bx-muted">
          Showing {rows.length} of {preview.rows.length}
        </span>
      </Inline>
      <DataTable<ImportRowResult>
        aria-label="Rows of the file"
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.rowNumber)}
        height="min(50vh, 480px)"
        empty={<EmptyState size="sm" icon="check-circle" title="No rows to show" body="Choose “All rows” to see everything." />}
      />
      <FieldGroup legend="Options" columns={voucher ? 3 : 2}>
        <Checkbox label="Skip rows with errors" description="Import the good rows now and fix the rest later." checked={p.skipInvalid} onChange={p.setSkipInvalid} />
        {!voucher ? (
          <Checkbox label="Update existing records" description="Masters that already exist are changed to match the file (otherwise they are left alone)." checked={p.updateExisting} onChange={p.setUpdateExisting} disabled={p.busy === 'preview'} />
        ) : null}
        {voucher ? (
          <Checkbox label="Save vouchers with warnings" description="I have read the warnings (e.g. a number that cannot be kept)." checked={p.acknowledgeWarnings} onChange={p.setAcknowledgeWarnings} />
        ) : null}
      </FieldGroup>
      {p.blocked ? <p className="bx-muted" role="status">{p.blocked}</p> : null}
      <div>
        <Button variant="primary" icon="check" loading={p.busy === 'commit'} disabled={!!p.blocked || p.busy !== null} shortcut="Ctrl+A" onClick={p.onCommit}>
          Import {s.willCreate + s.willUpdate} record{s.willCreate + s.willUpdate === 1 ? '' : 's'}
        </Button>
      </div>
    </Stack>
  );
}

function ResultStep({ result, onAgain, onOther }: { result: ImportCommitResult; onAgain: () => void; onOther: () => void }) {
  const r = commitResultText(result);
  const columns = useMemo<Column<ImportRowResult>[]>(
    () => [
      { key: 'rowNumber', header: 'Row', width: 80, kind: 'number' },
      { key: 'key', header: 'Record', width: 240 },
      { key: 'status', header: 'Result', width: 140, value: (x) => (x.status === 'error' ? 'Not imported' : 'Already existed') },
      { key: 'messages', header: 'Reason', value: (x) => x.messages.join(' · ') },
    ],
    [],
  );
  return (
    <Stack gap={4}>
      <Banner tone={r.tone} title={r.title}>
        {r.message}
      </Banner>
      {result.rows.length ? (
        <Panel title="Rows not imported">
          <DataTable<ImportRowResult> aria-label="Rows not imported" columns={columns} rows={result.rows} getRowKey={(x) => String(x.rowNumber)} height="min(40vh, 360px)" />
        </Panel>
      ) : null}
      <Inline gap={2}>
        <Button variant="primary" icon="refresh" onClick={onAgain} shortcut="Ctrl+A">
          Import another file
        </Button>
        <Button onClick={onOther}>Import something else</Button>
      </Inline>
    </Stack>
  );
}

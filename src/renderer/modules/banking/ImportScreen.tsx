/**
 * 'banking.import' — Bank statement import wizard. Params: { ledgerId? }.
 *
 *   1. Bank account + file (Alt+O): CSV / Excel .xlsx downloaded from net banking.
 *   2. Check: detected bank layout, column roles (editable — the preview re-reads the file live), heading row,
 *      date order, parsed transactions with "already imported" marks, skipped rows with reasons, balance check.
 *   3. Import (Ctrl+A) → summary, then Auto-match (Alt+M) or open the BRS (Alt+B).
 * Nothing is written before Ctrl+A; the mapping is remembered for the bank so next month needs no changes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { StatementColumnRole, StatementImportResult, StatementPreview, ParsedStatementLine } from '../../../shared/types/banking.ts';
import { STATEMENT_COLUMN_ROLES } from '../../../shared/types/banking.ts';
import { formatDate, todayLocal } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { api } from '../../app/api.ts';
import { native } from '../../app/bridge.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { Screen } from '../../app/Screen.tsx';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Grid,
  Inline,
  KeyValueList,
  NumberInput,
  Panel,
  Select,
  Spinner,
  Stack,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { BankSelect, NoBanks, useBanks, useDefaultBank } from './components.tsx';
import {
  AMOUNT_SIGN_OPTIONS,
  DATE_ORDER_OPTIONS,
  ROLE_LABEL,
  assignRole,
  blankDraft,
  columnCaptions,
  draftFromMapping,
  draftProblems,
  groupIssues,
  importResultText,
  previewSummaryText,
  previewWarnings,
  roleOfColumn,
  toMapping,
  type MappingDraft,
} from './lib/importMapping.ts';

/** A statement balance as the bank prints it: funds are "Cr" in the bank's books, an overdraft is "Dr". */
function statementBalanceText(p: number): string {
  return p === 0 ? '0.00' : `${formatMoney(Math.abs(p))} ${p > 0 ? 'Cr' : 'Dr'}`;
}

interface LoadedFile {
  name: string;
  size: number;
  bytes: Uint8Array;
}

type Step = 'choose' | 'review' | 'done';

const ROLE_OPTIONS = [{ value: '', label: '— not used —' }, ...STATEMENT_COLUMN_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))];

export function ImportScreen({ params }: ScreenProps<{ ledgerId?: number }>) {
  const nav = useNav();
  const toast = useToast();
  const { banks, loading: banksLoading, error: banksError, refetch } = useBanks(todayLocal());
  const presets = useApiQuery('banking.statement.presets', {}, { staleTime: 10 * 60_000 });
  const [ledgerId, setLedgerIdRaw] = useState<number | null>(params.ledgerId ?? null);
  useDefaultBank(banks, ledgerId, setLedgerIdRaw);
  const [step, setStep] = useState<Step>('choose');
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [edited, setEdited] = useState(0);
  /** The `edited` version the shown preview was read with: Import waits until the preview matches the mapping. */
  const [previewVersion, setPreviewVersion] = useState(-1);
  const [result, setResult] = useState<StatementImportResult | null>(null);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const seq = useRef(0);
  const doImport = useApiMutation('banking.statement.import', { invalidates: ['dashboard'] });

  /** Read the file: with the draft's mapping, or auto-detected (optionally within one worksheet) when d is null. */
  const runPreview = async (f: LoadedFile, bankId: number, d: MappingDraft | null, version: number, sheet?: string): Promise<void> => {
    const mapping = d ? toMapping(d) : null;
    const my = ++seq.current;
    setPreviewing(true);
    try {
      const p = await api('banking.statement.preview', {
        ledgerId: bankId,
        fileName: f.name,
        bytes: f.bytes,
        ...(mapping ? { mapping } : sheet ? { sheet } : {}),
      });
      if (my !== seq.current) return;
      setPreview(p);
      setPreviewError(null);
      setPreviewVersion(version);
      if (!d) setDraft(p.mapping ? draftFromMapping(p.mapping) : blankDraft(0, p.sheet));
    } catch (err) {
      if (my !== seq.current) return;
      setPreviewError(userMessage(err));
      if (!d) setPreview(null);
    } finally {
      if (my === seq.current) setPreviewing(false);
    }
  };

  // Re-read the file shortly after the mapping is edited (only when it is complete).
  useEffect(() => {
    if (edited === 0 || !file || ledgerId === null || !draft) return;
    const cols = preview ? columnCaptions(preview.rawPreview, draft.headerRow).length : 0;
    if (draftProblems(draft, Math.max(cols, 1)).length > 0) return;
    const t = setTimeout(() => void runPreview(file, ledgerId, draft, edited), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runPreview is recreated each render; edits drive this effect
  }, [edited]);

  const chooseFile = async (): Promise<void> => {
    if (ledgerId === null) {
      toast.warning('Choose the bank account first.');
      return;
    }
    let picked: Awaited<ReturnType<typeof native<'dialog.openFile'>>>;
    try {
      picked = await native('dialog.openFile', {
        title: 'Choose the bank statement (CSV or Excel)',
        filters: [
          { name: 'Bank statements', extensions: ['csv', 'xlsx', 'xls', 'txt', 'tsv'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
    } catch (err) {
      toast.error('The file could not be opened', { message: userMessage(err) });
      return;
    }
    if (!picked) return;
    const f = { name: picked.name, size: picked.size, bytes: picked.bytes };
    setFile(f);
    setPreview(null);
    setDraft(null);
    setResult(null);
    setShowAllIssues(false);
    setStep('review');
    await runPreview(f, ledgerId, null, edited);
  };

  /** Another worksheet of an Excel file: detect its heading and columns afresh. */
  const chooseSheet = (sheet: string): void => {
    if (!file || ledgerId === null || sheet === preview?.sheet) return;
    setDraft(null);
    void runPreview(file, ledgerId, null, edited, sheet);
  };

  const changeLedger = (id: number | null): void => {
    if (id === null || id === ledgerId) return;
    setLedgerIdRaw(id);
    if (file && step === 'review') {
      // Duplicates and the saved mapping are per bank: read the file again for the new bank.
      setDraft(null);
      void runPreview(file, id, null, edited, preview?.sheet ?? undefined);
    }
  };

  const edit = (next: MappingDraft): void => {
    setDraft(next);
    setEdited((n) => n + 1);
  };

  const reset = (): void => {
    seq.current++;
    setStep('choose');
    setFile(null);
    setPreview(null);
    setPreviewError(null);
    setDraft(null);
    setResult(null);
  };

  const captions = useMemo(() => (preview && draft ? columnCaptions(preview.rawPreview, draft.headerRow) : []), [preview, draft]);
  const problems = draft ? draftProblems(draft, Math.max(captions.length, 1)) : [];
  // What is imported is exactly what the preview shows: no import while a re-read for an edit is pending.
  const previewCurrent = previewVersion === edited;
  const canImport =
    step === 'review' && !!file && !!preview && !!draft && problems.length === 0 && preview.lines.length > 0 && !previewing && !previewError && previewCurrent;

  const submit = async (): Promise<void> => {
    if (!canImport || !file || !draft || ledgerId === null) return;
    const mapping = toMapping(draft);
    if (!mapping) return;
    try {
      const res = await doImport.mutate({ ledgerId, fileName: file.name, bytes: file.bytes, mapping });
      setResult(res);
      setStep('done');
      toast.success(importResultText(res));
    } catch (err) {
      toast.error('The statement was not imported', { message: userMessage(err) });
    }
  };

  const batchId = result?.batchId ?? undefined;
  const bank = banks.find((b) => b.id === ledgerId);
  const presetInfo = presets.data?.find((p) => p.id === (draft?.preset ?? preview?.preset.id));

  if (!banksLoading && !banksError && banks.length === 0) {
    return (
      <Screen title="Import Bank Statement" icon="upload">
        <NoBanks />
      </Screen>
    );
  }

  return (
    <Screen
      title="Import Bank Statement"
      subtitle={bank ? `Into ${bank.name}` : 'CSV or Excel statement from net banking'}
      icon="upload"
      dirty={step === 'review' && !!file}
      loading={banksLoading}
      error={banksError}
      onRetry={() => void refetch()}
      hint={step === 'review' ? 'Change a column role to re-read the file · Ctrl+A Import · Alt+O another file · Esc back' : 'Alt+O Choose the statement file'}
      actions={[
        { key: 'Alt+O', label: file ? 'Choose another file' : 'Choose file', icon: 'folder', primary: step === 'choose', onClick: () => void chooseFile(), hidden: step === 'done' },
        { key: 'Ctrl+A', label: 'Import', icon: 'save', primary: true, onClick: () => void submit(), disabled: !canImport || doImport.pending, hidden: step !== 'review' },
        { key: 'Alt+M', label: 'Auto-match now', icon: 'link', primary: true, hidden: step !== 'done', onClick: () => nav.replace('banking.match', { ledgerId: ledgerId ?? undefined, batchId, autorun: true }) },
        { key: 'Alt+B', label: 'Open reconciliation', icon: 'bank', hidden: step !== 'done', onClick: () => nav.replace('banking.brs', { ledgerId: ledgerId ?? undefined }) },
        { key: 'Alt+N', label: 'Import another file', icon: 'plus', hidden: step !== 'done', onClick: reset },
      ]}
    >
      <Stack gap={3}>
        <ol className="bx-bk-steps" aria-label="Import steps">
          <li aria-current={step === 'choose' ? 'step' : undefined}>1. Bank and file</li>
          <li aria-hidden="true">›</li>
          <li aria-current={step === 'review' ? 'step' : undefined}>2. Check columns and transactions</li>
          <li aria-hidden="true">›</li>
          <li aria-current={step === 'done' ? 'step' : undefined}>3. Imported</li>
        </ol>

        <Card padding="sm">
          <Inline gap={3} align="end" wrap>
            <Field label="Bank account" required>
              <BankSelect banks={banks} value={ledgerId} onChange={changeLedger} autoFocus={step === 'choose'} />
            </Field>
            <Field label="Statement file">
              <Inline gap={2} align="center" wrap={false}>
                <Button icon="folder" shortcut="Alt+O" onClick={() => void chooseFile()} disabled={step === 'done'}>
                  {file ? 'Choose another file' : 'Choose file…'}
                </Button>
                {file ? (
                  <span className="bx-truncate" title={file.name}>
                    {file.name} · {(file.size / 1024).toLocaleString('en-IN', { maximumFractionDigits: 0 })} KB
                  </span>
                ) : null}
              </Inline>
            </Field>
          </Inline>
        </Card>

        {step === 'choose' ? (
          <EmptyState
            icon="upload"
            title="Import your bank statement"
            body="Download the statement from net banking as Excel (.xlsx) or CSV — SBI, HDFC, ICICI, Axis, Kotak, Yes Bank, PNB, Bank of Baroda, Canara and most other banks are read automatically. Press Alt+O to choose the file."
          />
        ) : null}

        {step === 'review' ? (
          <ReviewStep
            preview={preview}
            previewError={previewError}
            previewing={previewing}
            draft={draft}
            captions={captions}
            problems={problems}
            presets={presets.data ?? []}
            presetNote={presetInfo?.note ?? null}
            showAllIssues={showAllIssues}
            onShowAllIssues={setShowAllIssues}
            onEdit={edit}
            onSheet={chooseSheet}
            stale={!previewCurrent}
            onImport={() => void submit()}
            canImport={canImport}
            importing={doImport.pending}
          />
        ) : null}

        {step === 'done' && result ? (
          <Card title="Statement imported" padding="md">
            <Stack gap={3}>
              <Banner tone={result.imported > 0 ? 'success' : 'info'}>{importResultText(result)}</Banner>
              <KeyValueList
                layout="inline"
                columns={2}
                items={[
                  { label: 'Bank account', value: bank?.name ?? '' },
                  { label: 'Period', value: result.from ? `${formatDate(result.from)} to ${formatDate(result.to)}` : '–' },
                  { label: 'Deposits imported', value: result.totalDeposits, kind: 'amount' },
                  { label: 'Withdrawals imported', value: result.totalWithdrawals, kind: 'amount' },
                  { label: 'Closing balance (statement)', value: result.closingBalance === null ? '–' : statementBalanceText(result.closingBalance) },
                  { label: 'Duplicates skipped', value: String(result.duplicates) },
                ]}
              />
              <Inline gap={2}>
                <Button
                  variant="primary"
                  icon="link"
                  shortcut="Alt+M"
                  data-autofocus
                  onClick={() => nav.replace('banking.match', { ledgerId: ledgerId ?? undefined, batchId, autorun: true })}
                >
                  Auto-match with vouchers
                </Button>
                <Button icon="bank" shortcut="Alt+B" onClick={() => nav.replace('banking.brs', { ledgerId: ledgerId ?? undefined })}>
                  Open reconciliation
                </Button>
                <Button icon="plus" shortcut="Alt+N" onClick={reset}>
                  Import another file
                </Button>
              </Inline>
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Screen>
  );
}

interface ReviewProps {
  preview: StatementPreview | null;
  previewError: string | null;
  previewing: boolean;
  draft: MappingDraft | null;
  captions: string[];
  problems: string[];
  presets: ReadonlyArray<{ id: string; name: string }>;
  presetNote: string | null;
  showAllIssues: boolean;
  onShowAllIssues: (v: boolean) => void;
  onEdit: (d: MappingDraft) => void;
  /** XLSX with several worksheets: read another one. */
  onSheet: (sheet: string) => void;
  /** The mapping was edited and the preview is being read again. */
  stale: boolean;
  onImport: () => void;
  canImport: boolean;
  importing: boolean;
}

function ReviewStep({
  preview,
  previewError,
  previewing,
  draft,
  captions,
  problems,
  presets,
  presetNote,
  showAllIssues,
  onShowAllIssues,
  onEdit,
  onSheet,
  stale,
  onImport,
  canImport,
  importing,
}: ReviewProps) {
  const lineColumns = useMemo<Column<ParsedStatementLine>[]>(
    () => [
      { key: 'txnDate', header: 'Date', kind: 'date', width: 110 },
      { key: 'description', header: 'Narration', minWidth: 240, title: (r) => r.description },
      { key: 'reference', header: 'Ref. no.', width: 150 },
      { key: 'withdrawal', header: 'Withdrawal', kind: 'amount', width: 130, value: (r) => (r.amount < 0 ? -r.amount : 0), blankZero: true, total: true },
      { key: 'deposit', header: 'Deposit', kind: 'amount', width: 130, value: (r) => (r.amount > 0 ? r.amount : 0), blankZero: true, total: true },
      {
        key: 'balance',
        header: 'Balance',
        width: 150,
        align: 'right',
        render: (r) => (r.balance === null ? '' : statementBalanceText(r.balance)),
        title: () => 'Balance as the bank shows it: Cr = money in the account, Dr = overdrawn',
      },
      {
        key: 'duplicate',
        header: 'Status',
        width: 140,
        render: (r) =>
          r.duplicate ? (
            <Badge size="sm" tone="neutral">
              Already imported
            </Badge>
          ) : (
            <Badge size="sm" tone="success">
              New
            </Badge>
          ),
      },
    ],
    [],
  );
  const issueColumns = useMemo<Column<StatementPreview['issues'][number]>[]>(
    () => [
      { key: 'row', header: 'Row', kind: 'number', width: 70 },
      { key: 'level', header: '', width: 90, render: (r) => <Badge size="sm" tone={r.level === 'warning' ? 'warning' : 'neutral'}>{r.level === 'warning' ? 'Check' : 'Skipped'}</Badge> },
      { key: 'reason', header: 'Reason', minWidth: 220 },
      { key: 'text', header: 'Row contents', minWidth: 260, title: (r) => r.text },
    ],
    [],
  );

  if (previewError && !preview) {
    return (
      <Banner tone="danger" title="This file cannot be read">
        {previewError}
      </Banner>
    );
  }
  if (!preview || !draft) {
    return (
      <Inline gap={2} align="center">
        <Spinner size="sm" /> Reading the statement…
      </Inline>
    );
  }

  const warnings = previewWarnings(preview);
  const groups = groupIssues(preview.issues);
  const samples = (col: number): string =>
    preview.rawPreview
      .slice(draft.headerRow + 1)
      .map((r) => (r[col] ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' · ');
  const single = draft.columns.amount !== undefined && draft.columns.drCr === undefined;
  const s = preview.summary;

  return (
    <Stack gap={3}>
      {previewError ? (
        <Banner tone="danger" title="This mapping cannot be used">
          {previewError}
        </Banner>
      ) : null}
      {preview.mapping === null && preview.detectedBy !== 'given' ? (
        <Banner tone="warning" title="Column headings not recognised">
          Look at the file below, set the heading row and choose at least the Date column and the Withdrawal/Deposit (or Amount) columns. The preview updates as you choose.
        </Banner>
      ) : null}

      <Grid columns="minmax(0, 3fr) minmax(280px, 2fr)" gap={3}>
        <Panel
          title="Columns"
          description={
            preview.detectedBy === 'saved'
              ? 'Read with the columns you used last time for this bank.'
              : preview.detectedBy === 'preset'
                ? `Recognised as a ${preview.preset.name} statement.`
                : preview.detectedBy === 'given'
                  ? 'Using the columns you chose.'
                  : 'Columns recognised by their headings — check them.'
          }
          actions={previewing || stale ? <Spinner size="xs" label="Updating preview" /> : null}
        >
          <Stack gap={2}>
            <Inline gap={3} wrap>
              {preview.sheets.length > 1 ? (
                <Field label="Worksheet" hint={`${preview.sheets.length} sheets in this file`}>
                  <Select size="sm" value={preview.sheet ?? preview.sheets[0]} options={preview.sheets.map((n) => ({ value: n, label: n }))} onChange={(v) => onSheet(v)} />
                </Field>
              ) : null}
              <Field label="Bank layout" hint="Saved with the mapping for next time">
                <Select
                  size="sm"
                  value={draft.preset}
                  options={presets.map((p) => ({ value: p.id, label: p.name }))}
                  onChange={(v) => onEdit({ ...draft, preset: v as MappingDraft['preset'] })}
                />
              </Field>
              <Field label="Heading row" hint="Row number in the file">
                <NumberInput
                  size="sm"
                  value={draft.headerRow + 1}
                  min={1}
                  max={Math.max(1, preview.rawPreview.length)}
                  step={1}
                  onChange={(v) => {
                    if (v !== null && v >= 1) onEdit({ ...draft, headerRow: Math.floor(v) - 1 });
                  }}
                />
              </Field>
              <Field label="Dates are written as">
                <Select size="sm" value={draft.dateOrder} options={DATE_ORDER_OPTIONS} onChange={(v) => onEdit({ ...draft, dateOrder: v })} />
              </Field>
              {single ? (
                <Field label="Amount sign">
                  <Select size="sm" value={draft.amountSign} options={AMOUNT_SIGN_OPTIONS} onChange={(v) => onEdit({ ...draft, amountSign: v })} />
                </Field>
              ) : null}
            </Inline>
            <table className="bx-bk-mapping" aria-label="Column roles">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Heading in the file</th>
                  <th scope="col">Sample values</th>
                  <th scope="col">Use as</th>
                </tr>
              </thead>
              <tbody>
                {captions.map((caption, col) => (
                  <tr key={col}>
                    <td className="bx-num">{col + 1}</td>
                    <td>{caption}</td>
                    <td className="bx-bk-sample bx-truncate" title={samples(col)}>
                      {samples(col)}
                    </td>
                    <td>
                      <Select
                        size="sm"
                        aria-label={`Use column ${col + 1} (${caption}) as`}
                        value={roleOfColumn(draft, col) ?? ''}
                        options={ROLE_OPTIONS}
                        onChange={(v) => onEdit(assignRole(draft, col, v === '' ? null : (v as StatementColumnRole)))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {problems.length > 0 ? (
              <Banner tone="warning" inline>
                {problems.join(' ')}
              </Banner>
            ) : null}
          </Stack>
        </Panel>

        <Stack gap={2}>
          <Card title="Summary" padding="sm">
            <Stack gap={2}>
              <span>{previewSummaryText(preview, (d) => formatDate(d))}</span>
              <KeyValueList
                layout="inline"
                alignValues="right"
                items={[
                  { label: `Deposits (${s.depositCount})`, value: s.totalDeposits, kind: 'amount' },
                  { label: `Withdrawals (${s.withdrawalCount})`, value: s.totalWithdrawals, kind: 'amount' },
                  { label: 'Opening balance', value: s.openingBalance === null ? '–' : statementBalanceText(s.openingBalance) },
                  { label: 'Closing balance', value: s.closingBalance === null ? '–' : statementBalanceText(s.closingBalance), strong: true },
                  {
                    label: 'Running balance check',
                    value: s.balanceCheck.checked === 0 ? 'Not available' : s.balanceCheck.mismatches === 0 ? `Agrees on ${s.balanceCheck.checked} rows` : `${s.balanceCheck.mismatches} rows differ`,
                  },
                ]}
              />
              <Button variant="primary" icon="save" shortcut="Ctrl+A" onClick={onImport} disabled={!canImport} loading={importing}>
                Import {s.lineCount - s.duplicates > 0 ? `${(s.lineCount - s.duplicates).toLocaleString('en-IN')} new transactions` : ''}
              </Button>
            </Stack>
          </Card>
          {warnings.map((w) => (
            <Banner key={w} tone="warning" inline>
              {w}
            </Banner>
          ))}
          {presetNote ? (
            <Banner tone="info" inline title="Downloading this statement">
              {presetNote}
            </Banner>
          ) : null}
        </Stack>
      </Grid>

      <Panel title={`Transactions (${s.lineCount.toLocaleString('en-IN')})`} description={preview.truncated ? 'Only the first 5,000 are shown; all of them will be imported.' : undefined}>
        <div className="bx-bk-table">
          <DataTable
            aria-label="Transactions read from the statement"
            columns={lineColumns}
            rows={preview.lines}
            getRowKey={(r) => `${r.row}-${r.seq}`}
            density="compact"
            empty={<EmptyState size="sm" title="No transactions read" body="Check the heading row and the Date / Withdrawal / Deposit columns above." />}
          />
        </div>
      </Panel>

      {groups.length > 0 ? (
        <Panel
          title={`Rows not imported (${s.skippedRows})`}
          description="Headings, separators, opening/closing balance lines and anything that is not a transaction."
          collapsible
          defaultCollapsed={!groups.some((g) => g.level === 'warning')}
          actions={
            <Button size="sm" variant="ghost" onClick={() => onShowAllIssues(!showAllIssues)}>
              {showAllIssues ? 'Show summary' : 'Show every row'}
            </Button>
          }
        >
          {showAllIssues ? (
            <div className="bx-bk-table">
              <DataTable aria-label="Rows not imported" columns={issueColumns} rows={preview.issues} getRowKey={(r, i) => `${r.row}-${i}`} density="compact" />
            </div>
          ) : (
            <ul>
              {groups.map((g) => (
                <li key={`${g.level}-${g.reason}`}>
                  <Badge size="sm" tone={g.level === 'warning' ? 'warning' : 'neutral'}>
                    {g.count}
                  </Badge>{' '}
                  {g.reason}
                  {g.rows.length > 0 ? <span className="bx-muted"> — row{g.rows.length === 1 ? '' : 's'} {g.rows.join(', ')}{g.count > g.rows.length ? ' …' : ''}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      <Panel title="File as read" description="The first rows of the file; the heading row is highlighted." collapsible defaultCollapsed={preview.mapping !== null}>
        <div className="bx-bk-raw" tabIndex={0} aria-label="First rows of the file">
          <table>
            <tbody>
              {preview.rawPreview.map((r, i) => (
                <tr key={i} className={i === draft.headerRow ? 'is-header' : undefined}>
                  <td className="bx-bk-rowno">{i + 1}</td>
                  {r.map((c, j) => (
                    <td key={j} title={c}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </Stack>
  );
}

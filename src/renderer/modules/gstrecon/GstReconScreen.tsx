/**
 * 'gstrecon.home' {period?: MMYYYY (or 'YYYY-YY-Qn' with the GSTR-1 tab, quarterly filers), source?: 'gstr2b' | 'gstr2a' | 'gstr1',
 * tab?: 'purchases' | 'suppliers' | 'gstr1' | 'imports'} — GST reconciliation.
 *
 * Tabs: Purchases (GSTR-2B / GSTR-2A vs purchase books) · Supplier-wise · GSTR-1 vs sales · Imported files.
 * Keys: Alt+F2 return period · Alt+S GSTR-2B/2A · Alt+O import the portal file · Alt+R reconcile ·
 * Alt+T matching rules · Enter on a row → compare drawer (Ctrl+A accept, Alt+I ignore, Alt+U undo/unlink) ·
 * Alt+M supplier follow-up e-mail · Alt+E export (Excel workbook) · Alt+P print the rows shown · Esc back.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ImportBatchView,
  ReconImportConflict,
  ReconImportResult,
  ReconRow,
  ReconSource,
  ReconStatus,
  ReconStatusFilter,
  ReconSummary,
  ReconTolerance,
  SupplierReconRow,
} from '../../../shared/types/gstrecon.ts';
import { DEFAULT_RECON_TOLERANCE, RECON_SOURCE_LABELS } from '../../../shared/types/gstrecon.ts';
import {
  api,
  formatDateTime,
  formatMoney,
  isApiError,
  native,
  printReport,
  Screen,
  showInFolder,
  useApiMutation,
  useApiQuery,
  useBooks,
  useCan,
  useCompany,
  useConfirm,
  userMessage,
  useWorkingDate,
} from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  EmptyState,
  Icon,
  Inline,
  KpiCard,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  TextInput,
  useDebouncedValue,
  useHotkeys,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { CompareDrawer } from './CompareDrawer.tsx';
import { FollowUpDialog, ToleranceDialog } from './dialogs.tsx';
import { defaultPeriod, isQuarterKey, periodLabel, periodOptionGroups, storageMonth } from './lib/periods.ts';
import {
  conflictMessage,
  headLines,
  importResultText,
  itcTiles,
  partyWord,
  resultsExport,
  rowDocDate,
  rowDocNo,
  signedMoney,
  statusAdvice,
  statusFilterOptions,
  statusLabel,
  STATUS_TONES,
  TILE_STATUSES,
  toleranceText,
} from './lib/recon.ts';
import type { HeadLine } from './lib/recon.ts';

export type GstReconTab = 'purchases' | 'suppliers' | 'gstr1' | 'imports';

export interface GstReconParams {
  period?: string;
  source?: ReconSource;
  tab?: GstReconTab;
}

const PAGE_SIZE = 200;
const TABS: readonly GstReconTab[] = ['purchases', 'suppliers', 'gstr1', 'imports'];

function isConflictDetails(x: unknown): x is ReconImportConflict {
  return typeof x === 'object' && x !== null && typeof (x as ReconImportConflict).existingDocCount === 'number' && typeof (x as ReconImportConflict).newDocCount === 'number';
}

export function GstReconScreen({ params }: ScreenProps<GstReconParams>) {
  const toast = useToast();
  const confirm = useConfirm();
  const company = useCompany();
  const canFile = useCan('gst.file');
  const canExport = useCan('data.export');
  const { date: today } = useWorkingDate();
  const { booksFrom } = useBooks();

  const [period, setPeriod] = useState<string>(() => defaultPeriod(today, booksFrom, params?.period, params?.source === 'gstr1' || params?.tab === 'gstr1'));
  const [purchaseSource, setPurchaseSource] = useState<'gstr2b' | 'gstr2a'>(params?.source === 'gstr2a' ? 'gstr2a' : 'gstr2b');
  const [tab, setTab] = useState<GstReconTab>(() => (params?.tab && TABS.includes(params.tab) ? params.tab : params?.source === 'gstr1' ? 'gstr1' : 'purchases'));
  const source: ReconSource = tab === 'gstr1' ? 'gstr1' : purchaseSource;
  // Quarters (QRMP GSTR-1) exist only on the GSTR-1 tab; elsewhere fall back to the quarter's last month.
  useEffect(() => {
    if (tab !== 'gstr1' && isQuarterKey(period)) setPeriod(storageMonth(period));
  }, [tab, period]);
  const label = RECON_SOURCE_LABELS[source];
  const party = partyWord(source);

  // Results filters (reset when the period or source changes).
  const [status, setStatus] = useState<ReconStatusFilter>('open');
  const [supplier, setSupplier] = useState<string>('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [page, setPage] = useState(1);
  useEffect(() => {
    setStatus('open');
    setSupplier('');
    setSearch('');
    setPage(1);
  }, [period, source]);
  useEffect(() => setPage(1), [status, supplier, debouncedSearch]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<ReconRow | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);
  const [toleranceOpen, setToleranceOpen] = useState(false);
  const [tolerance, setTolerance] = useState<ReconTolerance | null>(null);
  const [busy, setBusy] = useState<null | 'import' | 'run' | 'export'>(null);
  const [lastImport, setLastImport] = useState<ReconImportResult | null>(null);
  const periodRef = useRef<HTMLSelectElement | null>(null);

  const reconTab = tab === 'purchases' || tab === 'gstr1';
  const summaryQ = useApiQuery('gstrecon.summary', { period, source }, { keepPrevious: true, enabled: tab !== 'imports' });
  // A quarter's summary carries the quarter's last month as its period key.
  const summary = summaryQ.data && !summaryQ.isPrevious && summaryQ.data.period === storageMonth(period) && summaryQ.data.source === source ? summaryQ.data : undefined;
  const resultsQ = useApiQuery(
    'gstrecon.results',
    { period, source, status, supplierGstin: supplier || undefined, search: debouncedSearch.trim() || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
    { keepPrevious: true, enabled: reconTab && !!summary?.batch },
  );
  const suppliersQ = useApiQuery('gstrecon.supplierSummary', { period, source }, { keepPrevious: true, enabled: tab === 'suppliers' || (reconTab && !!summary?.run) });
  const batchesQ = useApiQuery('gstrecon.batches', {}, { enabled: tab === 'imports' });

  const effectiveTolerance = tolerance ?? summary?.run?.tolerance ?? DEFAULT_RECON_TOLERANCE;
  const runMut = useApiMutation('gstrecon.run');
  const compareMut = useApiMutation('gstrecon.gstr1.compare');
  const importMut = useApiMutation('gstrecon.import');
  const deleteMut = useApiMutation('gstrecon.batch.delete');

  const rows = useMemo(() => resultsQ.data?.rows ?? [], [resultsQ.data]);
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  const periodGroups = useMemo(() => periodOptionGroups(booksFrom, today, 36, tab === 'gstr1'), [booksFrom, today, tab]);

  // ── Actions ──────────────────────────────────────────────────────────

  const reconcile = async (t: ReconTolerance = effectiveTolerance, quiet = false): Promise<ReconSummary | undefined> => {
    if (!canFile || busy) return undefined;
    setBusy('run');
    try {
      const s = source === 'gstr1' ? await compareMut.mutate({ period, tolerance: t }) : await runMut.mutate({ period, source, tolerance: t });
      setTolerance(t);
      setToleranceOpen(false);
      const c = s.run?.counts ?? {};
      if (!quiet) {
        toast.success(`${label} reconciled for ${periodLabel(period)}`, {
          message: `${c.matched ?? 0} matched · ${s.openCount} need action${s.otherPeriodCount ? ` · ${s.otherPeriodCount} reported in another month` : ''}`,
        });
      }
      return s;
    } catch (err) {
      toast.error('The reconciliation did not run', { message: userMessage(err) });
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (): Promise<void> => {
    if (!canFile || busy) return;
    let picked: Awaited<ReturnType<typeof native<'dialog.openFile'>>>;
    try {
      picked = await native('dialog.openFile', {
        title: `Choose the ${label} file for ${periodLabel(period)}`,
        filters: [
          source === 'gstr1'
            ? { name: 'GSTR-1 JSON (or ZIP)', extensions: ['json', 'zip'] }
            : { name: `${label} JSON, ZIP or Excel`, extensions: ['json', 'zip', 'xlsx'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
    } catch (err) {
      toast.error('The file could not be opened', { message: userMessage(err) });
      return;
    }
    if (!picked) return;
    const input = { source, period, fileName: picked.name, bytes: picked.bytes };
    setBusy('import');
    let res: ReconImportResult | undefined;
    try {
      try {
        res = await importMut.mutate(input);
      } catch (err) {
        if (!(isApiError(err) && err.code === 'CONFLICT' && isConflictDetails(err.details))) throw err;
        const m = conflictMessage(err.details);
        if (!(await confirm({ title: m.title, message: m.message, confirmLabel: 'Replace' }))) return;
        res = await importMut.mutate({ ...input, replace: true });
      }
    } catch (err) {
      toast.error('The file was not imported', { message: userMessage(err) });
      return;
    } finally {
      setBusy(null);
    }
    if (!res) return;
    setLastImport(res);
    toast.success(importResultText(res), res.warnings.length > 0 ? { message: `${res.warnings.length} ${res.warnings.length === 1 ? 'note' : 'notes'} — see the banner` } : undefined);
    await reconcile(effectiveTolerance, false);
  };

  const exportWorkbook = async (format: 'xlsx' | 'csv' = 'xlsx'): Promise<void> => {
    if (!canExport || busy || !summary?.batch) return;
    setBusy('export');
    try {
      const out = await api('gstrecon.export', { period, source, format });
      const saved = await native('dialog.saveFile', {
        title: `Export ${label} reconciliation`,
        defaultName: out.fileName,
        filters: format === 'xlsx' ? [{ name: 'Excel workbook', extensions: ['xlsx'] }] : [{ name: 'CSV (comma separated)', extensions: ['csv'] }],
        data: out.bytes,
      });
      if (saved) toast.success('Reconciliation exported', { message: saved.path, action: { label: 'Show in folder', onClick: () => showInFolder(saved.path) } });
    } catch (err) {
      toast.error('Could not export', { message: userMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const printRows = async (): Promise<void> => {
    if (rows.length === 0 || !canExport) return; // printing is export: data.export (checked again by the core)
    const filter = statusFilterOptions(source, resultsQ.data?.counts ?? {}).find((o) => o.value === status)?.label ?? '';
    const def = resultsExport(rows, source, periodLabel(period), `${filter}${supplier ? ` · ${supplier}` : ''}`);
    try {
      await printReport({ ...def, company: company?.name });
    } catch (err) {
      toast.error('Could not print', { message: userMessage(err) });
    }
  };

  const deleteBatch = async (b: ImportBatchView): Promise<void> => {
    if (!canFile) return;
    const ok = await confirm({
      title: `Delete the ${RECON_SOURCE_LABELS[b.source]} import for ${b.periodLabel}?`,
      message: `${b.docCount} documents${b.fileName ? ` from ${b.fileName}` : ''} and their reconciliation results are removed. Your links, accepted and ignored documents are kept for the next import.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await deleteMut.mutate({ id: b.id });
      toast.success(`Import deleted — ${RECON_SOURCE_LABELS[b.source]} ${b.periodLabel}`);
    } catch (err) {
      toast.error('Could not delete the import', { message: userMessage(err) });
    }
  };

  const openSupplier = (gstin: string): void => {
    setTab('purchases');
    setSupplier(gstin);
    setStatus('all');
  };

  const followUpGstin = tab === 'suppliers' ? null : (drawerRow?.gstin ?? selectedRow?.gstin ?? (supplier || null));
  const [supplierCursor, setSupplierCursor] = useState<string | null>(null);
  // Only a real supplier GSTIN (the supplier table keys a row without GSTIN as '(none)').
  const followUpTarget = (() => {
    const g = tab === 'suppliers' ? supplierCursor : followUpGstin;
    return g && /^[0-9A-Z]{15}$/.test(g) ? g : null;
  })();

  const actions: ScreenActionItem[] = [
    { key: 'Alt+F2', label: 'Return period', icon: 'calendar', onClick: () => periodRef.current?.focus(), group: 'period' },
    {
      key: 'Alt+S',
      label: purchaseSource === 'gstr2b' ? 'Use GSTR-2A' : 'Use GSTR-2B',
      icon: 'sync',
      onClick: () => setPurchaseSource((s) => (s === 'gstr2b' ? 'gstr2a' : 'gstr2b')),
      hidden: tab === 'gstr1' || tab === 'imports',
      group: 'period',
    },
    {
      key: 'Alt+O',
      label: `Import ${label}`,
      icon: 'upload',
      primary: !summary?.batch,
      onClick: () => void importFile(),
      disabled: !canFile || busy !== null,
      hidden: !reconTab,
      hint: canFile ? 'JSON, ZIP or Excel file downloaded from the GST portal' : 'You need the "File GST returns" permission',
      group: 'file',
    },
    {
      key: 'Alt+R',
      label: 'Reconcile',
      icon: 'refresh',
      primary: !!summary?.batch && (summary.stale || !summary.run),
      onClick: () => void reconcile(),
      disabled: !canFile || busy !== null || !summary?.batch,
      hidden: !reconTab,
      hint: summary?.batch ? toleranceText(effectiveTolerance) : `Import the ${label} first`,
      group: 'file',
    },
    { key: 'Alt+T', label: 'Matching rules', icon: 'sliders', onClick: () => setToleranceOpen(true), disabled: !canFile || !summary?.batch, hidden: !reconTab, group: 'file' },
    {
      key: 'Alt+M',
      label: `${partyWord(purchaseSource)} e-mail`,
      icon: 'mail',
      onClick: () => followUpTarget && setFollowUp(followUpTarget),
      disabled: !followUpTarget || !summary?.run,
      hidden: tab === 'gstr1' || tab === 'imports',
      hint: summary?.run ? 'Select a supplier row first' : 'Reconcile first',
      group: 'output',
    },
    {
      key: 'Alt+E',
      label: 'Export to Excel',
      icon: 'export',
      onClick: () => void exportWorkbook('xlsx'),
      disabled: !canExport || busy !== null || !summary?.batch,
      hidden: tab === 'imports',
      hint: canExport ? 'Workbook with the summary, every status and the supplier-wise sheet' : 'You need the "Export data" permission',
      group: 'output',
    },
    { key: 'Alt+P', label: 'Print rows', icon: 'print', onClick: () => void printRows(), disabled: rows.length === 0 || !canExport, hidden: !reconTab, group: 'output', hint: canExport ? undefined : 'You need the "Export data" permission' },
  ];

  const statusOptions = useMemo(
    () => statusFilterOptions(source, resultsQ.data?.counts ?? {}, supplier ? undefined : summary?.otherPeriodCount),
    [source, resultsQ.data, supplier, summary?.otherPeriodCount],
  );
  const supplierOptions = useMemo(
    () => [{ value: '', label: `All ${party.toLowerCase()}s` }, ...(suppliersQ.data ?? []).map((s) => ({ value: s.gstin, label: `${s.name ?? s.gstin}${s.gstin ? ` · ${s.gstin}` : ''}` }))],
    [suppliersQ.data, party],
  );

  const headerBar = (
    <div className="bx-gr-bar">
      <label className="bx-gr-field">
        <span className="bx-gr-bar__label">Return period</span>
        <Select ref={periodRef} size="sm" aria-label="Return period" aria-keyshortcuts="Alt+F2" options={periodGroups} value={period} onChange={(v) => setPeriod(v)} />
      </label>
      {tab === 'purchases' || tab === 'suppliers' ? (
        <SegmentedControl
          size="sm"
          aria-label="Compare purchases with"
          value={purchaseSource}
          onChange={setPurchaseSource}
          options={[
            { value: 'gstr2b', label: 'GSTR-2B' },
            { value: 'gstr2a', label: 'GSTR-2A' },
          ]}
        />
      ) : null}
      {summary?.batch ? (
        <span className="bx-gr-meta">
          {summary.batch.fileName ?? 'File'} · imported {formatDateTime(summary.batch.importedAt)}
          {summary.run ? ` · reconciled ${formatDateTime(summary.run.runAt)} (${toleranceText(summary.run.tolerance)})` : ''}
        </span>
      ) : null}
    </div>
  );

  const reconBody = (
    <ReconPanel
      source={source}
      period={period}
      summary={summary}
      summaryLoading={summaryQ.loading}
      canFile={canFile}
      busy={busy}
      lastImport={lastImport && lastImport.source === source && lastImport.period === storageMonth(period) ? lastImport : null}
      onDismissImport={() => setLastImport(null)}
      onImport={() => void importFile()}
      onRun={() => void reconcile()}
      status={status}
      onStatus={setStatus}
      statusOptions={statusOptions}
      supplier={supplier}
      onSupplier={setSupplier}
      supplierOptions={supplierOptions}
      search={search}
      onSearch={setSearch}
      rows={rows}
      total={resultsQ.data?.total ?? 0}
      rowsLoading={resultsQ.loading}
      rowsError={resultsQ.error}
      page={page}
      onPage={setPage}
      selectedKey={selectedKey}
      onSelect={setSelectedKey}
      onOpen={(r) => setDrawerRow(r)}
    />
  );

  return (
    <Screen
      title="GST Reconciliation"
      subtitle={tab === 'imports' ? 'Files imported from the GST portal' : `${label} vs ${source === 'gstr1' ? 'sales' : 'purchase'} books · ${periodLabel(period)}`}
      icon="gst"
      toolbar={headerBar}
      actions={actions}
      error={tab !== 'imports' && !summary ? summaryQ.error : null}
      onRetry={() => void summaryQ.refetch()}
      hint={
        tab === 'imports'
          ? 'Enter Open · Alt+D Delete import · Esc Back'
          : 'Enter Compare · Alt+O Import · Alt+R Reconcile · Alt+T Rules · Alt+M E-mail · Alt+E Export · Alt+F2 Period · Esc Back'
      }
    >
      <Tabs
        aria-label="Reconciliation views"
        value={tab}
        onChange={(id) => setTab(TABS.includes(id as GstReconTab) ? (id as GstReconTab) : 'purchases')}
        items={[
          { id: 'purchases', label: 'Purchases', icon: 'cart', content: tab === 'purchases' ? reconBody : null },
          {
            id: 'suppliers',
            label: 'Supplier-wise',
            icon: 'users',
            content:
              tab === 'suppliers' ? (
                <SupplierTab
                  rows={suppliersQ.data ?? []}
                  loading={suppliersQ.loading}
                  error={suppliersQ.error}
                  hasRun={!!summary?.run}
                  source={purchaseSource}
                  cursor={supplierCursor}
                  onCursor={setSupplierCursor}
                  onOpen={(s) => openSupplier(s.gstin)}
                />
              ) : null,
          },
          { id: 'gstr1', label: 'GSTR-1 vs sales', icon: 'invoice', content: tab === 'gstr1' ? reconBody : null },
          {
            id: 'imports',
            label: 'Imported files',
            icon: 'folder',
            content:
              tab === 'imports' ? (
                <ImportsTab
                  batches={batchesQ.data ?? []}
                  loading={batchesQ.loading}
                  error={batchesQ.error}
                  canFile={canFile}
                  onOpen={(b) => {
                    setPeriod(b.period);
                    if (b.source === 'gstr1') setTab('gstr1');
                    else {
                      setPurchaseSource(b.source === 'gstr2a' ? 'gstr2a' : 'gstr2b');
                      setTab('purchases');
                    }
                  }}
                  onDelete={(b) => void deleteBatch(b)}
                />
              ) : null,
          },
        ]}
      />
      <CompareDrawer
        row={drawerRow}
        period={period}
        source={source}
        onClose={() => setDrawerRow(null)}
        onRowChange={(r) => setDrawerRow(r)}
        onFollowUp={(g) => setFollowUp(g)}
      />
      <ToleranceDialog open={toleranceOpen} value={effectiveTolerance} busy={busy === 'run'} onRun={(t) => void reconcile(t)} onClose={() => setToleranceOpen(false)} />
      <FollowUpDialog open={followUp !== null} period={period} source={purchaseSource} gstin={followUp} onClose={() => setFollowUp(null)} />
    </Screen>
  );
}

// ───────────────────────────── Reconciliation panel ─────────────────────────────

interface ReconPanelProps {
  source: ReconSource;
  period: string;
  summary: ReconSummary | undefined;
  summaryLoading: boolean;
  canFile: boolean;
  busy: null | 'import' | 'run' | 'export';
  lastImport: ReconImportResult | null;
  onDismissImport: () => void;
  onImport: () => void;
  onRun: () => void;
  status: ReconStatusFilter;
  onStatus: (s: ReconStatusFilter) => void;
  statusOptions: Array<{ value: ReconStatusFilter; label: string }>;
  supplier: string;
  onSupplier: (g: string) => void;
  supplierOptions: Array<{ value: string; label: string }>;
  search: string;
  onSearch: (s: string) => void;
  rows: ReconRow[];
  total: number;
  rowsLoading: boolean;
  rowsError: unknown;
  page: number;
  onPage: (p: number) => void;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onOpen: (r: ReconRow) => void;
}

function ReconPanel(p: ReconPanelProps) {
  const { source, period, summary } = p;
  const label = RECON_SOURCE_LABELS[source];
  const party = partyWord(source);

  if (!summary) {
    return p.summaryLoading ? <p className="bx-gr-meta">Loading…</p> : null;
  }

  if (!summary.batch) {
    const where =
      source === 'gstr2b'
        ? 'GST portal › Returns › GSTR-2B › View/Download (JSON or Excel)'
        : source === 'gstr2a'
          ? 'GST portal › Returns › GSTR-2A › Download (JSON or Excel)'
          : 'GST portal › Returns › GSTR-1 › Download the filed return (JSON), or the JSON exported from Bahi';
    return (
      <EmptyState
        icon="upload"
        title={`No ${label} imported for ${periodLabel(period)}`}
        body={`Download it from ${where}, then press Alt+O to import it. The reconciliation runs right after the import.`}
        action={
          p.canFile ? (
            <Button variant="primary" icon="upload" shortcut="Alt+O" loading={p.busy === 'import'} onClick={p.onImport}>
              Import {label}
            </Button>
          ) : (
            <span className="bx-gr-meta">Importing needs the “File GST returns” permission.</span>
          )
        }
      />
    );
  }

  const counts = summary.run?.counts ?? {};
  const statusOf = (s: ReconStatus): number => counts[s] ?? 0;
  return (
    <div className="bx-gr-body">
      {p.lastImport && p.lastImport.warnings.length > 0 ? (
        <Banner tone="warning" title={`${p.lastImport.warnings.length} ${p.lastImport.warnings.length === 1 ? 'note' : 'notes'} on the imported file`} onDismiss={p.onDismissImport}>
          <ul className="bx-gr-notes">
            {p.lastImport.warnings.slice(0, 8).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {!summary.run ? (
        <Banner
          tone="info"
          title="Not reconciled yet"
          action={
            p.canFile ? (
              <Button size="sm" variant="primary" icon="refresh" shortcut="Alt+R" loading={p.busy === 'run'} onClick={p.onRun}>
                Reconcile now
              </Button>
            ) : undefined
          }
        >
          {summary.batch.docCount} documents from the {label} are ready to compare with your books.
        </Banner>
      ) : summary.stale ? (
        <Banner
          tone="warning"
          title="Results are out of date"
          action={
            p.canFile ? (
              <Button size="sm" icon="refresh" shortcut="Alt+R" loading={p.busy === 'run'} onClick={p.onRun}>
                Reconcile again
              </Button>
            ) : undefined
          }
        >
          {summary.staleReason}
        </Banner>
      ) : null}
      {summary.warnings.length > 0 && !p.lastImport ? (
        <p className="bx-gr-help">
          <Icon name="info" size="sm" />
          <span>{summary.warnings.join(' ')}</span>
        </p>
      ) : null}

      {summary.run ? (
        <>
          <div className="bx-gr-tiles" role="group" aria-label="Rows by status — choose one to filter">
            {TILE_STATUSES.map((s) => (
              <KpiCard
                key={s}
                className={`bx-gr-tile${p.status === s ? ' is-active' : ''}`}
                aria-pressed={p.status === s}
                label={statusLabel(s, source)}
                value={String(statusOf(s))}
                caption={statusAdvice(s, source)}
                onClick={() => p.onStatus(p.status === s ? 'open' : s)}
              />
            ))}
          </div>
          <div className="bx-gr-split">
            <div className="bx-gr-itc">
              {itcTiles(summary).map((t) => (
                <KpiCard key={t.key} label={t.label} value={t.value ?? '—'} amount={t.value !== null} caption={t.caption} />
              ))}
            </div>
            <HeadsCard summary={summary} />
          </div>
        </>
      ) : null}

      <Inline gap={2} align="end" wrap>
        <label className="bx-gr-field">
          <span className="bx-gr-bar__label">Show</span>
          <Select size="sm" aria-label="Show rows" options={p.statusOptions} value={p.status} onChange={(v) => p.onStatus(v)} />
        </label>
        <label className="bx-gr-field">
          <span className="bx-gr-bar__label">{party}</span>
          <Select size="sm" aria-label={party} options={p.supplierOptions} value={p.supplier} onChange={(v) => p.onSupplier(v)} />
        </label>
        <TextInput
          size="sm"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
          leadingIcon="search"
          placeholder="Search number, GSTIN, name, remarks"
          aria-label="Search rows"
        />
      </Inline>

      <div className="bx-gr-table-fill">
        {p.rowsError ? (
          <Banner tone="danger" title="The rows could not be loaded">
            {userMessage(p.rowsError)}
          </Banner>
        ) : (
          <ResultsTable source={source} rows={p.rows} loading={p.rowsLoading} selectedKey={p.selectedKey} onSelect={p.onSelect} onOpen={p.onOpen} status={p.status} />
        )}
        {p.total > PAGE_SIZE ? <Pagination page={p.page} pageSize={PAGE_SIZE} total={p.total} onPageChange={p.onPage} itemLabel="rows" /> : null}
      </div>
    </div>
  );
}

function HeadsCard({ summary }: { summary: ReconSummary }) {
  const inward = summary.source !== 'gstr1';
  const columns = useMemo<Column<HeadLine>[]>(
    () => [
      { key: 'label', header: 'Head', width: 110 },
      { key: 'portal', header: inward ? 'Portal ITC' : 'GSTR-1', kind: 'amount' },
      { key: 'books', header: 'Books', kind: 'amount', render: (r) => (r.books === null ? '—' : formatMoney(r.books)) },
      { key: 'difference', header: 'Difference', kind: 'amount', render: (r) => signedMoney(r.difference) },
    ],
    [inward],
  );
  const rows = useMemo(() => headLines(summary), [summary]);
  return (
    <Card title={inward ? 'ITC per head: portal vs books' : 'Tax per head: GSTR-1 vs books'} padding="none">
      <DataTable aria-label="Tax per head" columns={columns} rows={rows} getRowKey={(r) => r.key} density="compact" virtualize={false} />
    </Card>
  );
}

function ResultsTable({
  source,
  rows,
  loading,
  selectedKey,
  onSelect,
  onOpen,
  status,
}: {
  source: ReconSource;
  rows: ReconRow[];
  loading: boolean;
  selectedKey: string | null;
  onSelect: (k: string | null) => void;
  onOpen: (r: ReconRow) => void;
  status: ReconStatusFilter;
}) {
  const party = partyWord(source);
  const columns = useMemo<Column<ReconRow>[]>(
    () => [
      {
        key: 'status',
        header: 'Status',
        width: 150,
        value: (r) => statusLabel(r.status, source),
        render: (r) => (
          <Badge tone={STATUS_TONES[r.status]} size="sm" dot>
            {statusLabel(r.status, source)}
          </Badge>
        ),
        sortable: true,
      },
      { key: 'gstin', header: `${party} GSTIN`, width: 150, value: (r) => r.gstin || '—', sortable: true },
      { key: 'name', header: 'Name', minWidth: 140, value: (r) => r.name ?? '', sortable: true },
      { key: 'docNo', header: 'Document no.', width: 140, value: (r) => rowDocNo(r), sortable: true },
      { key: 'date', header: 'Date', kind: 'date', width: 104, value: (r) => rowDocDate(r) || null, sortable: true },
      {
        key: 'voucher',
        header: 'Voucher',
        width: 120,
        value: (r) => (r.books ? `${r.books.voucherType} ${r.books.voucherNumber ?? ''}`.trim() : ''),
      },
      { key: 'taxable', header: 'Taxable value', kind: 'amount', width: 120, value: (r) => r.portal?.taxable ?? r.books?.taxable ?? 0 },
      { key: 'pTax', header: source === 'gstr1' ? 'Tax (GSTR-1)' : 'Tax (portal)', kind: 'amount', width: 110, value: (r) => r.portal?.tax ?? null, render: (r) => (r.portal ? formatMoney(r.portal.tax) : '') },
      { key: 'bTax', header: 'Tax (books)', kind: 'amount', width: 110, value: (r) => r.books?.tax ?? null, render: (r) => (r.books ? formatMoney(r.books.tax) : '') },
      { key: 'diff', header: 'Difference', kind: 'amount', width: 100, value: (r) => r.difference?.tax ?? 0, render: (r) => signedMoney(r.difference?.tax), sortable: true },
      {
        key: 'info',
        header: 'Notes',
        minWidth: 140,
        value: (r) =>
          [
            r.otherPeriod ? (r.kind === 'books' ? `Filed in ${periodLabel(r.otherPeriod)}` : `Also in ${periodLabel(r.otherPeriod)}`) : '',
            r.suggestionCount > 0 ? `${r.suggestionCount} probable match${r.suggestionCount === 1 ? '' : 'es'}` : '',
            r.manual ? 'Linked manually' : '',
            r.remarks ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
      },
    ],
    [source, party],
  );
  const empty =
    status === 'open' ? (
      <EmptyState icon="check-circle" title="Nothing needs action" body="Every document matches or has been accepted. Choose “All rows” to see them." size="sm" />
    ) : (
      <EmptyState icon="filter" title="No rows" body="No document fits this filter. Change the filter or the search." size="sm" />
    );
  return (
    <DataTable
      aria-label="Reconciliation rows"
      autoFocus
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.key}
      loading={loading}
      selectedKey={selectedKey}
      onSelect={(k) => onSelect(k)}
      onRowActivate={onOpen}
      empty={empty}
      density="compact"
    />
  );
}

// ───────────────────────────── Supplier-wise ─────────────────────────────

function SupplierTab({
  rows,
  loading,
  error,
  hasRun,
  source,
  cursor,
  onCursor,
  onOpen,
}: {
  rows: SupplierReconRow[];
  loading: boolean;
  error: unknown;
  hasRun: boolean;
  source: 'gstr2b' | 'gstr2a';
  cursor: string | null;
  onCursor: (g: string | null) => void;
  onOpen: (s: SupplierReconRow) => void;
}) {
  const columns = useMemo<Column<SupplierReconRow>[]>(
    () => [
      { key: 'gstin', header: 'Supplier GSTIN', width: 160, sortable: true },
      { key: 'name', header: 'Name', minWidth: 160, value: (r) => r.name ?? '', sortable: true },
      { key: 'portalCount', header: 'On portal', kind: 'number', width: 90 },
      { key: 'booksCount', header: 'In books', kind: 'number', width: 90 },
      { key: 'openCount', header: 'Needs action', kind: 'number', width: 110, sortable: true },
      { key: 'portalTax', header: `Tax (${RECON_SOURCE_LABELS[source]})`, kind: 'amount', width: 130, total: true },
      { key: 'booksTax', header: 'Tax (books)', kind: 'amount', width: 120, total: true },
      { key: 'taxDifference', header: 'Difference', kind: 'amount', width: 110, render: (r) => signedMoney(r.taxDifference), sortable: true },
    ],
    [source],
  );
  if (error) {
    return (
      <Banner tone="danger" title="The supplier summary could not be loaded">
        {userMessage(error)}
      </Banner>
    );
  }
  if (!loading && !hasRun) {
    return <EmptyState icon="users" title="Reconcile first" body="Import the GSTR-2B (Alt+O) and reconcile (Alt+R) on the Purchases tab; the supplier-wise picture appears here." />;
  }
  return (
    <div className="bx-gr-table-fill">
      <p className="bx-gr-help">
        <Icon name="info" size="sm" />
        <span>Suppliers with the most to fix come first. Enter shows their documents; Alt+M prepares an e-mail asking them to correct their GSTR-1.</span>
      </p>
      <DataTable
        aria-label="Supplier-wise reconciliation"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.gstin || '(none)'}
        loading={loading}
        selectedKey={cursor}
        onSelect={(k) => onCursor(k)}
        onRowActivate={onOpen}
        empty={<EmptyState icon="users" title="No suppliers" body="Neither the portal file nor your books have documents for this period." size="sm" />}
        density="compact"
      />
    </div>
  );
}

// ───────────────────────────── Imported files ─────────────────────────────

function ImportsTab({
  batches,
  loading,
  error,
  canFile,
  onOpen,
  onDelete,
}: {
  batches: ImportBatchView[];
  loading: boolean;
  error: unknown;
  canFile: boolean;
  onOpen: (b: ImportBatchView) => void;
  onDelete: (b: ImportBatchView) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const selected = batches.find((b) => String(b.id) === cursor) ?? null;
  const columns = useMemo<Column<ImportBatchView>[]>(
    () => [
      { key: 'source', header: 'Return', width: 90, value: (b) => RECON_SOURCE_LABELS[b.source] },
      { key: 'periodLabel', header: 'Period', width: 130 },
      { key: 'fileName', header: 'File', minWidth: 160, value: (b) => b.fileName ?? '' },
      { key: 'importedAt', header: 'Imported', width: 160, value: (b) => formatDateTime(b.importedAt) },
      { key: 'importedBy', header: 'By', width: 120, value: (b) => b.importedBy ?? '' },
      { key: 'docCount', header: 'Documents', kind: 'number', width: 100 },
      { key: 'tax', header: 'Tax', kind: 'amount', width: 120, value: (b) => b.totals.tax },
      { key: 'lastRunAt', header: 'Reconciled', width: 160, value: (b) => (b.lastRunAt ? formatDateTime(b.lastRunAt) : 'Not yet') },
      { key: 'openCount', header: 'Needs action', kind: 'number', width: 110, value: (b) => b.openCount ?? null, render: (b) => (b.openCount === null ? '—' : String(b.openCount)) },
    ],
    [],
  );
  if (error) {
    return (
      <Banner tone="danger" title="The imports could not be loaded">
        {userMessage(error)}
      </Banner>
    );
  }
  return (
    <Stack gap={2}>
      <Inline gap={2} justify="end">
        <Button icon="trash" variant="danger" shortcut="Alt+D" disabled={!canFile || !selected} onClick={() => selected && onDelete(selected)}>
          Delete import
        </Button>
      </Inline>
      <ImportsKeys onDelete={canFile && selected ? () => onDelete(selected) : undefined} />
      <DataTable
        aria-label="Imported files"
        autoFocus
        columns={columns}
        rows={batches}
        getRowKey={(b) => String(b.id)}
        loading={loading}
        selectedKey={cursor}
        onSelect={(k) => setCursor(k)}
        onRowActivate={onOpen}
        empty={<EmptyState icon="folder" title="No files imported yet" body="Import a GSTR-2B, GSTR-2A or GSTR-1 file from the Purchases or GSTR-1 tab (Alt+O)." size="sm" />}
        density="compact"
      />
    </Stack>
  );
}

function ImportsKeys({ onDelete }: { onDelete?: () => void }) {
  useHotkeys({ 'Alt+D': onDelete }, [onDelete]);
  return null;
}

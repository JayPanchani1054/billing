/**
 * 'gstrecon.home' {period?: MMYYYY (or 'YYYY-YY-Qn' with the GSTR-1 view, quarterly filers), source?: 'gstr2b' | 'gstr2a' | 'gstr1',
 * tab?: 'purchases' | 'suppliers' | 'gstr1' | 'imports'} — GST reconciliation.
 *
 * Views (the "Reconciliation views" token of the title row): GSTR-2B / GSTR-2A vs purchase books ·
 * Supplier-wise · GSTR-1 vs sales · Imported files. Keys: Alt+F2 return period · Alt+S GSTR-2B/2A ·
 * Alt+O import the portal file · Alt+R reconcile · Alt+T matching rules · Enter on a row → compare
 * drawer (Ctrl+A accept, Alt+I ignore, Alt+U undo/unlink) · Alt+M supplier follow-up e-mail · Alt+E
 * export (Excel workbook) · Alt+P print the rows shown · Alt+D delete an import (Imported files) · Esc back.
 *
 * 2.1 (SPEC-21 §1.2, §5, WP-J2): one title row (the view and the return period are its context tokens),
 * one toolbar row (Show · search · Filters on the left, the answer in words on the right — "ITC at risk
 * ₹x · Reconciled y %"), one graph (lib/charts.ts, through Screen's `graph` prop: the documents by status
 * as a share bar whose segments filter the table; on Supplier-wise the tax difference per supplier,
 * inline bars in a short table), then the table. The status tiles, the ITC tiles and the per-head card
 * left the screen: the graph and the "Show" filter carry the statuses, the stat the ITC figures, and
 * More ▾ › About this reconciliation the file, the matching rules, the notes and tax per head.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ImportBatchView,
  ReconImportConflict,
  ReconImportResult,
  ReconRow,
  ReconSource,
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
import { aboutItem } from '../../app/lib/moreItems.ts';
import { Badge, Banner, DataTable, Drawer, EmptyState, FiltersPopover, Pagination, Select, Stack, StatLine, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { inlineBars } from '../../ui/lib/chartSpec.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { CompareDrawer } from './CompareDrawer.tsx';
import { FollowUpDialog, ToleranceDialog } from './dialogs.tsx';
import { reconChart, reconStat, supplierChart } from './lib/charts.ts';
import { defaultPeriod, isQuarterKey, periodLabel, periodOptionGroups, storageMonth } from './lib/periods.ts';
import { conflictMessage, headLines, importResultText, partyWord, resultsExport, rowDocDate, rowDocNo, signedMoney, statusFilterOptions, statusLabel, STATUS_TONES, toleranceText } from './lib/recon.ts';
import type { HeadLine } from './lib/recon.ts';

export type GstReconTab = 'purchases' | 'suppliers' | 'gstr1' | 'imports';

export interface GstReconParams {
  period?: string;
  source?: ReconSource;
  tab?: GstReconTab;
}

const PAGE_SIZE = 200;
const TABS: readonly GstReconTab[] = ['purchases', 'suppliers', 'gstr1', 'imports'];
const NEED_FILE = 'You need the "Prepare GST filings" permission';

/** The "Reconciliation views" choices: the purchase source is part of the view's name. */
type ViewValue = 'gstr2b' | 'gstr2a' | 'suppliers' | 'gstr1' | 'imports';

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
  // Quarters (QRMP GSTR-1) exist only on the GSTR-1 view; elsewhere fall back to the quarter's last month.
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [tolerance, setTolerance] = useState<ReconTolerance | null>(null);
  const [busy, setBusy] = useState<null | 'import' | 'run' | 'export'>(null);
  const [lastImport, setLastImport] = useState<ReconImportResult | null>(null);
  const [batchCursor, setBatchCursor] = useState<string | null>(null);
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
  const batches = batchesQ.data ?? [];
  const selectedBatch = batches.find((b) => String(b.id) === batchCursor) ?? batches[0] ?? null;

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
    // Imported files lists every period, so it shows no period select: the key stays this screen's (never the
    // app's period dialog), disabled with the reason.
    {
      key: 'Alt+F2',
      label: 'Return period',
      icon: 'calendar',
      onClick: () => periodRef.current?.focus(),
      disabled: tab === 'imports',
      hint: tab === 'imports' ? 'Imported files lists every period — open a file (Enter) to reconcile its period' : undefined,
      group: 'period',
    },
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
      hint: canFile ? 'JSON, ZIP or Excel file downloaded from the GST portal' : NEED_FILE,
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
      hint: !canFile ? NEED_FILE : summary?.batch ? toleranceText(effectiveTolerance) : `Import the ${label} first`,
      group: 'file',
    },
    { key: 'Alt+T', label: 'Matching rules', icon: 'sliders', onClick: () => setToleranceOpen(true), disabled: !canFile || !summary?.batch, hidden: !reconTab, hint: canFile ? undefined : NEED_FILE, group: 'file' },
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
    // The Imported files view's delete (2.0: a button above the table with its own Alt+D).
    { key: 'Alt+D', label: 'Delete import', icon: 'trash', onClick: () => selectedBatch && void deleteBatch(selectedBatch), disabled: !canFile || !selectedBatch, hidden: tab !== 'imports', hint: canFile ? undefined : NEED_FILE, group: 'danger' },
    ...(reconTab && summary?.batch ? [aboutItem(() => setAboutOpen(true), 'About this reconciliation')] : []),
  ];

  const statusOptions = useMemo(
    () => statusFilterOptions(source, resultsQ.data?.counts ?? {}, supplier ? undefined : summary?.otherPeriodCount),
    [source, resultsQ.data, supplier, summary?.otherPeriodCount],
  );
  const supplierOptions = useMemo(
    () => [{ value: '', label: `All ${party.toLowerCase()}s` }, ...(suppliersQ.data ?? []).map((s) => ({ value: s.gstin, label: `${s.name ?? s.gstin}${s.gstin ? ` · ${s.gstin}` : ''}` }))],
    [suppliersQ.data, party],
  );

  // The one graph of the view (SPEC-21 §5): documents by status (a segment filters the table), or —
  // Supplier-wise — the tax difference per supplier (inline bars when the table is that short).
  const supplierRows = useMemo(() => suppliersQ.data ?? [], [suppliersQ.data]);
  const spec = useMemo(
    () => (tab === 'suppliers' ? supplierChart(supplierRows, (r) => openSupplier(r.gstin)) : reconTab && summary ? reconChart(summary, (st) => setStatus(st)) : null),
    // openSupplier / setStatus only call state setters.
    [tab, reconTab, summary, supplierRows],
  );
  const inline = tab === 'suppliers' && inlineBars(spec, supplierRows.length);
  const stat = reconTab && summary ? reconStat(summary) : [];

  const viewValue: ViewValue = tab === 'purchases' ? purchaseSource : tab;
  const context = (
    <>
      <span className="bx-gr-token">
        <Select<ViewValue>
          size="sm"
          aria-label="Reconciliation views"
          value={viewValue}
          options={[
            { value: 'gstr2b', label: 'GSTR-2B vs purchases' },
            { value: 'gstr2a', label: 'GSTR-2A vs purchases' },
            { value: 'suppliers', label: `Supplier-wise (${RECON_SOURCE_LABELS[purchaseSource]})` },
            { value: 'gstr1', label: 'GSTR-1 vs sales' },
            { value: 'imports', label: 'Imported files' },
          ]}
          onChange={(v) => {
            if (v === 'gstr2b' || v === 'gstr2a') {
              setPurchaseSource(v);
              setTab('purchases');
            } else setTab(v);
          }}
        />
      </span>
      {tab !== 'imports' ? (
        <>
          <span aria-hidden="true"> · </span>
          <span className="bx-gr-token">
            <Select ref={periodRef} size="sm" aria-label="Return period" aria-keyshortcuts="Alt+F2" options={periodGroups} value={period} onChange={(v) => setPeriod(v)} />
          </span>
        </>
      ) : null}
    </>
  );

  // Toolbar row: the table's filters (one filter, one search, the rest under Filters) and the answer.
  const tools =
    reconTab && summary?.batch ? (
      <div className="bx-gr-tools">
        <Select size="sm" aria-label="Show rows" options={statusOptions} value={status} onChange={(v) => setStatus(v)} />
        <TextInput size="sm" value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Search rows" aria-label="Search rows" title="Number, GSTIN, name or remarks" />
        <FiltersPopover count={supplier ? 1 : 0} onClear={() => setSupplier('')}>
          <Select size="sm" aria-label={party} options={supplierOptions} value={supplier} onChange={(v) => setSupplier(v)} />
        </FiltersPopover>
        {stat.length ? <StatLine items={stat} /> : null}
      </div>
    ) : undefined;

  return (
    <Screen
      title="GST Reconciliation"
      subtitle={context}
      actions={actions}
      graph={reportGraph(spec, { inline })}
      stat={tools}
      error={tab !== 'imports' && !summary ? summaryQ.error : null}
      onRetry={() => void summaryQ.refetch()}
      hint={
        tab === 'imports'
          ? 'Enter Open · Alt+D Delete import · Esc Back'
          : 'Enter Compare · Alt+O Import · Alt+R Reconcile · Alt+T Rules · Alt+M E-mail · Alt+E Export · Alt+F2 Period · Esc Back'
      }
    >
      {reconTab ? (
        <ReconPanel
          source={source}
          period={period}
          summary={summary}
          summaryLoading={summaryQ.loading}
          canFile={canFile}
          lastImport={lastImport && lastImport.source === source && lastImport.period === storageMonth(period) ? lastImport : null}
          onDismissImport={() => setLastImport(null)}
          status={status}
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
      ) : tab === 'suppliers' ? (
        <SupplierTab
          rows={supplierRows}
          loading={suppliersQ.loading}
          error={suppliersQ.error}
          hasRun={!!summary?.run}
          source={purchaseSource}
          inline={inline}
          cursor={supplierCursor}
          onCursor={setSupplierCursor}
          onOpen={(s) => openSupplier(s.gstin)}
        />
      ) : (
        <ImportsTab
          batches={batches}
          loading={batchesQ.loading}
          error={batchesQ.error}
          cursor={selectedBatch ? String(selectedBatch.id) : null}
          onCursor={setBatchCursor}
          onOpen={(b) => {
            setPeriod(b.period);
            if (b.source === 'gstr1') setTab('gstr1');
            else {
              setPurchaseSource(b.source === 'gstr2a' ? 'gstr2a' : 'gstr2b');
              setTab('purchases');
            }
          }}
        />
      )}
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
      {summary ? <AboutDrawer open={aboutOpen} summary={summary} onClose={() => setAboutOpen(false)} /> : null}
    </Screen>
  );
}

// ───────────────────────────── Reconciliation view ─────────────────────────────

interface ReconPanelProps {
  source: ReconSource;
  period: string;
  summary: ReconSummary | undefined;
  summaryLoading: boolean;
  canFile: boolean;
  lastImport: ReconImportResult | null;
  onDismissImport: () => void;
  status: ReconStatusFilter;
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

  if (!summary) {
    return p.summaryLoading ? <p className="bx-muted">Loading…</p> : null;
  }

  if (!summary.batch) {
    const where =
      source === 'gstr2b'
        ? 'GST portal › Returns › GSTR-2B › View/Download (JSON or Excel)'
        : source === 'gstr2a'
          ? 'GST portal › Returns › GSTR-2A › Download (JSON or Excel)'
          : 'GST portal › Returns › GSTR-1 › Download the filed return (JSON), or the JSON exported from Pevqori';
    // The import itself is the title row's primary action (Alt+O) — not repeated here.
    return (
      <EmptyState
        title={`No ${label} imported for ${periodLabel(period)}`}
        body={
          p.canFile
            ? `Download it from ${where}, then import it (Alt+O). The reconciliation runs right after the import.`
            : `Download it from ${where}. Importing needs the “Prepare GST filings” permission.`
        }
      />
    );
  }

  return (
    <Stack gap={3}>
      {p.lastImport && p.lastImport.warnings.length > 0 ? (
        <Banner tone="warning" title={`${p.lastImport.warnings.length} ${p.lastImport.warnings.length === 1 ? 'note' : 'notes'} on the imported file`} onDismiss={p.onDismissImport}>
          <ul className="bx-gr-notes">
            {p.lastImport.warnings.slice(0, 8).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {/* Reconcile (Alt+R) is the title row's primary while these hold. */}
      {!summary.run ? (
        <Banner tone="info" title="Not reconciled yet">
          {summary.batch.docCount} documents from the {label} are ready to compare with your books (Alt+R).
        </Banner>
      ) : summary.stale ? (
        <Banner tone="warning" title="Results are out of date">
          {summary.staleReason} Reconcile again (Alt+R).
        </Banner>
      ) : null}
      {p.rowsError ? (
        <Banner tone="danger" title="The rows could not be loaded">
          {userMessage(p.rowsError)}
        </Banner>
      ) : (
        <ResultsTable source={source} rows={p.rows} loading={p.rowsLoading} selectedKey={p.selectedKey} onSelect={p.onSelect} onOpen={p.onOpen} status={p.status} />
      )}
      {p.total > PAGE_SIZE ? <Pagination page={p.page} pageSize={PAGE_SIZE} total={p.total} onPageChange={p.onPage} itemLabel="rows" /> : null}
    </Stack>
  );
}

/** More ▾ › About this reconciliation: the file, the run and its matching rules, the notes, tax per head. */
function AboutDrawer({ open, summary, onClose }: { open: boolean; summary: ReconSummary; onClose: () => void }) {
  const inward = summary.source !== 'gstr1';
  return (
    <Drawer open={open} onClose={onClose} title="About this reconciliation" description={`${summary.sourceLabel} · ${summary.periodLabel}`} size="lg">
      <Stack gap={4}>
        <Stack gap={1}>
          {summary.batch ? (
            <p>
              {summary.batch.fileName ?? 'File'} · {summary.batch.docCount} documents · imported {formatDateTime(summary.batch.importedAt)}
            </p>
          ) : null}
          {summary.run ? (
            <p>
              Reconciled {formatDateTime(summary.run.runAt)} · {toleranceText(summary.run.tolerance)}
            </p>
          ) : null}
          {summary.warnings.length > 0 ? <p className="bx-muted">{summary.warnings.join(' ')}</p> : null}
          <p className="bx-muted">
            {inward
              ? 'Enter on a row compares the portal and your books side by side. Supplier-wise lists the suppliers with the most to fix; Alt+M prepares an e-mail asking one to correct their GSTR-1.'
              : 'Enter on a row compares GSTR-1 and your books side by side.'}
          </p>
        </Stack>
        {summary.run ? <HeadsTable summary={summary} /> : null}
      </Stack>
    </Drawer>
  );
}

function HeadsTable({ summary }: { summary: ReconSummary }) {
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
  return <DataTable aria-label={inward ? 'ITC per head: portal vs books' : 'Tax per head: GSTR-1 vs books'} columns={columns} rows={rows} getRowKey={(r) => r.key} density="compact" virtualize={false} />;
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
      <EmptyState title="Nothing needs action" body="Every document matches or has been accepted. Choose “All rows” to see them." size="sm" />
    ) : (
      <EmptyState title="No rows" body="No document fits this filter. Change the filter or the search." size="sm" />
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
      height="50vh"
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
  inline,
  cursor,
  onCursor,
  onOpen,
}: {
  rows: SupplierReconRow[];
  loading: boolean;
  error: unknown;
  hasRun: boolean;
  source: 'gstr2b' | 'gstr2a';
  /** The graph's bars sit in the Difference cells (a short table, SPEC-21 D26). */
  inline: boolean;
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
      {
        key: 'taxDifference',
        header: 'Difference',
        kind: 'amount',
        width: 110,
        render: (r) => signedMoney(r.taxDifference),
        sortable: true,
        ...(inline ? { bar: { value: (r: SupplierReconRow) => Math.abs(r.taxDifference), slot: 1 as const } } : {}),
      },
    ],
    [source, inline],
  );
  if (error) {
    return (
      <Banner tone="danger" title="The supplier summary could not be loaded">
        {userMessage(error)}
      </Banner>
    );
  }
  if (!loading && !hasRun) {
    return <EmptyState title="Reconcile first" body="Import the GSTR-2B (Alt+O) and reconcile (Alt+R) on the GSTR-2B view; the supplier-wise picture appears here." />;
  }
  return (
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
      empty={<EmptyState title="No suppliers" body="Neither the portal file nor your books have documents for this period." size="sm" />}
      density="compact"
    />
  );
}

// ───────────────────────────── Imported files ─────────────────────────────

function ImportsTab({
  batches,
  loading,
  error,
  cursor,
  onCursor,
  onOpen,
}: {
  batches: ImportBatchView[];
  loading: boolean;
  error: unknown;
  cursor: string | null;
  onCursor: (id: string | null) => void;
  onOpen: (b: ImportBatchView) => void;
}) {
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
  // Delete import (Alt+D) is a screen action, under More ▾.
  return (
    <DataTable
      aria-label="Imported files"
      autoFocus
      hideEmptyColumns
      columns={columns}
      rows={batches}
      getRowKey={(b) => String(b.id)}
      loading={loading}
      selectedKey={cursor}
      onSelect={(k) => onCursor(k)}
      onRowActivate={onOpen}
      empty={<EmptyState title="No files imported yet" body="Import a GSTR-2B, GSTR-2A or GSTR-1 file from its view (Alt+O)." size="sm" />}
      density="compact"
    />
  );
}

/**
 * 'security.audit' — the Edit Log (audit trail). Params: { entityType?, entityId?, entityGuid?,
 * label?, userId? }.
 *
 * - Without a record: every entry, newest first, filtered by period (Alt+F2) or all dates, user,
 *   action, record type and a search; Enter opens the entry in a drawer with the field-level diff
 *   (before → after), raw data and its fingerprint.
 * - With { entityType, entityId }: the record's history — every version, oldest change at the
 *   bottom, each with its own diff.
 * - Verify (Alt+V) recomputes the hash chain and shows a prominent result banner; Export (Alt+E)
 *   writes Excel/CSV through the server (formula-safe) and the native save dialog.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuditListRow, AuditExportInput, AuditHistoryVersion, AuditVerifyReport, JsonValue } from '../../../shared/types/security.ts';
import { todayLocal } from '../../../shared/dates.ts';
import {
  api,
  native,
  printReport,
  Screen,
  showInFolder,
  useApiMutation,
  useApiQuery,
  useCan,
  useCompany,
  useNav,
  usePeriod,
  useScreenActions,
  userMessage,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Icon,
  Inline,
  KeyValueList,
  Modal,
  Pagination,
  Panel,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  TextInput,
  useDebouncedValue,
  useEnterAdvance,
  useHotkeys,
  useRovingFocus,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { ActionBadge, DiffTable, Fingerprint } from './components.tsx';
import { useNow } from './hooks.ts';
import {
  ACTION_GROUPS,
  actionLabel,
  actionOptions,
  adjacentId,
  ANY,
  DEFAULT_FILTERS,
  entityTypeOptions,
  exportFallbackName,
  filterSummary,
  formatCount,
  hasFilters,
  historyExportInput,
  historyTarget,
  initialFilters,
  PAGE_SIZES,
  printRows,
  toExportInput,
  toListInput,
  userOptions,
  verifyTone,
  withGroup,
} from './lib/auditQuery.ts';
import type { ActionGroup, AuditFilterState, AuditScreenParams, HistoryTarget } from './lib/auditQuery.ts';
import { diffSummary } from './lib/diffFormat.ts';
import { formatDateTime, relativeTime } from './lib/time.ts';

type Params = AuditScreenParams & { userId?: number };

export function AuditScreen({ params }: ScreenProps<Params>) {
  const target = useMemo(() => historyTarget(params), [params]);
  return target ? <HistoryView target={target} /> : <EditLogView params={params} />;
}

// ───────────────────────────── Shared: verify & export ─────────────────────────────

function useVerify() {
  const toast = useToast();
  const [report, setReport] = useState<AuditVerifyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setReport(await api('security.audit.verify', {}));
    } catch (err) {
      toast.error('Could not verify the edit log', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return { report, busy, run, clear: () => setReport(null) };
}

const SAVE_FILTERS = {
  xlsx: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  csv: [{ name: 'CSV (comma separated)', extensions: ['csv'] }],
};

/** Server-side export (formula-safe, itself recorded in the edit log) + native save dialog. */
function useAuditExport() {
  const toast = useToast();
  const canExport = useCan('data.export');
  const exp = useApiMutation('security.audit.export', { invalidates: ['security.audit'] });
  const run = async (input: AuditExportInput) => {
    if (exp.pending) return;
    try {
      const out = await exp.mutate(input);
      if (out.rowCount === 0) {
        toast.info('Nothing to export', { message: 'No edit-log entry matches the current filters.' });
        return;
      }
      const saved = await native('dialog.saveFile', {
        title: 'Export edit log',
        defaultName: out.fileName || exportFallbackName(input.format, todayLocal()),
        filters: SAVE_FILTERS[input.format],
        data: out.bytes,
      });
      if (!saved) return;
      const name = saved.path.split(/[\\/]/).pop() ?? saved.path;
      toast.success(`Saved ${name}`, {
        message: `${formatCount(out.rowCount)} entr${out.rowCount === 1 ? 'y' : 'ies'}. The export itself is recorded in the edit log.`,
        action: { label: 'Show in folder', onClick: () => showInFolder(saved.path) },
      });
    } catch (err) {
      toast.error('Could not export the edit log', { message: userMessage(err) });
    }
  };
  return { canExport, pending: exp.pending, run };
}

/** Alt+E: Excel or CSV (press X or C). */
function ExportFormatDialog({ onPick, onClose }: { onPick: (f: 'xlsx' | 'csv') => void; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Export Edit Log"
      description="Exports every entry that matches the filters (not just this page). You'll choose where to save it next."
      size="sm"
      footer={<Button onClick={onClose}>Cancel</Button>}
    >
      <FormatKeys onPick={onPick} />
      <Stack gap={2}>
        <Button icon="grid" fullWidth data-autofocus="" onClick={() => onPick('xlsx')} shortcut="X">
          Excel workbook (.xlsx)
        </Button>
        <Button icon="file" fullWidth onClick={() => onPick('csv')} shortcut="C">
          CSV file (.csv)
        </Button>
      </Stack>
    </Modal>
  );
}

function FormatKeys({ onPick }: { onPick: (f: 'xlsx' | 'csv') => void }) {
  useHotkeys({ x: () => onPick('xlsx'), c: () => onPick('csv') });
  return null;
}

/** The prominent result of "Verify edit log". */
function VerifyResult({ report, onDismiss, onShowEntry }: { report: AuditVerifyReport; onDismiss: () => void; onShowEntry: (id: number) => void }) {
  const tone = verifyTone(report);
  if (tone === 'danger') {
    return (
      <Banner
        tone="danger"
        className="bx-sec-verify bx-sec-verify--broken"
        title={`Tampering alert — ${report.message}`}
        onDismiss={onDismiss}
        action={
          report.brokenAtId !== null ? (
            <Button size="sm" variant="danger" icon="eye" onClick={() => onShowEntry(report.brokenAtId as number)}>
              Show entry #{report.brokenAtId}
            </Button>
          ) : undefined
        }
      >
        <Stack gap={1}>
          <span>{report.detail}</span>
          <span className="bx-muted">
            {formatCount(report.count)} of {formatCount(report.totalEntries)} entries were intact before the break
            {report.brokenAtId !== null ? ` (the problem is at entry #${report.brokenAtId})` : ''}. Checked {formatDateTime(report.checkedAt, true)}.
          </span>
        </Stack>
      </Banner>
    );
  }
  return (
    <Banner
      tone={tone}
      className="bx-sec-verify"
      title={tone === 'info' ? report.message : `Edit log intact ✓ — ${formatCount(report.count)} entr${report.count === 1 ? 'y' : 'ies'} verified`}
      onDismiss={onDismiss}
    >
      <Stack gap={2}>
        <span>{report.detail}</span>
        {report.lastHash ? (
          <span className="bx-sec-verify__hash">
            <span>Latest fingerprint (entry #{report.lastEntryId ?? '—'}) — note it down or keep the export, so removal of the newest entries can be noticed later:</span>
            <Fingerprint hash={report.lastHash} label="latest fingerprint" />
          </span>
        ) : null}
        <span className="bx-muted">Checked {formatDateTime(report.checkedAt, true)}.</span>
      </Stack>
    </Banner>
  );
}

// ───────────────────────────── Edit log list ─────────────────────────────

function EditLogView({ params }: { params: Params }) {
  const nav = useNav();
  const company = useCompany();
  const toast = useToast();
  const now = useNow();
  const period = usePeriod();
  const [filters, setFilters] = useState<AuditFilterState>(() => initialFilters(params));
  const debouncedSearch = useDebouncedValue(filters.search, 250);
  const effective = useMemo(() => ({ ...filters, search: debouncedSearch }), [filters, debouncedSearch]);
  const input = useMemo(() => toListInput(effective, { from: period.from, to: period.to }), [effective, period.from, period.to]);
  const facets = useApiQuery('security.audit.facets', {}, { staleTime: 60_000 });
  const list = useApiQuery('security.audit.list', input, { keepPrevious: true });
  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const total = list.data?.total ?? 0;
  const [cursor, setCursor] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const verify = useVerify();
  const exporter = useAuditExport();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);
  // The list, not the first filter, gets the initial focus (the shell focuses [data-autofocus] first),
  // so ↑/↓ and Enter work as soon as the Edit Log opens.
  const setGrid = useCallback((el: HTMLTableElement | null) => {
    gridRef.current = el;
    el?.setAttribute('data-autofocus', '');
  }, []);
  // Enter moves through the filters (Tally style); Enter on the last one goes to the list.
  const filterRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => gridRef.current?.focus() });
  const selected = rows.find((r) => String(r.id) === cursor) ?? null;

  const users = useMemo(() => userOptions(facets.data, filters.userId), [facets.data, filters.userId]);
  const types = useMemo(() => entityTypeOptions(facets.data, filters.entityType), [facets.data, filters.entityType]);
  const actions = useMemo(() => actionOptions(facets.data, filters.group), [facets.data, filters.group]);
  const filtered = hasFilters(filters);
  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));

  // A new filter shows page 1; keep the page inside range when the total shrinks.
  const update = (patch: Partial<AuditFilterState>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  useEffect(() => {
    if (list.data && filters.page > pageCount) setFilters((f) => ({ ...f, page: pageCount }));
  }, [list.data, filters.page, pageCount]);

  const userLabel = users.find((u) => u.value === String(filters.userId))?.label;
  const typeLabel = facets.data?.entityTypes.find((t) => t.value === filters.entityType)?.label;
  const summary = filterSummary(filters, { periodLabel: period.label, userLabel, entityTypeLabel: typeLabel });

  const openHistory = (r: Pick<AuditListRow, 'entityType' | 'entityId' | 'entityGuid' | 'entityLabel'>) => {
    if (!r.entityType || r.entityId === null) return;
    setDetailId(null);
    nav.push('security.audit', { entityType: r.entityType, entityId: r.entityId, entityGuid: r.entityGuid ?? undefined, label: r.entityLabel ?? undefined });
  };

  const print = async () => {
    if (rows.length === 0) return;
    const first = (filters.page - 1) * filters.pageSize + 1;
    try {
      await printReport({
        title: 'Edit Log',
        subtitle: `${summary} · entries ${formatCount(first)}–${formatCount(first + rows.length - 1)} of ${formatCount(total)}`,
        company: company?.name,
        columns: [{ header: 'When', width: 120 }, { header: 'User', width: 90 }, { header: 'Action', width: 90 }, { header: 'Record type', width: 110 }, { header: 'Record' }, { header: 'What changed' }],
        rows: printRows(rows, (ts) => formatDateTime(ts)),
        landscape: true,
      });
    } catch (err) {
      toast.error('Could not print', { message: userMessage(err) });
    }
  };

  const hasRecord = !!selected?.entityType && selected.entityId !== null;
  useScreenActions([
    { key: 'Alt+V', label: verify.busy ? 'Verifying…' : 'Verify edit log', icon: 'shield', primary: true, onClick: () => void verify.run(), disabled: verify.busy, hint: 'Check that no entry was changed, inserted or removed.' },
    { key: 'Alt+H', label: 'Record history', icon: 'clock', onClick: () => selected && openHistory(selected), disabled: !hasRecord, hint: 'Every change to the selected record.' },
    { key: 'Alt+F', label: 'Search', icon: 'search', onClick: () => searchRef.current?.focus(), group: 'filter' },
    { key: 'Alt+X', label: 'Clear filters', icon: 'filter', onClick: () => setFilters({ ...DEFAULT_FILTERS, pageSize: filters.pageSize }), disabled: !filtered && filters.dates === DEFAULT_FILTERS.dates, group: 'filter' },
    { key: 'Ctrl+PageUp', label: 'Previous page', icon: 'chevron-left', onClick: () => update({ page: filters.page - 1 }), disabled: filters.page <= 1, group: 'page' },
    { key: 'Ctrl+PageDown', label: 'Next page', icon: 'chevron-right', onClick: () => update({ page: filters.page + 1 }), disabled: filters.page >= pageCount, group: 'page' },
    {
      key: 'Alt+E',
      label: 'Export',
      icon: 'export',
      onClick: () => setExportOpen(true),
      disabled: !exporter.canExport || exporter.pending,
      hint: exporter.canExport ? 'Excel or CSV of every matching entry.' : 'You need the “Export data” permission.',
      group: 'output',
    },
    { key: 'Alt+P', label: 'Print', icon: 'print', onClick: () => void print(), disabled: rows.length === 0, hint: 'Prints the entries on this page.', group: 'output' },
  ]);

  const columns = useMemo<Column<AuditListRow>[]>(
    () => [
      {
        key: 'ts',
        header: 'When',
        width: 150,
        sortable: true,
        value: (r) => formatDateTime(r.ts),
        sortValue: (r) => r.ts,
        title: (r) => `${formatDateTime(r.ts, true)} (${relativeTime(r.ts, now)})`,
      },
      { key: 'username', header: 'User', width: 120, sortable: true, value: (r) => r.username ?? '—' },
      { key: 'action', header: 'Action', width: 140, sortable: true, value: (r) => actionLabel(r.action), render: (r) => <ActionBadge action={r.action} /> },
      { key: 'entityTypeLabel', header: 'Record type', width: 140, sortable: true },
      {
        key: 'entityLabel',
        header: 'Record',
        minWidth: 160,
        sortable: true,
        value: (r) => r.entityLabel ?? (r.entityId !== null ? `#${r.entityId}` : ''),
      },
      { key: 'summary', header: 'What changed', minWidth: 240, title: (r) => r.summary },
    ],
    [now],
  );

  const emptyBody = filtered
    ? 'No entry matches these filters. Press Alt+X to clear them.'
    : filters.dates === 'period'
      ? `Nothing was recorded in ${period.label}. Change the period (Alt+F2) or show all dates.`
      : 'Nothing has been recorded yet. Every change, login and export will appear here.';

  return (
    <Screen
      title="Edit Log"
      subtitle="Who changed what, and when. Entries cannot be edited or deleted."
      icon="book"
      hint="Enter Open entry · Alt+H Record history · Alt+V Verify · Alt+F Search · Alt+E Export · Alt+P Print · Ctrl+PgUp/PgDn Page"
      meta={
        facets.data?.firstTs ? (
          <span className="bx-muted">
            Since {formatDateTime(facets.data.firstTs)} · last entry {relativeTime(facets.data.lastTs, now)}
          </span>
        ) : undefined
      }
    >
      <div className="bx-sec-audit">
        {verify.report ? <VerifyResult report={verify.report} onDismiss={verify.clear} onShowEntry={(id) => setDetailId(id)} /> : null}

        <div ref={filterRef} className="bx-sec-filters" role="search" aria-label="Filter the edit log">
          <Field label="Dates">
            <SegmentedControl<'period' | 'all'>
              aria-label="Dates"
              value={filters.dates}
              onChange={(v) => update({ dates: v })}
              options={[
                { value: 'period', label: period.label },
                { value: 'all', label: 'All dates' },
              ]}
            />
          </Field>
          <div className="bx-sec-filters__select">
            <Field label="User">
              <Select value={filters.userId === null ? ANY : String(filters.userId)} onChange={(v) => update({ userId: v === ANY ? null : Number(v) })} options={users} />
            </Field>
          </div>
          <Field label="Action">
            <SegmentedControl<ActionGroup> aria-label="Kind of action" value={filters.group} onChange={(g) => setFilters((f) => withGroup(f, g))} options={ACTION_GROUPS.map((g) => ({ value: g.value, label: g.label }))} />
          </Field>
          <div className="bx-sec-filters__select">
            <Field label="Exactly">
              <Select value={filters.action ?? ANY} onChange={(v) => update({ action: v === ANY ? null : (v as AuditFilterState['action']) })} options={actions} />
            </Field>
          </div>
          <div className="bx-sec-filters__select">
            <Field label="Record type">
              <Select value={filters.entityType ?? ANY} onChange={(v) => update({ entityType: v === ANY ? null : v })} options={types} />
            </Field>
          </div>
          <div className="bx-sec-filters__search">
            <Field label="Search" hint="Record name, user, record type or action.">
              <TextInput ref={searchRef} value={filters.search} onChange={(e) => update({ search: e.target.value })} leadingIcon="search" placeholder="e.g. Sharma, ledger, ravi" aria-keyshortcuts="Alt+F" />
            </Field>
          </div>
        </div>

        {list.error ? (
          <Banner tone="danger" title="The edit log could not be loaded" action={<Button size="sm" onClick={() => void list.refetch()}>Try again</Button>}>
            {userMessage(list.error)}
          </Banner>
        ) : null}

        <div className="bx-sec-table">
          <DataTable<AuditListRow>
            aria-label={`Edit log — ${summary}`}
            autoFocus
            gridRef={setGrid}
            columns={columns}
            rows={rows}
            getRowKey={(r) => String(r.id)}
            selectedKey={cursor}
            onSelect={(k) => setCursor(k)}
            onRowActivate={(r) => setDetailId(r.id)}
            loading={list.loading}
            virtualize="auto"
            height="max(320px, calc(100vh - 420px))"
            getRowClassName={(r) => (r.action === 'login_failed' || r.action === 'delete' ? 'bx-sec-row--attention' : undefined)}
            empty={<EmptyState icon="book" title={filtered ? 'No matching entries' : 'No entries'} body={emptyBody} />}
          />
        </div>

        <div className="bx-sec-audit__footer">
          <span className="bx-muted" aria-live="polite">
            {list.refreshing ? 'Updating…' : total > 0 ? `${formatCount(total)} entr${total === 1 ? 'y' : 'ies'} · ${summary}` : summary}
          </span>
          {total > 0 ? (
            <Pagination
              page={filters.page}
              pageSize={filters.pageSize}
              total={total}
              onPageChange={(p) => update({ page: p })}
              pageSizeOptions={PAGE_SIZES}
              onPageSizeChange={(s) => update({ pageSize: s })}
              itemLabel="entries"
            />
          ) : null}
        </div>
      </div>

      {detailId !== null ? (
        <EntryDrawer
          id={detailId}
          prevId={adjacentId(rows, detailId, -1)}
          nextId={adjacentId(rows, detailId, 1)}
          onNavigate={(id) => {
            setDetailId(id);
            setCursor(String(id));
          }}
          onClose={() => setDetailId(null)}
          onHistory={openHistory}
        />
      ) : null}
      {exportOpen ? (
        <ExportFormatDialog
          onClose={() => setExportOpen(false)}
          onPick={(f) => {
            setExportOpen(false);
            void exporter.run(toExportInput(effective, { from: period.from, to: period.to }, f));
          }}
        />
      ) : null}
    </Screen>
  );
}

// ───────────────────────────── Entry detail drawer ─────────────────────────────

function EntryDrawer({
  id,
  prevId,
  nextId,
  onNavigate,
  onClose,
  onHistory,
}: {
  id: number;
  prevId: number | null;
  nextId: number | null;
  onNavigate: (id: number) => void;
  onClose: () => void;
  onHistory?: (r: Pick<AuditListRow, 'entityType' | 'entityId' | 'entityGuid' | 'entityLabel'>) => void;
}) {
  const q = useApiQuery('security.audit.get', { id }, { staleTime: 300_000 });
  const d = q.data && q.data.id === id ? q.data : null;
  const hasRecord = !!d?.entityType && d.entityId !== null;
  // Newer entries are above in the list (newest first): ↑ = newer.
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={d ? `Entry #${d.id} — ${actionLabel(d.action)}` : `Entry #${id}`}
      description={d ? `${d.entityTypeLabel}${d.entityLabel ? ` · ${d.entityLabel}` : ''}` : undefined}
      footer={
        <Inline gap={2} justify="between">
          <Inline gap={2}>
            <Button icon="arrow-up" disabled={prevId === null} onClick={() => prevId !== null && onNavigate(prevId)} shortcut="Alt+Up">
              Newer
            </Button>
            <Button icon="arrow-down" disabled={nextId === null} onClick={() => nextId !== null && onNavigate(nextId)} shortcut="Alt+Down">
              Older
            </Button>
          </Inline>
          <Inline gap={2}>
            {onHistory && hasRecord && d ? (
              <Button icon="clock" onClick={() => onHistory(d)} shortcut="Alt+H">
                Record history
              </Button>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </Inline>
        </Inline>
      }
    >
      <DrawerKeys
        onPrev={prevId !== null ? () => onNavigate(prevId) : undefined}
        onNext={nextId !== null ? () => onNavigate(nextId) : undefined}
        onHistory={onHistory && hasRecord && d ? () => onHistory(d) : undefined}
      />
      {q.error ? (
        <Banner tone="danger" title="This entry could not be loaded" action={<Button size="sm" onClick={() => void q.refetch()}>Try again</Button>}>
          {userMessage(q.error)}
        </Banner>
      ) : !d ? (
        <Stack gap={3} aria-busy="true">
          <Skeleton lines={4} />
          <Skeleton variant="rect" height={160} />
        </Stack>
      ) : (
        <Stack gap={4}>
          <KeyValueList
            layout="inline"
            labelWidth={130}
            items={[
              { key: 'when', label: 'When', value: formatDateTime(d.ts, true) },
              { key: 'user', label: 'User', value: d.username ?? '—' },
              { key: 'action', label: 'Action', value: <ActionBadge action={d.action} /> },
              { key: 'type', label: 'Record type', value: d.entityTypeLabel },
              { key: 'record', label: 'Record', value: d.entityLabel ?? (d.entityId !== null ? `#${d.entityId}` : '—') },
              { key: 'summary', label: 'Summary', value: d.summary },
            ]}
          />
          <section aria-label="Field changes">
            <Inline gap={2} align="center" className="bx-sec-section-head">
              <h3 className="bx-sec-h3">Changes</h3>
              <span className="bx-muted">{diffSummary(d.changes, d.changesTruncated).text}</span>
            </Inline>
            <DiffLegend />
            <DiffTable changes={d.changes} truncated={d.changesTruncated} caption={`Changes in entry ${d.id}`} />
          </section>
          <Panel title="Raw data" headingLevel={3} collapsible defaultCollapsed description="Exactly what was stored, as JSON.">
            <Stack gap={3}>
              <RawJson label="Before" value={d.before} />
              <RawJson label="After" value={d.after} />
            </Stack>
          </Panel>
          <Panel title="Fingerprint" headingLevel={3} collapsible defaultCollapsed description="Each entry's fingerprint includes the one before it, so any later change breaks the chain (Verify, Alt+V).">
            <KeyValueList
              layout="inline"
              labelWidth={130}
              items={[
                { key: 'hash', label: 'This entry', value: <Fingerprint hash={d.hash} label="fingerprint" /> },
                { key: 'prev', label: 'Previous entry', value: <Fingerprint hash={d.prevHash} label="previous fingerprint" /> },
                ...(d.entityGuid ? [{ key: 'guid', label: 'Record id', value: <span className="bx-sec-hash">{d.entityGuid}</span> }] : []),
              ]}
            />
          </Panel>
        </Stack>
      )}
    </Drawer>
  );
}

function DrawerKeys({ onPrev, onNext, onHistory }: { onPrev?: () => void; onNext?: () => void; onHistory?: () => void }) {
  useHotkeys({ 'Alt+Up': onPrev, 'Alt+Down': onNext, 'Alt+H': onHistory }, [onPrev, onNext, onHistory]);
  return null;
}

function DiffLegend() {
  return (
    <p className="bx-sec-legend">
      <span>
        <del className="bx-sec-legend__del">removed / old</del>
      </span>
      <Icon name="arrow-right" size="xs" />
      <span>
        <ins className="bx-sec-legend__ins">added / new</ins>
      </span>
    </p>
  );
}

function RawJson({ label, value }: { label: string; value: JsonValue | null }) {
  const text = value === null ? '(nothing)' : JSON.stringify(value, null, 2);
  return (
    <div>
      <div className="bx-sec-setting__label">{label}</div>
      <pre className="bx-sec-raw" tabIndex={0} aria-label={`${label} — raw data`}>
        {text}
      </pre>
    </div>
  );
}

// ───────────────────────────── Record history ─────────────────────────────

function HistoryView({ target }: { target: HistoryTarget }) {
  const nav = useNav();
  const now = useNow();
  const q = useApiQuery('security.audit.entityHistory', { entityType: target.entityType, entityId: target.entityId, entityGuid: target.entityGuid }, { keepPrevious: true });
  const verify = useVerify();
  const exporter = useAuditExport();
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const data = q.data;
  const versions = useMemo<AuditHistoryVersion[]>(() => {
    const v = data?.versions ?? [];
    return order === 'newest' ? [...v].reverse() : v;
  }, [data, order]);
  const label = data?.currentLabel ?? target.label ?? `#${target.entityId}`;
  const typeLabel = data?.entityTypeLabel ?? target.entityType;

  useScreenActions([
    { key: 'Alt+V', label: verify.busy ? 'Verifying…' : 'Verify edit log', icon: 'shield', onClick: () => void verify.run(), disabled: verify.busy },
    { key: 'Alt+O', label: order === 'newest' ? 'Oldest first' : 'Newest first', icon: 'sort', onClick: () => setOrder((o) => (o === 'newest' ? 'oldest' : 'newest')), group: 'view' },
    { key: 'Alt+L', label: 'Full edit log', icon: 'book', onClick: () => nav.push('security.audit', { entityType: target.entityType }), group: 'view', hint: `All ${typeLabel.toLowerCase()} entries.` },
    {
      key: 'Alt+E',
      label: 'Export',
      icon: 'export',
      onClick: () => setExportOpen(true),
      disabled: !exporter.canExport || exporter.pending || versions.length === 0,
      hint: exporter.canExport ? 'Excel or CSV of this record’s history.' : 'You need the “Export data” permission.',
      group: 'output',
    },
  ]);

  return (
    <Screen
      title={`History — ${label}`}
      subtitle={`${typeLabel} · every recorded version${data ? ` (${data.versions.length})` : ''}. Changes cannot be edited or deleted.`}
      icon="clock"
      width="form"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="↑/↓ Move · Enter Open entry · Alt+O Order · Alt+L Full edit log · Alt+V Verify · Alt+E Export · Esc Back"
    >
      <Stack gap={4}>
        {verify.report ? <VerifyResult report={verify.report} onDismiss={verify.clear} onShowEntry={(id) => setDetailId(id)} /> : null}
        {data?.truncated ? (
          <Banner tone="info" inline title="Long history">
            Only the most recent {data.versions.length} versions are shown. Export the edit log for the complete record.
          </Banner>
        ) : null}
        {versions.length === 0 ? (
          <EmptyState icon="clock" title="No changes recorded for this record" body="Changes made from now on will appear here." />
        ) : (
          <Timeline versions={versions} now={now} onOpen={(id) => setDetailId(id)} />
        )}
      </Stack>
      {detailId !== null ? (
        <EntryDrawer
          id={detailId}
          prevId={adjacentId(versions, detailId, order === 'newest' ? -1 : 1)}
          nextId={adjacentId(versions, detailId, order === 'newest' ? 1 : -1)}
          onNavigate={setDetailId}
          onClose={() => setDetailId(null)}
        />
      ) : null}
      {exportOpen ? (
        <ExportFormatDialog
          onClose={() => setExportOpen(false)}
          onPick={(f) => {
            setExportOpen(false);
            void exporter.run(historyExportInput(target, f));
          }}
        />
      ) : null}
    </Screen>
  );
}

function Timeline({ versions, now, onOpen }: { versions: readonly AuditHistoryVersion[]; now: Date; onOpen: (id: number) => void }) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: false });
  return (
    <ol ref={listRef} className="bx-sec-timeline" aria-label="Versions" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
      {versions.map((v, i) => (
        <li key={v.id} className={`bx-sec-timeline__item bx-sec-timeline__item--${v.action}`}>
          <span className="bx-sec-timeline__dot" aria-hidden="true" />
          <article
            className="bx-sec-timeline__card"
            tabIndex={i === 0 ? 0 : -1}
            data-roving-item=""
            data-autofocus={i === 0 ? '' : undefined}
            aria-label={`${actionLabel(v.action)} ${formatDateTime(v.ts)} by ${v.username ?? 'unknown'}: ${v.summary}`}
            aria-description="Press Enter for the full entry."
            onKeyDown={(e) => {
              // Only the card itself (not a control inside it, e.g. a collapsible panel) opens the entry.
              if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && e.target === e.currentTarget) {
                e.preventDefault();
                onOpen(v.id);
              }
            }}
            onDoubleClick={() => onOpen(v.id)}
          >
            <div className="bx-sec-timeline__head">
              <ActionBadge action={v.action} />
              <span className="bx-sec-timeline__when" title={formatDateTime(v.ts, true)}>
                {formatDateTime(v.ts)} · {relativeTime(v.ts, now)}
              </span>
              <span>
                by <strong>{v.username ?? 'unknown'}</strong>
              </span>
              <Badge size="sm" tone="neutral">
                #{v.id}
              </Badge>
            </div>
            <VersionBody version={v} />
          </article>
        </li>
      ))}
    </ol>
  );
}

function VersionBody({ version: v }: { version: AuditHistoryVersion }): ReactNode {
  if (v.action === 'create' && v.changes.length > 12) {
    return (
      <Panel title={`Created with ${v.changes.length} fields`} headingLevel={4} collapsible defaultCollapsed padded={false}>
        <DiffTable changes={v.changes} truncated={v.changesTruncated} caption={`Fields of entry ${v.id}`} />
      </Panel>
    );
  }
  if (v.changes.length === 0) return <p className="bx-muted">{v.summary}</p>;
  return (
    <Stack gap={2}>
      <span className="bx-muted">{diffSummary(v.changes, v.changesTruncated).text}</span>
      <DiffTable changes={v.changes} truncated={v.changesTruncated} caption={`Changes in entry ${v.id}`} />
    </Stack>
  );
}

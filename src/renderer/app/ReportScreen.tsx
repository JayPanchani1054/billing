/**
 * The report template (2.1, SPEC-21 D24, §4.1): ReportFrame with the title row (h1 · the period token —
 * click or Alt+F2 — · subtitle · one state word; the command bar sits in its actions slot), an optional
 * toolbar row (filters left, the stat right), the graph strip and the table. Export (Alt+E → Excel / CSV
 * / PDF) and Print (Alt+P) are title-row actions, never repeated in the page. Re-exported by Screen.tsx,
 * so `import { ReportScreen } from '../../app/Screen.tsx'` keeps working; this file imports the shared
 * helpers from screenParts.tsx only.
 *
 *   const spec = useMemo(() => (q.data ? registerChart(q.data) : null), [q.data]);
 *   <ReportScreen title="Sales Register" graph={reportGraph(spec)} exportDef={() => ({ columns, rows })} loading={q.loading} refreshing={q.refreshing}>
 *     <DataTable … />
 *   </ReportScreen>
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Checkbox, Drawer, Modal, ReportFrame, useHotkeys, useRovingFocus, useToast } from '../ui/index.ts';
import { EXPORT_PERMISSION, exportTable, printReport, savePdf, showInFolder } from './export.ts';
import type { ExportResult, TableExportDef } from './export.ts';
import { GraphStrip, useGraphsToggle } from './graphStrip.tsx';
import type { GraphKind, ReportGraph } from './graphStrip.tsx';
import { userMessage } from './lib/apiErrors.ts';
import { aboutItem, columnChoices, onColumnsRequest, toggleColumn } from './lib/moreItems.ts';
import type { ColumnsRequest, MoreItem } from './lib/moreItems.ts';
import { useOptionalScreen, useScreenActions, useScreenTitle, useStatusHint } from './nav.tsx';
import type { ScreenActionItem } from './nav.tsx';
import { ScreenError, ScreenSkeleton } from './screenParts.tsx';
import { useAppState } from './state.tsx';
import { usePeriod } from './working.tsx';
import type { Period } from './working.tsx';
import { formatDate } from '../../shared/dates.ts';

/** What a report hands to export/print (title, company and period are filled in for you). */
export type ReportExportDef = Omit<TableExportDef, 'title' | 'company' | 'period'> & Partial<Pick<TableExportDef, 'title' | 'period' | 'subtitle'>>;

export interface ReportScreenProps {
  title: string;
  /** Words of the title row's context run, after the period ("Ledger: HDFC Bank"). */
  subtitle?: ReactNode;
  /** Build the table for export/print on demand. Omit to hide Export/Print. */
  exportDef?: () => ReportExportDef;
  /** 'range' (default) shows the period (Alt+F2); 'asOn' shows "As on <to date>"; 'none' hides it. */
  periodMode?: 'range' | 'asOn' | 'none';
  /** Override the period (e.g. a drilled-down month). Default: the global period (usePeriod). */
  period?: Period;
  /** Toolbar row, left: view tabs, one search, one filter. */
  filters?: ReactNode;
  /** Toolbar row, right (before the stat): rare extra controls. */
  toolbar?: ReactNode;
  /** Extra screen actions (drill-down views, Alt+F1 detailed…) — the command bar and More ▾ show them. */
  actions?: readonly ScreenActionItem[];
  loading?: boolean;
  refreshing?: boolean;
  error?: unknown;
  onRetry?: () => void;
  footer?: ReactNode;
  hint?: string;
  /** 2.1: the report's graph — `reportGraph(spec)` (ui/lazyChart.tsx); null/absent = no strip, no toggle key. */
  graph?: ReportGraph | null;
  /** 2.1: the graph's class (the catalogue's): 'report' (default, shown) or 'detail' (drill-downs, folded). */
  graphKind?: GraphKind;
  /** 2.1: the answer in words on the toolbar row (a StatLine) — never a figure the table's total shows. */
  stat?: ReactNode;
  /** 2.1: notes, legal lines and footnotes — More ▾ › "About this report" opens them in a drawer. */
  about?: ReactNode;
  /** 2.1: the More item's and the drawer's name (default "About this report"; GST returns: "About this return"). */
  aboutLabel?: string;
  /** 2.1: replaces the period token in the context run (e.g. the Day Book's dates). */
  context?: ReactNode;
  /** 2.1: the context run's one state word ("Net loss ₹3,43,160.32"). */
  meta?: ReactNode;
  /** 2.1: Export and Print go to More ▾ (master lists); Alt+E / Alt+P stay. */
  outputInMore?: boolean;
  children?: ReactNode;
}

/** A screen action with the 2.1 fields (`demoted`, `checked`) — structurally a ScreenActionItem. */
type Action = ScreenActionItem & Pick<MoreItem, 'demoted' | 'checked'>;

/**
 * Standard report: ReportFrame with the title row, the toolbar row, the graph strip and the body.
 * Export and Print need the data.export permission (disabled with a hint otherwise; the core enforces
 * and logs it).
 */
export function ReportScreen({
  title,
  subtitle,
  exportDef,
  periodMode = 'range',
  period: periodOverride,
  filters,
  toolbar,
  actions,
  loading = false,
  refreshing = false,
  error,
  onRetry,
  footer,
  hint,
  graph = null,
  graphKind = 'report',
  stat,
  about,
  aboutLabel = 'About this report',
  context,
  meta,
  outputInMore = false,
  children,
}: ReportScreenProps) {
  const app = useAppState();
  const globalPeriod = usePeriod();
  const toast = useToast();
  // Excel, CSV, PDF and Print are all "export": the core checks data.export and logs each one.
  const canExport = app.can(EXPORT_PERMISSION);
  const period = periodOverride ?? globalPeriod.period;
  const [exportOpen, setExportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const companyName = app.company?.mailingName || app.company?.name || '';
  const graphs = useGraphsToggle(graphKind);
  const content = !loading && !error;
  const showGraph = content && graph !== null;

  const fullDef = (): TableExportDef | null => {
    if (!exportDef) return null;
    const d = exportDef();
    return {
      ...d,
      title: d.title ?? title,
      subtitle: d.subtitle ?? (typeof subtitle === 'string' ? subtitle : undefined),
      company: companyName,
      period: d.period ?? (periodMode === 'none' ? undefined : periodMode === 'asOn' ? `As on ${formatDate(period.to)}` : period),
    };
  };

  const announce = (r: ExportResult | null) => {
    if (!r) return;
    const name = r.path.split(/[\\/]/).pop() ?? r.path;
    toast.success(`Saved ${name}`, { action: { label: 'Show in folder', onClick: () => showInFolder(r.path) } });
  };

  const run = async (what: 'xlsx' | 'csv' | 'pdf' | 'print') => {
    const def = fullDef();
    if (!def || busy || !canExport) return;
    setBusy(true);
    try {
      if (what === 'print') await printReport(def);
      else if (what === 'pdf') announce(await savePdf(def));
      else announce(await exportTable(def, what));
    } catch (err) {
      toast.error(what === 'print' ? 'Could not print' : 'Could not export', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const canOutput = !!exportDef && !loading && !error && canExport;
  const noPermission = canExport ? undefined : EXPORT_DENIED_HINT;
  const railActions: Action[] = [
    ...(actions ?? []),
    ...(periodMode !== 'none' ? [{ key: 'Alt+F2', label: 'Period', icon: 'calendar' as const, onClick: () => globalPeriod.openDialog(), group: 'period' }] : []),
    { key: 'Alt+E', label: 'Export', icon: 'export', onClick: () => setExportOpen(true), disabled: !canOutput, hidden: !exportDef, group: 'output', hint: noPermission, demoted: outputInMore },
    { key: 'Alt+P', label: 'Print', icon: 'print', onClick: () => void run('print'), disabled: !canOutput, hidden: !exportDef, group: 'output', hint: noPermission, demoted: outputInMore },
    // The graphs toggle key only while the screen shows a graph (SPEC-21 §3.5).
    ...(showGraph && graphs.action ? [graphs.action] : []),
    ...(about ? [aboutItem(() => setAboutOpen(true), aboutLabel)] : []),
  ];
  useScreenTitle(title);
  useScreenActions(railActions);
  useStatusHint(hint ?? (canExport ? 'Enter Open · Alt+F2 Period · Alt+E Export · Alt+P Print · Esc Back' : 'Enter Open · Alt+F2 Period · Esc Back'));

  const periodNode = periodMode === 'none' ? undefined : periodMode === 'asOn' ? `As on ${formatDate(period.to, 'D-MMM-YY')}` : period;

  return (
    <>
      <ReportFrame
        title={title}
        subtitle={subtitle}
        companyName={companyName}
        period={periodNode}
        onPeriodClick={periodMode === 'none' || periodOverride ? undefined : () => globalPeriod.openDialog()}
        context={context}
        meta={meta}
        filters={filters}
        actions={toolbar}
        stat={content ? stat : undefined}
        graph={showGraph ? <GraphStrip graph={graph} kind={graphKind} /> : null}
        graphs={showGraph ? (graphs.shown ? 'on' : 'off') : undefined}
        refreshing={refreshing || busy}
        footer={footer}
      >
        {error ? <ScreenError error={error} onRetry={onRetry} /> : loading ? <ScreenSkeleton lines={10} /> : children}
      </ReportFrame>
      {exportOpen ? (
        <ExportDialog
          title={title}
          onClose={() => setExportOpen(false)}
          onPick={(f) => {
            setExportOpen(false);
            void run(f);
          }}
        />
      ) : null}
      {about ? (
        <Drawer open={aboutOpen} onClose={() => setAboutOpen(false)} title={aboutLabel} description={title} size="sm">
          <div className="bx-report__about">{about}</div>
        </Drawer>
      ) : null}
      <ColumnsHost />
    </>
  );
}

/**
 * The host of "Columns…" (app/lib/moreItems.ts `columnsItem`): opens the checklist while its screen is
 * on top of the stack (More ▾ lists the top screen's items only, so the request is always the top
 * screen's). Every ReportScreen renders one; a plain `Screen` whose actions include `columnsItem` renders
 * `<ColumnsHost />` too — without a host the item does nothing.
 */
export function ColumnsHost(): ReactNode {
  const isTop = useOptionalScreen()?.isTop ?? false;
  const [request, setRequest] = useState<ColumnsRequest | null>(null);
  useEffect(() => (isTop ? onColumnsRequest(setRequest) : undefined), [isTop]);
  return isTop && request ? <ColumnsDialog request={request} onClose={() => setRequest(null)} /> : null;
}

/** The column checklist: one checkbox per column; the first column (and the last one shown) cannot be hidden. */
function ColumnsDialog({ request, onClose }: { request: ColumnsRequest; onClose: () => void }) {
  const [hidden, setHidden] = useState<readonly string[]>(request.hidden);
  const choices = columnChoices(request.columns, hidden);
  // Focus starts on the first column that can be hidden (the first one never can).
  const first = choices.findIndex((c) => !c.locked);
  return (
    <Modal open onClose={onClose} title="Columns" size="sm">
      <div className="bx-export-choices" role="group" aria-label="Columns shown">
        {choices.map((c, i) => (
          <Checkbox
            key={c.key}
            label={c.label}
            checked={c.shown}
            disabled={c.locked}
            data-autofocus={i === first ? '' : undefined}
            onChange={() => {
              const next = toggleColumn(request.columns, hidden, c.key);
              setHidden(next);
              request.setHidden(next);
            }}
          />
        ))}
      </div>
    </Modal>
  );
}

const EXPORT_CHOICES: ReadonlyArray<{ id: 'xlsx' | 'csv' | 'pdf'; key: string; label: string; body: string }> = [
  { id: 'xlsx', key: 'X', label: 'Excel workbook (.xlsx)', body: 'Numbers stay numbers — ready to sort, filter and add up in Excel.' },
  { id: 'csv', key: 'C', label: 'CSV file (.csv)', body: 'Plain comma-separated text for other software or uploads.' },
  { id: 'pdf', key: 'P', label: 'PDF document (.pdf)', body: 'A print-ready A4 copy to share or email.' },
];

/** Alt+E: choose Excel / CSV / PDF (↑/↓ + Enter, or press X / C / P). One line each; the details are tooltips. */
export function ExportDialog({ title, onPick, onClose }: { title: string; onPick: (format: 'xlsx' | 'csv' | 'pdf') => void; onClose: () => void }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: true });
  return (
    <Modal open onClose={onClose} title={`Export ${title}`} size="sm">
      <ExportKeys onPick={onPick} />
      <div ref={listRef} className="bx-export-choices" role="group" aria-label="Export format" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {EXPORT_CHOICES.map((c, i) => (
          <button
            key={c.id}
            type="button"
            data-roving-item=""
            data-autofocus={i === 0 ? '' : undefined}
            className="bx-export-choice"
            onClick={() => onPick(c.id)}
            title={c.body}
            aria-keyshortcuts={c.key}
          >
            {c.label}
            <span className="bx-export-choice__key" aria-hidden="true">
              {c.key}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** Letter keys inside the dialog's own (blocking) hotkey scope. */
function ExportKeys({ onPick }: { onPick: (format: 'xlsx' | 'csv' | 'pdf') => void }) {
  useHotkeys({ x: () => onPick('xlsx'), c: () => onPick('csv'), p: () => onPick('pdf') });
  return null;
}

/** Why Export / Print are disabled for a user without the data.export permission. */
export const EXPORT_DENIED_HINT = 'Export and print need the Data › Export permission — ask the company owner.';

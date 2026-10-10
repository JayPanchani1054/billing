/**
 * The report template: ReportFrame with the period header (click or Alt+F2), Export (Alt+E → Excel /
 * CSV / PDF) and Print (Alt+P). Re-exported by Screen.tsx, so `import { ReportScreen } from
 * '../../app/Screen.tsx'` keeps working; this file imports the shared helpers from screenParts.tsx only.
 *
 *   <ReportScreen title="Trial Balance" exportDef={() => ({ columns, rows })} loading={q.loading} refreshing={q.refreshing}>
 *     <DataTable … />
 *   </ReportScreen>
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Icon, Kbd, Modal, ReportFrame, useHotkeys, useRovingFocus, useToast } from '../ui/index.ts';
import type { IconName } from '../ui/index.ts';
import { EXPORT_PERMISSION, exportTable, printReport, savePdf, showInFolder } from './export.ts';
import type { ExportResult, TableExportDef } from './export.ts';
import { userMessage } from './lib/apiErrors.ts';
import { useScreenActions, useScreenTitle, useStatusHint } from './nav.tsx';
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
  subtitle?: ReactNode;
  /** Build the table for export/print on demand. Omit to hide Export/Print. */
  exportDef?: () => ReportExportDef;
  /** 'range' (default) shows the period (Alt+F2); 'asOn' shows "As on <to date>"; 'none' hides it. */
  periodMode?: 'range' | 'asOn' | 'none';
  /** Override the period (e.g. a drilled-down month). Default: the global period (usePeriod). */
  period?: Period;
  /** Left toolbar slot (view toggles, filters). */
  filters?: ReactNode;
  /** Extra buttons in the right toolbar slot. */
  toolbar?: ReactNode;
  /** Extra rail actions (drill-down views, Alt+F5 detailed…). */
  actions?: readonly ScreenActionItem[];
  loading?: boolean;
  refreshing?: boolean;
  error?: unknown;
  onRetry?: () => void;
  footer?: ReactNode;
  hint?: string;
  children?: ReactNode;
}

/**
 * Standard report: ReportFrame with company + period header (click or Alt+F2 to change), Export
 * (Alt+E → Excel / CSV / PDF) and Print (Alt+P) wired to the export helpers. Export and Print need
 * the data.export permission (disabled with a hint otherwise; the core enforces and logs it).
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
  children,
}: ReportScreenProps) {
  const app = useAppState();
  const globalPeriod = usePeriod();
  const toast = useToast();
  // Excel, CSV, PDF and Print are all "export": the core checks data.export and logs each one.
  const canExport = app.can(EXPORT_PERMISSION);
  const period = periodOverride ?? globalPeriod.period;
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const companyName = app.company?.mailingName || app.company?.name || '';

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
  const railActions: ScreenActionItem[] = [
    ...(actions ?? []),
    ...(periodMode !== 'none' ? [{ key: 'Alt+F2', label: 'Period', icon: 'calendar' as const, onClick: () => globalPeriod.openDialog(), group: 'period' }] : []),
    { key: 'Alt+E', label: 'Export', icon: 'export', onClick: () => setExportOpen(true), disabled: !canOutput, hidden: !exportDef, group: 'output', hint: noPermission },
    { key: 'Alt+P', label: 'Print', icon: 'print', onClick: () => void run('print'), disabled: !canOutput, hidden: !exportDef, group: 'output', hint: noPermission },
  ];
  useScreenTitle(title);
  useScreenActions(railActions);
  useStatusHint(hint ?? (canExport ? 'Enter Open · Alt+F2 Period · Alt+E Export · Alt+P Print · Esc Back' : 'Enter Open · Alt+F2 Period · Esc Back'));

  const periodNode =
    periodMode === 'none' ? undefined : periodMode === 'asOn' ? <>As on {formatDate(period.to, 'D-MMM-YY')}</> : period;

  return (
    <>
      <ReportFrame
        title={title}
        subtitle={subtitle}
        companyName={companyName}
        period={periodNode}
        onPeriodClick={periodMode === 'none' || periodOverride ? undefined : () => globalPeriod.openDialog()}
        filters={filters}
        refreshing={refreshing || busy}
        actions={
          <>
            {toolbar}
            {exportDef ? (
              <>
                <Button icon="export" shortcut="Alt+E" disabled={!canOutput} title={noPermission} onClick={() => setExportOpen(true)}>
                  Export
                </Button>
                <Button icon="print" shortcut="Alt+P" disabled={!canOutput} title={noPermission} onClick={() => void run('print')}>
                  Print
                </Button>
              </>
            ) : null}
          </>
        }
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
    </>
  );
}

const EXPORT_CHOICES: ReadonlyArray<{ id: 'xlsx' | 'csv' | 'pdf'; key: string; label: string; body: string; icon: IconName }> = [
  { id: 'xlsx', key: 'X', label: 'Excel workbook (.xlsx)', body: 'Numbers stay numbers — ready to sort, filter and add up in Excel.', icon: 'grid' },
  { id: 'csv', key: 'C', label: 'CSV file (.csv)', body: 'Plain comma-separated text for other software or uploads.', icon: 'file' },
  { id: 'pdf', key: 'P', label: 'PDF document (.pdf)', body: 'A print-ready A4 copy to share or email.', icon: 'invoice' },
];

/** Alt+E: choose Excel / CSV / PDF (↑/↓ + Enter, or press X / C / P). */
export function ExportDialog({ title, onPick, onClose }: { title: string; onPick: (format: 'xlsx' | 'csv' | 'pdf') => void; onClose: () => void }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: true });
  return (
    <Modal open onClose={onClose} title={`Export ${title}`} description="Choose a format. You'll pick where to save it next." size="sm">
      <ExportKeys onPick={onPick} />
      <div ref={listRef} className="bx-export-choices" role="group" aria-label="Export format" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {EXPORT_CHOICES.map((c, i) => (
          <button key={c.id} type="button" data-roving-item="" data-autofocus={i === 0 ? '' : undefined} className="bx-export-choice" onClick={() => onPick(c.id)} aria-keyshortcuts={c.key}>
            <Icon name={c.icon} size="lg" className="bx-export-choice__icon" />
            <span className="bx-export-choice__text">
              <span className="bx-export-choice__label">{c.label}</span>
              <span className="bx-export-choice__body">{c.body}</span>
            </span>
            <Kbd size="sm" tone="subtle">
              {c.key}
            </Kbd>
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

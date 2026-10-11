/**
 * Screen layout patterns for feature modules.
 *
 *   <Screen title="Ledger Creation" actions={[{ key: 'Ctrl+A', label: 'Accept', onClick: save, primary: true }]} width="form" dirty={dirty}>
 *     …form…
 *   </Screen>
 *
 *   <ReportScreen title="Trial Balance" exportDef={() => ({ columns, rows })} loading={q.loading} refreshing={q.refreshing}>
 *     <DataTable … />
 *   </ReportScreen>
 *
 * ReportScreen lives in ReportScreen.tsx and the shared skeleton/error helpers in screenParts.tsx; both
 * are re-exported here, so every existing import from this file keeps working.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Banner, PageHeader } from '../ui/index.ts';
import type { IconName } from '../ui/index.ts';
import { cx } from '../ui/lib/cx.ts';
import { GraphStrip, useGraphsToggle } from './graphStrip.tsx';
import type { GraphKind, ReportGraph } from './graphStrip.tsx';
import { useDirty, useScreenActions, useScreenTitle, useStatusHint } from './nav.tsx';
import type { ScreenActionItem } from './nav.tsx';
import { ScreenError, ScreenSkeleton } from './screenParts.tsx';

export { ScreenError, ScreenSkeleton } from './screenParts.tsx';
export { EXPORT_DENIED_HINT, ExportDialog, ReportScreen } from './ReportScreen.tsx';
export type { ReportExportDef, ReportScreenProps } from './ReportScreen.tsx';

export interface ScreenLayoutProps {
  /** Screen title (Title Case): the title row's h1, the back button's path and the window title. */
  title: string;
  /** Words of the title row's context run, after the h1 (one quiet line, ellipsized first). */
  subtitle?: ReactNode;
  /** Accepted and ignored (2.1: no icon tile beside titles). */
  icon?: IconName;
  /**
   * Screen actions, shown in the title row's command bar (the primary, `prominent` and convention
   * ones as buttons, the rest under More) and in the optional shortcut bar; their keys become screen
   * hotkeys while this screen is on top.
   */
  actions?: readonly ScreenActionItem[];
  /** Controls in the title row after the command bar (right side). */
  toolbar?: ReactNode;
  /** The one state word of the context run ("Cancelled", "Optional"). */
  meta?: ReactNode;
  /**
   * (2.1) The screen's one graph (`reportGraph(spec)` from ui/lazyChart.tsx), drawn above the content by
   * the graph strip; Ctrl+J (from app/graphStrip.tsx) folds it. Null or absent: no strip, no Ctrl+J.
   */
  graph?: ReportGraph | null;
  /** (2.1) The graph's class: 'report' (shown by default, the default) or 'detail' (folded by default). */
  graphKind?: GraphKind;
  /** (2.1) The screen's answer in words (a StatLine), right of the toolbar row — never a visible total. */
  stat?: ReactNode;
  /** 'form': readable centred column; 'narrow': dialogs-like width; 'full' (default): all available width. */
  width?: 'full' | 'form' | 'narrow';
  /** Unsaved changes (Esc asks before leaving; window close asks too). */
  dirty?: boolean;
  /** One-line keyboard help: the first line of F1 › "This screen" (2.1: no status bar). */
  hint?: string;
  /** First load: show a skeleton instead of children. */
  loading?: boolean;
  /** Load failure: show the message with a Retry button instead of children. */
  error?: unknown;
  onRetry?: () => void;
  /** Sticky bar under the body (e.g. Accept / Cancel buttons). */
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * Standard screen: title/actions/dirty wiring + the title row (PageHeader: back, h1, context run, the
 * command bar's slot) + the optional toolbar row (`stat`) + the graph strip (`graph`) + the body
 * (+ loading/error states).
 */
export function Screen({
  title,
  subtitle,
  icon,
  actions,
  toolbar,
  meta,
  graph,
  graphKind = 'report',
  stat,
  width = 'full',
  dirty = false,
  hint,
  loading = false,
  error,
  onRetry,
  footer,
  className,
  children,
}: ScreenLayoutProps) {
  const graphs = useGraphsToggle(graphKind);
  const toggle = graph ? graphs.action : null;
  const all = useMemo(() => (toggle ? [...(actions ?? NO_ACTIONS), toggle] : (actions ?? NO_ACTIONS)), [actions, toggle]);
  useScreenTitle(title);
  useScreenActions(all);
  useDirty(dirty);
  useStatusHint(hint);
  return (
    <div className={cx('bx-screen-layout', `bx-screen-layout--${width}`, className)}>
      <div className="bx-screen-layout__inner">
        <PageHeader title={title} subtitle={subtitle} icon={icon} actions={toolbar} meta={meta} />
        {stat ? (
          <div className="bx-toolbar-row">
            <div className="bx-toolbar-row__end">{stat}</div>
          </div>
        ) : null}
        <div className="bx-screen-layout__body">
          {graph && !error && !loading ? <GraphStrip graph={graph} kind={graphKind} /> : null}
          {error ? <ScreenError error={error} onRetry={onRetry} /> : loading ? <ScreenSkeleton /> : children}
        </div>
      </div>
      {footer ? <div className="bx-screen-layout__footer">{footer}</div> : null}
    </div>
  );
}

const NO_ACTIONS: readonly ScreenActionItem[] = [];

/** Inline notice for screens that are read-only for this user. */
export function ReadOnlyNotice({ what = 'these settings' }: { what?: string }) {
  return (
    <Banner tone="info" title="View only" inline>
      You can see {what} but not change them. Ask the company owner for permission to make changes.
    </Banner>
  );
}

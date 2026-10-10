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
import type { ReactNode } from 'react';
import { Banner, PageHeader } from '../ui/index.ts';
import type { IconName } from '../ui/index.ts';
import { cx } from '../ui/lib/cx.ts';
import { useDirty, useScreenActions, useScreenTitle, useStatusHint } from './nav.tsx';
import type { ScreenActionItem } from './nav.tsx';
import { ScreenError, ScreenSkeleton } from './screenParts.tsx';

export { ScreenError, ScreenSkeleton } from './screenParts.tsx';
export { EXPORT_DENIED_HINT, ExportDialog, ReportScreen } from './ReportScreen.tsx';
export type { ReportExportDef, ReportScreenProps } from './ReportScreen.tsx';

export interface ScreenLayoutProps {
  /** Screen title (Title Case): header h1, breadcrumb and window title. */
  title: string;
  subtitle?: ReactNode;
  icon?: IconName;
  /**
   * Screen actions, shown in the screen bar's command bar (the primary, `prominent` and convention
   * ones as buttons, the rest under More) and in the optional shortcut bar; their keys become screen
   * hotkeys while this screen is on top.
   */
  actions?: readonly ScreenActionItem[];
  /** Buttons in the header (right side). */
  toolbar?: ReactNode;
  /** Badges/status next to the title. */
  meta?: ReactNode;
  /** 'form': readable centred column; 'narrow': dialogs-like width; 'full' (default): all available width. */
  width?: 'full' | 'form' | 'narrow';
  /** Unsaved changes (Esc asks before leaving; window close asks too). */
  dirty?: boolean;
  /** One-line keyboard help in the status bar. */
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

/** Standard screen: title/actions/dirty wiring + header + body (+ loading/error states). */
export function Screen({ title, subtitle, icon, actions, toolbar, meta, width = 'full', dirty = false, hint, loading = false, error, onRetry, footer, className, children }: ScreenLayoutProps) {
  useScreenTitle(title);
  useScreenActions(actions ?? NO_ACTIONS);
  useDirty(dirty);
  useStatusHint(hint);
  return (
    <div className={cx('bx-screen-layout', `bx-screen-layout--${width}`, className)}>
      <div className="bx-screen-layout__inner">
        <PageHeader title={title} subtitle={subtitle} icon={icon} actions={toolbar} meta={meta} />
        <div className="bx-screen-layout__body">
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

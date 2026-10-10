/**
 * 'dashboard.home' {embedded?} — the business at a glance: KPI tiles (sales vs last year with a
 * 12-month sparkline, purchases, gross profit, receivables, payables, cash & bank), the 12-month sales /
 * purchases chart, receivables ageing, cash & bank balances, the GST estimate for the month, top
 * customers and items, alerts, low stock, recent vouchers and post-dated cheques. Every card drills
 * down to its report — when the viewer may open it (useDrill: nav.canOpen); otherwise it is not
 * clickable. A "Get started" card (company details, features, invoice number series, what prints on the
 * invoice, ledgers, items, first sale, first receipt, backups; steps done from the books via
 * `summary.setup`) shows until done or hidden.
 *
 * Embedded (Home's right panel) = the 2.0 Home variant: four tiles (To collect, To pay, Cash & bank,
 * Sales this month), Needs your attention, Get started and the last five vouchers; "Show more insights"
 * mounts the other cards (remembered per user profile). Its own small header; it binds NO hotkeys
 * (plain letters belong to the Home menu). Standalone (Reports › Dashboard, unchanged): a ReportScreen —
 * Alt+F2 period, Alt+E export, Alt+P print, Alt+R refresh, Esc back.
 *
 * Reads 'dashboard.summary' { asOf: working date (F2), from/to: period (Alt+F2) }.
 */
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { DashboardSummary } from '../../../shared/types/dashboard.ts';
import { ReportScreen, useApiQuery, useModules, useNav, useOptionalScreen, usePeriod, userMessage, useWorkingDate } from '../../app/index.ts';
import type { ApiQueryResult, ScreenProps } from '../../app/index.ts';
import { Button, EmptyState, IconButton } from '../../ui/index.ts';
import {
  AgeingCard,
  AlertsCard,
  CashBankCard,
  GettingStarted,
  GstCard,
  HomeKpiRow,
  KpiRow,
  LowStockCard,
  PostDatedCard,
  RecentVouchersCard,
  TopCustomersCard,
  TopItemsCard,
  TrendCard,
  useStartSteps,
} from './components.tsx';
import { exportTable, HOME_INSIGHTS_KEY, HOME_RECENT_LIMIT, homeSections, parseInsightsOpen, summaryInput } from './lib/model.ts';
import type { HomeSection } from './lib/model.ts';

export interface DashboardParams {
  /** Rendered inline by the Gateway (compact, no hotkeys). */
  embedded?: boolean;
}

/**
 * The summary for the working date and period (balances as on the earlier of the working date and the
 * period end — see summaryInput). The Gateway stays mounted under every screen, and not every change
 * that matters here invalidates 'dashboard.*' (a backup, a new ledger, F11/F12 settings), so the
 * summary is fetched again whenever the screen becomes visible; unchanged books are served from the
 * server's memo in under a millisecond.
 */
function useSummary(): { q: ApiQueryResult<DashboardSummary>; asOf: string; workingDate: string } {
  const { date } = useWorkingDate();
  const { from, to } = usePeriod();
  const input = summaryInput(date, from, to);
  const q = useApiQuery('dashboard.summary', input, { keepPrevious: true, staleTime: 5_000 });
  const visible = useOptionalScreen()?.visible ?? true;
  const wasVisible = useRef(visible);
  const { refetch } = q;
  useEffect(() => {
    if (visible && !wasVisible.current) void refetch();
    wasVisible.current = visible;
  }, [visible, refetch]);
  return { q, asOf: input.asOf, workingDate: date };
}

export function DashboardScreen({ params }: ScreenProps<DashboardParams>) {
  return params?.embedded ? <EmbeddedDashboard /> : <FullDashboard />;
}

function FullDashboard() {
  const { q, workingDate } = useSummary();
  const s = q.data;
  // Undo "Hide" on the Get started card (kept per company in this browser).
  const start = useStartSteps(s);
  return (
    <ReportScreen
      title="Dashboard"
      periodMode="range"
      loading={q.loading && !s}
      refreshing={q.refreshing}
      error={s ? undefined : q.error}
      onRetry={() => void q.refetch()}
      actions={[
        { key: 'Alt+R', label: 'Refresh', icon: 'refresh', onClick: () => void q.refetch(), group: 'view' },
        { key: 'Alt+S', label: 'Show Get started', icon: 'eye', onClick: start.show, hidden: !start.canShow, group: 'view' },
      ]}
      exportDef={s ? () => exportTable(s) : undefined}
      hint="Tab Move between cards · Enter Open · Alt+F2 Period · F2 Date · Alt+E Export · Alt+P Print · Esc Back"
    >
      <div className="bx-db bx-db--full">
        <DashboardBody s={s} loading={q.loading && !s} workingDate={workingDate} />
      </div>
    </ReportScreen>
  );
}

/** "Show more insights" on Home, remembered per user profile (storage may be blocked: then per session). */
function useInsightsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return parseInsightsOpen(window.localStorage.getItem(HOME_INSIGHTS_KEY));
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(HOME_INSIGHTS_KEY, next ? '1' : '0');
    } catch {
      // not remembered (storage blocked)
    }
  };
  return [open, set];
}

/**
 * The Home variant (2.0): four tiles, Needs your attention, Get started and the last five vouchers;
 * the other cards (and the cards other modules contribute, which run their own queries) mount only
 * after "Show more insights" (lib/model.ts homeSections). No hotkeys: Home's letters belong to its menu.
 */
function EmbeddedDashboard() {
  const nav = useNav();
  const period = usePeriod();
  const { q, asOf, workingDate } = useSummary();
  const s = q.data;
  const titleId = useId();
  const insightsId = useId();
  const start = useStartSteps(s);
  const [insightsOpen, setInsightsOpen] = useInsightsOpen();
  const loading = q.loading && !s;
  const sections = homeSections({ hasVouchers: s?.hasVouchers ?? true, insightsOpen });
  const render = (id: HomeSection) => {
    switch (id) {
      case 'start':
        return <GettingStarted key={id} s={s} />;
      case 'kpis':
        return <HomeKpiRow key={id} s={s} loading={loading} workingDate={workingDate} />;
      case 'attention':
        return <AlertsCard key={id} s={s} loading={loading} className="bx-db__card" />;
      case 'recent':
        return <RecentVouchersCard key={id} s={s} loading={loading} limit={HOME_RECENT_LIMIT} className="bx-db__card" />;
      case 'trend':
        return <TrendCard key={id} s={s} loading={loading} layout="compact" className="bx-db__card bx-db__wide" />;
      case 'ageing':
        return <AgeingCard key={id} s={s} loading={loading} className="bx-db__card" />;
      case 'cashBank':
        return <CashBankCard key={id} s={s} loading={loading} className="bx-db__card" />;
      case 'gst':
        return <GstCard key={id} s={s} className="bx-db__card" />;
      case 'moduleCards':
        return <ModuleCards key={id} />;
    }
  };
  // Tiles and Get started span the panel; the cards sit two to a row.
  const wide = (id: HomeSection) => id === 'start' || id === 'kpis';
  return (
    <section className="bx-db bx-db--embedded" aria-labelledby={titleId} aria-busy={q.refreshing || undefined}>
      <header className="bx-db__head">
        <div>
          <h2 id={titleId} className="bx-db__title">
            Dashboard
          </h2>
          <p className="bx-db__sub">
            {period.label} · balances as on {formatDate(asOf)}
          </p>
        </div>
        <div className="bx-db__head-actions">
          <Button size="sm" variant="ghost" icon="calendar" onClick={period.openDialog} aria-keyshortcuts="Alt+F2">
            Change period
          </Button>
          {start.canShow ? (
            // No hotkey here: plain letters and Alt keys on the Gateway belong to its menu.
            <Button size="sm" variant="ghost" icon="eye" onClick={start.show}>
              Show Get started
            </Button>
          ) : null}
          <IconButton size="sm" icon="refresh" aria-label="Refresh dashboard" loading={q.refreshing} onClick={() => void q.refetch()} />
          <Button size="sm" iconRight="arrow-right" onClick={() => nav.push('dashboard.home', {})}>
            Full dashboard
          </Button>
        </div>
      </header>
      {q.error && !s ? (
        <EmptyState
          icon="alert"
          title="The dashboard could not be loaded"
          body={userMessage(q.error)}
          action={
            <Button icon="refresh" onClick={() => void q.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {groupSections(sections.main, wide).map((g) =>
            g.wide ? (
              <Fragment key={g.ids.join('+')}>{g.ids.map(render)}</Fragment>
            ) : (
              <div key={g.ids.join('+')} className="bx-db__grid">
                {g.ids.map(render)}
              </div>
            ),
          )}
          <div className="bx-db__more">
            <Button size="sm" variant="ghost" icon={insightsOpen ? 'chevron-up' : 'chevron-down'} aria-expanded={insightsOpen} aria-controls={insightsId} onClick={() => setInsightsOpen(!insightsOpen)}>
              {insightsOpen ? 'Show fewer insights' : 'Show more insights'}
            </Button>
          </div>
          <div id={insightsId} className="bx-db__grid" hidden={!insightsOpen}>
            {sections.insights.map(render)}
          </div>
        </>
      )}
    </section>
  );
}

/** Consecutive sections grouped: full-width ones alone, the others into one two-column grid. */
function groupSections(ids: readonly HomeSection[], wide: (id: HomeSection) => boolean): Array<{ wide: boolean; ids: HomeSection[] }> {
  const out: Array<{ wide: boolean; ids: HomeSection[] }> = [];
  for (const id of ids) {
    const w = wide(id);
    const last = out[out.length - 1];
    if (last && last.wide === w) last.ids.push(id);
    else out.push({ wide: w, ids: [id] });
  }
  return out;
}

/** Cards other modules contribute (ModuleDef.dashboardCards), after the dashboard's own. */
function ModuleCards() {
  const modules = useModules();
  return (
    <>
      {modules.flatMap((m) => (m.dashboardCards ?? []).map((C, i) => <C key={`${m.id}:${i}`} className="bx-db__card" />))}
    </>
  );
}

/** The full Dashboard (Reports menu, Go To) — unchanged by the 2.0 Home variant. */
function DashboardBody({ s, loading, workingDate }: { s: DashboardSummary | undefined; loading: boolean; workingDate: string }) {
  // Getting started (one list for the app: company details, features, invoice printing, ledgers,
  // items, first sale, backups) stays — also after the first voucher — until done or hidden.
  if (s && !s.hasVouchers) {
    return (
      <>
        <GettingStarted s={s} />
        <div className="bx-db__grid">
          <AlertsCard s={s} loading={false} className="bx-db__card" />
          <CashBankCard s={s} loading={false} className="bx-db__card" />
        </div>
      </>
    );
  }
  return (
    <>
      <GettingStarted s={s} />
      <KpiRow s={s} loading={loading} layout="full" workingDate={workingDate} />
      <div className="bx-db__grid">
        <TrendCard s={s} loading={loading} layout="full" className="bx-db__card bx-db__wide" />
        <AlertsCard s={s} loading={loading} className="bx-db__card" />
        <AgeingCard s={s} loading={loading} className="bx-db__card" />
        <CashBankCard s={s} loading={loading} className="bx-db__card" />
        <GstCard s={s} className="bx-db__card" />
        <TopCustomersCard s={s} loading={loading} className="bx-db__card" />
        <TopItemsCard s={s} loading={loading} className="bx-db__card" />
        <LowStockCard s={s} loading={loading} className="bx-db__card" />
        <PostDatedCard s={s} loading={loading} className="bx-db__card" />
        <ModuleCards />
        <RecentVouchersCard s={s} loading={loading} className="bx-db__card bx-db__wide" />
      </div>
    </>
  );
}

/**
 * 'dashboard.home' {embedded?} — the business at a glance (2.1, SPEC-21 §1.3, §5).
 *
 * Embedded (Home's right panel, D10): the period (a link: Alt+F2), three figures — To collect, To pay,
 * Cash & bank — the "Sales — last 12 months" graph (Ctrl+J folds it to its one-sentence answer),
 * "Needs your attention" (top 3 + N more), Setup as one line (D11) and one quiet link "Full dashboard".
 * No title, refresh or period button of its own: Home refetches when it is shown, Alt+F2 opens the
 * period anywhere. Its only key is Ctrl+J (while the graph exists); plain letters belong to the menu.
 *
 * Full (Reports › Dashboard, Go To): a ReportScreen — four figures (Sales ▲ %, Gross profit, Receivables,
 * Cash & bank), the trend (Sales with Purchases as grey context) and receivables by age (both through
 * LazyChart; Ctrl+J), the attention list, then the other cards as one line each — "Show all cards"
 * (remembered, `pevqori.ui` dashboardAllCards) shows the cards themselves. Keys: Alt+F2 period, Alt+E
 * export, Alt+P print, Alt+R refresh, Alt+S Show setup, Ctrl+J graphs, Esc back.
 *
 * Reads 'dashboard.summary' { asOf: working date (F2), from/to: period (Alt+F2) }.
 */
import { useEffect, useMemo, useRef } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { DashboardSummary } from '../../../shared/types/dashboard.ts';
import { ReportScreen, useApiQuery, useModules, useNav, useOptionalScreen, usePeriod, userMessage, useWorkingDate } from '../../app/index.ts';
import type { ApiQueryResult, ScreenProps } from '../../app/index.ts';
import { useGraphsToggle } from '../../app/graphStrip.tsx';
import { GRAPHS_ARIA_KEY, graphsLabel, graphsTooltip } from '../../app/lib/graphsToggle.ts';
import { setUiPrefs, useUiPrefs } from '../../app/preferences.ts';
import { Button } from '../../ui/index.ts';
import {
  AgeingCard,
  AlertsCard,
  CardLines,
  CashBankCard,
  GstCard,
  HomeAlerts,
  HomeFigures,
  HomeGraph,
  KpiRow,
  LowStockCard,
  PostDatedCard,
  RecentVouchersCard,
  SetupLine,
  TopCustomersCard,
  TopItemsCard,
  TrendCard,
  useGraphFold,
  useStartSteps,
} from './components.tsx';
import { ageingSpec, exportTable, homeSummaryInput, setupLine, summaryInput, trendSpec } from './lib/model.ts';

export interface DashboardParams {
  /** Rendered inline by the Gateway (Home's panel). */
  embedded?: boolean;
}

/**
 * The summary for the working date and period (balances as on the earlier of the working date and the
 * period end — see summaryInput). The Gateway stays mounted under every screen, and not every change
 * that matters here invalidates 'dashboard.*' (a backup, a new ledger, F11/F12 settings), so the
 * summary is fetched again whenever the screen becomes visible; unchanged books are served from the
 * server's memo in under a millisecond.
 */
function useSummary(home = false): { q: ApiQueryResult<DashboardSummary>; asOf: string; workingDate: string } {
  const { date } = useWorkingDate();
  const { from, to } = usePeriod();
  // Home's graph is the last 12 months up to the working date, whatever the period end (homeSummaryInput).
  const input = (home ? homeSummaryInput : summaryInput)(date, from, to);
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
  return params?.embedded ? <HomePanel /> : <FullDashboard />;
}

/** Home's right panel (D10): period · figures · graph · attention · Setup · Full dashboard. */
function HomePanel() {
  const nav = useNav();
  const period = usePeriod();
  const { q, asOf, workingDate } = useSummary(true);
  const s = q.data;
  const start = useStartSteps(s);
  const loading = q.loading && !s;
  const setupShown = start.mode === 'steps';
  return (
    <section className="bx-db bx-db--home" aria-label="Business at a glance" aria-busy={q.refreshing || undefined}>
      <div>
        <Button size="sm" variant="link" title="Period · Alt+F2" aria-keyshortcuts="Alt+F2" onClick={period.openDialog}>
          {period.label}
        </Button>
        {asOf !== workingDate ? <span className="bx-db__muted"> · balances as on {formatDate(asOf)}</span> : null}
      </div>
      {q.error && !s ? (
        <p className="bx-db__note">
          The dashboard could not be loaded: {userMessage(q.error)}{' '}
          <Button size="sm" variant="link" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </p>
      ) : (
        <>
          <HomeFigures s={s} loading={loading} />
          {s ? <HomeGraph s={s} /> : null}
          {s ? <HomeAlerts s={s} setupBackupOpen={setupShown && setupLine(start.steps).backupOpen} /> : null}
          <SetupLine start={start} hasVouchers={s?.hasVouchers ?? true} />
        </>
      )}
      <div>
        <Button size="sm" variant="link" onClick={() => nav.push('dashboard.home', {})}>
          Full dashboard
        </Button>
      </div>
    </section>
  );
}

function FullDashboard() {
  const { q, workingDate } = useSummary();
  const s = q.data;
  const start = useStartSteps(s);
  const graphs = useGraphsToggle('report');
  const allCards = useUiPrefs().dashboardAllCards;
  // Ctrl+J (and its More item) only while the screen has a graph to fold; the text button sits on the first graph card.
  const has = useMemo(() => ({ trend: s ? trendSpec(s.trend, undefined, s.asOf) !== null : false, ageing: s ? ageingSpec(s.receivables.ageing) !== null : false }), [s]);
  const hasGraph = has.trend || has.ageing;
  const fold = useGraphFold(graphs.shown);
  const toggle = (
    <button ref={fold.toggleRef} type="button" className="bx-report__graph-toggle" onClick={graphs.toggle} title={graphsTooltip(graphs.shown, 'report')} aria-keyshortcuts={GRAPHS_ARIA_KEY}>
      {graphsLabel(graphs.shown)}
    </button>
  );
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
        { key: 'Alt+S', label: 'Show setup', icon: 'eye', onClick: start.show, hidden: !start.canShow, group: 'view' },
        ...(hasGraph && graphs.action ? [graphs.action] : []),
      ]}
      exportDef={s ? () => exportTable(s) : undefined}
      hint="Tab Move · Enter Open · Alt+F2 Period · F2 Date · Alt+E Export · Alt+P Print · Esc Back"
    >
      {s ? (
        <div className="bx-db bx-db--full">
          <SetupLine start={start} hasVouchers={s.hasVouchers} />
          <KpiRow s={s} loading={false} workingDate={workingDate} />
          <div className="bx-db__grid">
            <TrendCard s={s} fold={fold} toggle={has.trend ? toggle : undefined} className="bx-db__wide" />
            <AgeingCard s={s} fold={fold} toggle={has.trend ? undefined : toggle} />
          </div>
          <span className="bx-sr-only" aria-live="polite">
            {fold.announcement}
          </span>
          <AlertsCard s={s} />
          {allCards ? (
            <div className="bx-db__grid">
              <CashBankCard s={s} />
              <GstCard s={s} />
              <TopCustomersCard s={s} />
              <TopItemsCard s={s} />
              <LowStockCard s={s} />
              <PostDatedCard s={s} />
              <ModuleCards />
              <RecentVouchersCard s={s} className="bx-db__wide" />
            </div>
          ) : (
            <CardLines s={s} />
          )}
          <div>
            <Button size="sm" variant="link" aria-expanded={allCards} onClick={() => setUiPrefs({ dashboardAllCards: !allCards })}>
              {allCards ? 'Show fewer cards' : 'Show all cards'}
              <span aria-hidden="true">{allCards ? ' ▴' : ' ▾'}</span>
            </Button>
          </div>
        </div>
      ) : null}
    </ReportScreen>
  );
}

/** Cards other modules contribute (ModuleDef.dashboardCards) — with "Show all cards" only (they run their own queries). */
function ModuleCards() {
  const modules = useModules();
  return (
    <>
      {modules.flatMap((m) => (m.dashboardCards ?? []).map((C, i) => <C key={`${m.id}:${i}`} />))}
    </>
  );
}

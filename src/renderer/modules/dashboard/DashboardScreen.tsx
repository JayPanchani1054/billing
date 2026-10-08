/**
 * 'dashboard.home' {embedded?} — the business at a glance: KPI tiles (sales vs last year with a
 * 12-month sparkline, purchases, gross profit, receivables, payables, cash & bank), the 12-month sales /
 * purchases chart, receivables ageing, cash & bank balances, the GST estimate for the month, top
 * customers and items, alerts, low stock, recent vouchers and post-dated cheques. Every card drills
 * down to its report.
 *
 * Embedded (the Gateway's right panel): compact layout with its own small header; it binds NO hotkeys
 * (plain letters belong to the Gateway menu). Standalone: a ReportScreen — Alt+F2 period, Alt+E export,
 * Alt+P print, Alt+R refresh, Esc back.
 *
 * Reads 'dashboard.summary' { asOf: working date (F2), from/to: period (Alt+F2) }.
 */
import { useId } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { DashboardSummary } from '../../../shared/types/dashboard.ts';
import { ReportScreen, useApiQuery, useNav, usePeriod, userMessage, useWorkingDate } from '../../app/index.ts';
import type { ApiQueryResult, ScreenProps } from '../../app/index.ts';
import { Button, EmptyState, IconButton } from '../../ui/index.ts';
import {
  AgeingCard,
  AlertsCard,
  CashBankCard,
  GettingStarted,
  GstCard,
  KpiRow,
  LowStockCard,
  PostDatedCard,
  RecentVouchersCard,
  TopCustomersCard,
  TopItemsCard,
  TrendCard,
} from './components.tsx';
import type { DashboardLayout } from './components.tsx';
import { exportTable } from './lib/model.ts';

export interface DashboardParams {
  /** Rendered inline by the Gateway (compact, no hotkeys). */
  embedded?: boolean;
}

function useSummary(): { q: ApiQueryResult<DashboardSummary>; asOf: string } {
  const { date } = useWorkingDate();
  const { from, to } = usePeriod();
  const q = useApiQuery('dashboard.summary', { asOf: date, from, to }, { keepPrevious: true, staleTime: 60_000 }) as ApiQueryResult<DashboardSummary>;
  return { q, asOf: date };
}

export function DashboardScreen({ params }: ScreenProps<DashboardParams>) {
  return params?.embedded ? <EmbeddedDashboard /> : <FullDashboard />;
}

function FullDashboard() {
  const { q } = useSummary();
  const s = q.data;
  return (
    <ReportScreen
      title="Dashboard"
      periodMode="range"
      loading={q.loading && !s}
      refreshing={q.refreshing}
      error={s ? undefined : q.error}
      onRetry={() => void q.refetch()}
      actions={[{ key: 'Alt+R', label: 'Refresh', icon: 'refresh', onClick: () => void q.refetch(), group: 'view' }]}
      exportDef={s ? () => exportTable(s) : undefined}
      hint="Tab Move between cards · Enter Open · Alt+F2 Period · F2 Date · Alt+E Export · Alt+P Print · Esc Back"
    >
      <div className="bx-db bx-db--full">
        <DashboardBody s={s} loading={q.loading && !s} layout="full" />
      </div>
    </ReportScreen>
  );
}

function EmbeddedDashboard() {
  const nav = useNav();
  const period = usePeriod();
  const { q, asOf } = useSummary();
  const s = q.data;
  const titleId = useId();
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
        <DashboardBody s={s} loading={q.loading && !s} layout="compact" />
      )}
    </section>
  );
}

function DashboardBody({ s, loading, layout }: { s: DashboardSummary | undefined; loading: boolean; layout: DashboardLayout }) {
  if (s && !s.hasVouchers) {
    return (
      <>
        <GettingStarted />
        <div className="bx-db__grid">
          <AlertsCard s={s} loading={false} className="bx-db__card" />
          <CashBankCard s={s} loading={false} className="bx-db__card" />
        </div>
      </>
    );
  }
  if (layout === 'compact') {
    return (
      <>
        <KpiRow s={s} loading={loading} layout="compact" />
        <div className="bx-db__grid">
          <AlertsCard s={s} loading={loading} className="bx-db__card" />
          <AgeingCard s={s} loading={loading} className="bx-db__card" />
          <TrendCard s={s} loading={loading} layout="compact" className="bx-db__card bx-db__wide" />
          <CashBankCard s={s} loading={loading} className="bx-db__card" />
          <GstCard s={s} className="bx-db__card" />
          <RecentVouchersCard s={s} loading={loading} className="bx-db__card bx-db__wide" />
        </div>
      </>
    );
  }
  return (
    <>
      <KpiRow s={s} loading={loading} layout="full" />
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
        <RecentVouchersCard s={s} loading={loading} className="bx-db__card bx-db__wide" />
      </div>
    </>
  );
}

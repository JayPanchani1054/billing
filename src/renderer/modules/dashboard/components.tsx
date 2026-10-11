/**
 * Dashboard parts (2.1, SPEC-21 §1.3, §5). Home's panel: three figures, the "Sales — last 12 months"
 * graph, "Needs your attention" and the one-line Setup. The full Dashboard: four figures, the trend and
 * ageing graphs, the attention list, the secondary cards as one line each ("Show all cards" shows the
 * 2.0 cards). Every figure, row and line drills down — when the viewer may open the target (useDrill).
 * Text wears text tokens; the only colours are the graph kit's and the tone dots of the alerts.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr, formatQty } from '../../../shared/format.ts';
import type {
  DashboardBalanceRow,
  DashboardLowStockItem,
  DashboardPdcRow,
  DashboardSummary,
  DashboardTopCustomer,
  DashboardTopItem,
  DashboardVoucherRow,
} from '../../../shared/types/dashboard.ts';
import { api, useBooks, useCan, useCompany, useFeatures, useNav, useScreenActions, useShell } from '../../app/index.ts';
import { GraphStrip, useGraphsToggle } from '../../app/graphStrip.tsx';
import type { ReportGraph } from '../../app/graphStrip.tsx';
import { graphsAnnouncement } from '../../app/lib/graphsToggle.ts';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, IconButton, KeyValueList, KpiCard, Tooltip } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { LazyChart } from '../../ui/lazyChart.tsx';
import type { ChartSpec } from '../../ui/lib/chartSpec.ts';
import { MiniColumns } from '../../ui/MiniColumns.tsx';
import {
  ageingSpec,
  balanceRange,
  buildAlerts,
  canShowStartCard,
  cardLines,
  cashBankCaption,
  compact,
  DRILL,
  flowKpi,
  gstDueLine,
  gstItems,
  HOME_ALERTS_SHOWN,
  homeAlerts,
  homeFigures,
  homeSalesDrill,
  homeSalesGraph,
  isVoucherTarget,
  parseStartPrefs,
  plural,
  setupLine,
  signedKpi,
  START_VOUCHER_BASE,
  startCardMode,
  startPrefsKey,
  startSteps,
  toggleTicked,
  trendSpec,
} from './lib/model.ts';
import type { DashboardAlert, DrillTarget, StartPrefs, StartStep } from './lib/model.ts';

/**
 * Drill-downs that respect the viewer's permissions (nav.canOpen: screen access and feature). A
 * target the viewer may not open is not offered — figures and rows are not clickable, links are
 * hidden — instead of leading to the shell's refusal toast.
 */
export interface Drill {
  /** Open the target (no-op when the viewer may not open it). */
  open: (t: DrillTarget) => void;
  can: (screen: string) => boolean;
  /** onClick handler for the target, or undefined (not clickable) when the viewer may not open it. */
  to: (t: DrillTarget | null | undefined) => (() => void) | undefined;
}

export function useDrill(): Drill {
  const nav = useNav();
  return useMemo(() => {
    const can = (screen: string): boolean => nav.canOpen(screen);
    const open = (t: DrillTarget): void => {
      if (can(t.screen)) nav.push(t.screen, t.params ?? {});
    };
    return { open, can, to: (t: DrillTarget | null | undefined) => (t && can(t.screen) ? () => open(t) : undefined) };
  }, [nav]);
}

// ───────────────────────────── Home: the three figures ─────────────────────────────

/**
 * To collect, To pay, Cash & bank (lib/model.ts homeFigures): the drill buttons of 2.0, quieter facts in
 * the tooltip. A clickable KpiCard renders a <button> that does not take the Tooltip's aria-describedby,
 * so the same facts follow the caption as visually hidden text: a screen reader hears them too.
 */
export function HomeFigures({ s, loading }: { s: DashboardSummary | undefined; loading: boolean }) {
  const drill = useDrill();
  const figures = useMemo(() => (s ? homeFigures(s) : null), [s]);
  return (
    <div className="bx-db__figures" role="group" aria-label="Key figures">
      {figures
        ? figures.map((f) => (
            <Tooltip key={f.id} content={f.tooltip} placement="bottom" describeChild={false}>
              <KpiCard
                label={f.label}
                value={f.value}
                amount
                caption={
                  <>
                    {f.caption}
                    <span className="bx-sr-only">. {f.tooltip}</span>
                  </>
                }
                onClick={drill.to(f.target)}
              />
            </Tooltip>
          ))
        : ['To collect', 'To pay', 'Cash & bank'].map((label) => <KpiCard key={label} label={label} value={0} amount loading={loading} />)}
    </div>
  );
}

// ───────────────────────────── Home: the graph ─────────────────────────────

/** The Sales Accounts group id, looked up once per company when a column is opened (masters.view). */
const salesGroupIds = new Map<string, number | null>();

async function salesGroupId(companyId: string): Promise<number | null> {
  if (salesGroupIds.has(companyId)) return salesGroupIds.get(companyId) ?? null;
  const list = await api('accounts.group.list', {});
  const id = list.rows.find((g) => g.depth === 0 && g.primaryCode === 'SALES_ACCOUNTS')?.id ?? null;
  salesGroupIds.set(companyId, id);
  return id;
}

/**
 * "Sales — last 12 months" (MiniColumns, the only graph code in the start-up bundle) in the graph
 * strip's header line — title · '₹35.8 K so far in Oct · ▲ 12 % vs 1–10 Oct 2025' · Hide graphs.
 * Ctrl+J (useGraphsToggle) is registered on Home only while the graph exists. Enter / a click on a
 * column opens the Sales Accounts monthly summary of that month's financial year; without access to
 * the groups (or the summary) it opens that month's Sales Register instead.
 */
export function HomeGraph({ s }: { s: DashboardSummary }) {
  const drill = useDrill();
  const companyId = useCompany().id;
  const { fyStartMonth } = useBooks();
  const canGroups = useCan('masters.view');
  const g = useMemo(() => homeSalesGraph(s), [s]);
  const toggle = useGraphsToggle('report');
  useScreenActions(g && toggle.action ? [toggle.action] : NO_ACTIONS);
  const graph = useMemo<ReportGraph | null>(() => {
    if (!g) return null;
    const open = (i: number) => {
      const month = g.keys[i];
      const m = s.trend.find((t) => t.month === month);
      if (!month || !m) return;
      const register = DRILL.salesRegister({ from: m.from, to: m.to });
      if (!canGroups || !drill.can('reports.monthlySummary')) return drill.open(register);
      salesGroupId(companyId).then(
        (id) => drill.open(id === null ? register : homeSalesDrill(month, s.booksFrom, id, fyStartMonth)),
        () => drill.open(register),
      );
    };
    // A viewer who may open neither the summary nor the register gets a graph without a drill.
    const canDrill = drill.can('reports.monthlySummary') || drill.can('reports.register');
    return {
      title: g.title,
      takeaway: g.takeaway,
      inline: false,
      render: () => <MiniColumns title={g.title} months={g.months} values={g.values} emphasis={g.emphasis} label={g.label} onActivate={canDrill ? open : undefined} />,
    };
  }, [g, s, canGroups, drill, companyId, fyStartMonth]);
  return <GraphStrip graph={graph} kind="report" />;
}

const NO_ACTIONS: readonly never[] = [];

// ───────────────────────────── Needs your attention ─────────────────────────────

/**
 * One sentence per alert with a 6 px tone dot (the meaning is in the words); the detail is the row's
 * tooltip. `limit`: rows shown before "N more", which expands in place.
 */
export function AlertList({ alerts, limit, allClear }: { alerts: readonly DashboardAlert[]; limit?: number; allClear?: boolean }) {
  const drill = useDrill();
  const [all, setAll] = useState(false);
  if (alerts.length === 0) return allClear ? <p className="bx-db__note">All clear — nothing overdue, low or pending.</p> : null;
  const shown = limit === undefined || all ? alerts : alerts.slice(0, limit);
  const more = alerts.length - shown.length;
  return (
    <section>
      <h2 className="bx-db__h">Needs your attention</h2>
      <ul className="bx-db-alerts">
        {shown.map((a) => {
          const open = drill.to(a.target);
          const body = (
            <>
              {a.title}
              <span className="bx-sr-only">. {a.body}</span>
            </>
          );
          return (
            <li key={a.id}>
              {open ? (
                <button type="button" className="bx-db-alert" data-tone={a.tone} title={a.body} onClick={open}>
                  {body}
                </button>
              ) : (
                <span className="bx-db-alert" data-tone={a.tone} title={a.body}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <Button size="sm" variant="link" onClick={() => setAll(true)}>
          {more} more
        </Button>
      ) : null}
    </section>
  );
}

// ───────────────────────────── Setup (getting started) ─────────────────────────────

function loadStartPrefs(companyId: string): StartPrefs {
  try {
    return parseStartPrefs(window.localStorage.getItem(startPrefsKey(companyId)));
  } catch {
    return parseStartPrefs(null);
  }
}

/**
 * Every mounted useStartSteps (Home's Setup line, the full Dashboard's, its Alt+S) takes the new
 * preferences after a change — passed along, not re-read, so × and Show still work for this session
 * when storage is blocked.
 */
const startPrefsListeners = new Set<(companyId: string, prefs: StartPrefs) => void>();

function saveStartPrefs(companyId: string, prefs: StartPrefs): void {
  try {
    window.localStorage.setItem(startPrefsKey(companyId), JSON.stringify(prefs));
  } catch {
    // not remembered (storage blocked)
  }
  for (const l of [...startPrefsListeners]) l(companyId, prefs);
}

/**
 * The company's getting-started steps (lib/model.ts startSteps — the app's one onboarding list) and
 * whether Setup shows (startCardMode). × (hide) and "Mark as done" are remembered per company.
 */
export function useStartSteps(s: DashboardSummary | undefined): {
  steps: StartStep[];
  mode: 'steps' | 'empty' | null;
  hide: () => void;
  /** Undo hide (offered only when `canShow`). */
  show: () => void;
  canShow: boolean;
  tick: (id: string, on: boolean) => void;
} {
  const drill = useDrill();
  const companyId = useCompany().id;
  const features = useFeatures();
  const manageCompany = useCan('company.manage');
  const createMasters = useCan('masters.create');
  const createVouchers = useCan('vouchers.create');
  const importData = useCan('data.import');
  const [prefs, setPrefs] = useState<StartPrefs>(() => loadStartPrefs(companyId));
  useEffect(() => {
    setPrefs(loadStartPrefs(companyId));
    const reload = (changed: string, next: StartPrefs) => {
      if (changed === companyId) setPrefs(next);
    };
    startPrefsListeners.add(reload);
    return () => {
      startPrefsListeners.delete(reload);
    };
  }, [companyId]);
  // Saved (and every other mounted copy notified) outside the state updater: updaters must stay pure.
  const update = (next: (p: StartPrefs) => StartPrefs) => {
    const v = next(prefs);
    setPrefs(v);
    saveStartPrefs(companyId, v);
  };
  const steps = startSteps({
    manageCompany,
    createMasters,
    createVouchers,
    importData,
    inventory: features.inventory,
    canOpen: drill.can,
    setup: s?.setup,
    hasVouchers: s?.hasVouchers ?? false,
    ticked: prefs.ticked,
  });
  return {
    steps,
    mode: s ? startCardMode(steps, { hidden: prefs.hidden, hasVouchers: s.hasVouchers }) : null,
    hide: () => update((p) => ({ ...p, hidden: true })),
    show: () => update((p) => ({ ...p, hidden: false })),
    canShow: s ? canShowStartCard(steps, { hidden: prefs.hidden, hasVouchers: s.hasVouchers }) : false,
    tick: (id, on) => update((p) => toggleTicked(p, id, on)),
  };
}

/**
 * Setup as ONE line (D11): "Setup 4 of 9 · Next: Choose what prints on your invoice   Continue   ×".
 * "Setup 4 of 9" is a disclosure that expands the same `list "First steps"` in place — one line per
 * step: its tick (done from the books, or "Mark as done"), its title and its action. Steps tick
 * themselves off; × hides Setup (the full Dashboard's "Show Get started", Alt+S, brings it back).
 */
export function SetupLine({ start, hasVouchers }: { start: ReturnType<typeof useStartSteps>; hasVouchers: boolean }) {
  const shell = useShell();
  const drill = useDrill();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { steps, mode, hide, tick } = start;
  if (mode === null) return null;
  if (mode === 'empty') return <p className="bx-db__note">Nothing recorded yet — figures appear here once vouchers are entered.</p>;
  const line = setupLine(steps);
  const go = (st: StartStep) => {
    const t = st.target;
    if (isVoucherTarget(t)) shell.openVoucher(START_VOUCHER_BASE[t]);
    else drill.open(t);
  };
  return (
    <section>
      <div className="bx-db-setup">
        <Button size="sm" variant="link" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          {line.total > 0 ? `Setup ${line.done} of ${line.total}` : 'Setup'}
        </Button>
        {line.next ? <span className="bx-db__muted">· Next: {line.next.title}</span> : null}
        {line.next ? (
          <Button size="sm" variant="link" onClick={() => line.next && go(line.next)}>
            Continue
          </Button>
        ) : null}
        <IconButton size="sm" icon="close" aria-label="Hide setup" onClick={hide} />
      </div>
      {!hasVouchers ? <p className="bx-db__note">Tip: hold Ctrl to see the keys of the buttons on screen.</p> : null}
      <ol id={listId} className="bx-db-steps" aria-label="First steps" hidden={!open}>
        {steps.map((st) => (
          <li key={st.id} className={st.done ? 'is-done' : undefined}>
            {st.optional ? (
              <span />
            ) : (
              <Checkbox
                checked={st.done}
                disabled={st.doneFromBooks}
                onChange={(on) => tick(st.id, on)}
                aria-label={st.doneFromBooks ? `“${st.title}” is done` : `Mark “${st.title}” as done`}
              />
            )}
            <span title={st.body}>
              {st.title}
              {st.optional ? <span className="bx-db__muted"> (optional)</span> : null}
            </span>
            <Button size="sm" variant="link" aria-keyshortcuts={st.shortcut} title={st.shortcut ? `${st.action} · ${st.shortcut}` : undefined} onClick={() => go(st)}>
              {st.action}
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ───────────────────────────── Full Dashboard: figures ─────────────────────────────

/** The full Dashboard's four figures: Sales (▲ % vs last year), Gross profit (margin), Receivables, Cash & bank. */
export function KpiRow({ s, loading, workingDate }: { s: DashboardSummary | undefined; loading: boolean; workingDate?: string }) {
  const drill = useDrill();
  const sales = s ? flowKpi(s.sales, s.asOf, workingDate) : null;
  const period = s?.ranges.period;
  // A negative figure is relabelled, never shown with a bare minus.
  const salesK = signedKpi('Sales', sales?.value ?? 0, 'Sales returns (net)');
  const receivablesK = signedKpi('Receivables', s?.receivables.total ?? 0, 'Advances from customers');
  const cashBankK = signedKpi('Cash & bank', s ? s.cashBank.cashTotal + s.cashBank.bankTotal : 0, 'Cash & bank (overdrawn)');
  const gp = s?.grossProfit ?? null;
  return (
    <div className="bx-db__figures" role="group" aria-label="Key figures">
      <KpiCard
        label={salesK.label}
        value={salesK.value}
        amount
        loading={loading}
        delta={sales && sales.delta !== null ? { value: sales.delta, label: 'vs last year' } : undefined}
        caption={sales && sales.delta === null ? sales.comparison : undefined}
        onClick={period ? drill.to(DRILL.salesRegister(period)) : undefined}
      />
      {gp ? (
        <KpiCard
          label={gp.amount < 0 ? 'Gross loss' : 'Gross profit'}
          value={Math.abs(gp.amount)}
          amount
          loading={loading}
          caption={gp.marginPercent === null ? 'No sales in this period' : `Margin ${gp.marginPercent.toFixed(1)} %`}
          onClick={period ? drill.to(DRILL.profitLoss(period)) : undefined}
        />
      ) : null}
      <KpiCard
        label={receivablesK.label}
        value={receivablesK.value}
        amount
        loading={loading}
        caption={s && s.receivables.overdue > 0 ? `${compact(s.receivables.overdue)} overdue` : undefined}
        onClick={drill.to(DRILL.receivables())}
      />
      <KpiCard
        label={cashBankK.label}
        value={cashBankK.value}
        amount
        loading={loading}
        caption={s ? cashBankCaption(s.cashBank) : undefined}
        onClick={s ? drill.to(DRILL.cashBank(balanceRange(s))) : undefined}
      />
    </div>
  );
}

// ───────────────────────────── Full Dashboard: graphs ─────────────────────────────

/**
 * The full Dashboard's graphs fold together (Ctrl+J, or the "Hide graphs" text button on the first graph
 * card). Folding while a plot has the focus would drop the focus to <body>: it moves to that button
 * instead (as the report strip does), and a live region says what changed.
 */
export interface GraphFold {
  shown: boolean;
  /** On the plots' wrapper: remembers whether the focus is inside a plot. */
  plot: { onFocus: () => void; onBlur: (e: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => void };
  /** On the "Hide graphs" button. */
  toggleRef: { current: HTMLButtonElement | null };
  /** What the live region says after a change ('' on first render). */
  announcement: string;
}

export function useGraphFold(shown: boolean): GraphFold {
  const inPlot = useRef(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const prev = useRef(shown);
  useLayoutEffect(() => {
    if (prev.current === shown) return;
    prev.current = shown;
    setAnnouncement(graphsAnnouncement(shown, 'report'));
    if (shown || !inPlot.current) return;
    inPlot.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) toggleRef.current?.focus();
  }, [shown]);
  const plot = useMemo(
    () => ({
      onFocus: () => {
        inPlot.current = true;
      },
      // A move to another element clears it; a blur without a new target (the plot being removed) does not.
      onBlur: (e: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) inPlot.current = false;
      },
    }),
    [],
  );
  return { shown, plot, toggleRef, announcement };
}

/**
 * A graph card: the heading, the one-sentence answer (the plot's description) and — while graphs are
 * shown (Ctrl+J, "Hide graphs") — the plot through LazyChart. Folded, the answer stays.
 */
function GraphCard({ title, takeaway, spec, fold, toggle, className }: { title: string; takeaway: string; spec: ChartSpec | null; fold: GraphFold; toggle?: ReactNode; className?: string }) {
  const takeawayId = useId();
  return (
    <Card className={className} title={title} headingLevel={2} padding="none" actions={toggle}>
      <p id={takeawayId} className="bx-db__note">
        {takeaway}
      </p>
      {fold.shown && spec ? (
        <div onFocus={fold.plot.onFocus} onBlur={fold.plot.onBlur}>
          <LazyChart spec={spec} describedBy={takeawayId} />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * "Sales and purchases — last 12 months": a line of Sales with Purchases as grey context (LazyChart);
 * months after the balances date have no mark.
 */
export function TrendCard({ s, fold, toggle, className }: { s: DashboardSummary | undefined; fold: GraphFold; toggle?: ReactNode; className?: string }) {
  const drill = useDrill();
  const canRegister = drill.can('reports.register');
  const spec = useMemo(
    () =>
      s
        ? trendSpec(
            s.trend,
            canRegister
              ? (i) => {
                  const m = s.trend[i];
                  if (m) drill.open(DRILL.salesRegister({ from: m.from, to: m.to }));
                }
              : undefined,
            s.asOf,
          )
        : null,
    [s, canRegister, drill],
  );
  if (!s) return null;
  return <GraphCard className={className} title="Sales and purchases — last 12 months" takeaway={spec ? spec.takeaway : 'No sales or purchases in the last 12 months'} spec={spec} fold={fold} toggle={toggle} />;
}

/** Receivables by age: ordinal columns, "Not due" grey (LazyChart); Enter opens Receivables. */
export function AgeingCard({ s, fold, toggle, className }: { s: DashboardSummary | undefined; fold: GraphFold; toggle?: ReactNode; className?: string }) {
  const drill = useDrill();
  const can = drill.can('outstanding.receivables');
  const spec = useMemo(() => (s ? ageingSpec(s.receivables.ageing, can ? (i) => drill.open(i === 0 ? DRILL.receivables() : DRILL.receivablesAgeing()) : undefined) : null), [s, can, drill]);
  if (!s || !spec) return null;
  return <GraphCard className={className} title="Receivables by age" takeaway={spec.takeaway} spec={spec} fold={fold} toggle={toggle} />;
}

// ───────────────────────────── Full Dashboard: the other cards ─────────────────────────────

/** The secondary cards as one line each (lib/model.ts cardLines): title · what it says · a link. */
export function CardLines({ s }: { s: DashboardSummary }) {
  const drill = useDrill();
  const lines = useMemo(() => cardLines(s), [s]);
  return (
    <ul className="bx-db-lines" aria-label="More figures">
      {lines.map((l) => (
        <li key={l.id}>
          <strong>{l.title}</strong>
          <span className="bx-db__muted">{l.text}</span>
          {drill.can(l.target.screen) ? (
            <Button size="sm" variant="link" onClick={drill.to(l.target)}>
              {l.link}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The full alert list of the full Dashboard (every alert, all clear when none). */
export function AlertsCard({ s }: { s: DashboardSummary }) {
  const drill = useDrill();
  const alerts = useMemo(() => buildAlerts(s, { canOpen: drill.can }), [s, drill.can]);
  return <AlertList alerts={alerts} allClear />;
}

/** Home's attention list: top 3 + "N more", without what a figure or the Setup line already says. */
export function HomeAlerts({ s, setupBackupOpen }: { s: DashboardSummary; setupBackupOpen: boolean }) {
  const drill = useDrill();
  const alerts = useMemo(() => homeAlerts(s, { viewer: { canOpen: drill.can }, setupBackupOpen }), [s, drill.can, setupBackupOpen]);
  return <AlertList alerts={alerts} limit={HOME_ALERTS_SHOWN} />;
}

interface CashBankRow extends DashboardBalanceRow {
  kind: 'cash' | 'bank';
}

export function CashBankCard({ s, className }: { s: DashboardSummary; className?: string }) {
  const drill = useDrill();
  const rows = useMemo<CashBankRow[]>(() => [...s.cashBank.cash.map((r) => ({ ...r, kind: 'cash' as const })), ...s.cashBank.banks.map((r) => ({ ...r, kind: 'bank' as const }))], [s]);
  const columns = useMemo<Column<CashBankRow>[]>(
    () => [
      { key: 'name', header: 'Account', minWidth: 140, value: (r) => `${r.name}${r.accountTail ? ` ··${r.accountTail}` : ''}${r.isOverdraft ? ' (OD)' : ''}` },
      { key: 'balance', header: 'Balance', kind: 'drcr', width: 150 },
    ],
    [],
  );
  return (
    <Card className={className} title="Cash & bank" subtitle={`As on ${formatDate(s.asOf)}`} padding="none">
      <DataTable<CashBankRow>
        aria-label="Cash and bank balances"
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.ledgerId)}
        density="compact"
        onRowActivate={drill.can('reports.ledger') ? (r) => drill.open(DRILL.ledger(r.ledgerId, balanceRange(s))) : undefined}
        footerRows={rows.length > 1 ? [{ key: 'total', cells: { name: 'Total', balance: formatDrCr(s.cashBank.cashTotal + s.cashBank.bankTotal) } }] : undefined}
        empty={<EmptyState size="sm" title="No cash or bank accounts" body="Create a ledger under Bank Accounts to see its balance here." />}
      />
    </Card>
  );
}

export function GstCard({ s, className }: { s: DashboardSummary; className?: string }) {
  const g = s.gst;
  const due = s.gstDue;
  if (!g && !due) return null;
  return (
    <Card className={className} title="GST" subtitle="Estimate from your books" padding="none">
      {due ? (
        <section aria-label={`GST return for ${due.label}`}>
          <p className="bx-db__note">
            {due.label} return · {gstDueLine(due, s.asOf)}
          </p>
          <KeyValueList layout="inline" alignValues="right" items={gstItems(due)} />
        </section>
      ) : null}
      {g ? (
        <section aria-label={`GST for ${g.label} so far`}>
          <p className="bx-db__note">
            {g.label} so far · {g.dueForm} due by {formatDate(g.dueDate)} · {plural(g.documentCount, 'GST document')}; interest and late fee not included
          </p>
          <KeyValueList layout="inline" alignValues="right" items={gstItems(g)} />
        </section>
      ) : null}
    </Card>
  );
}

export function TopCustomersCard({ s, className }: { s: DashboardSummary; className?: string }) {
  const drill = useDrill();
  const columns = useMemo<Column<DashboardTopCustomer>[]>(
    () => [
      { key: 'name', header: 'Customer', minWidth: 140 },
      { key: 'amount', header: 'Sales', kind: 'amount', width: 130 },
      { key: 'sharePercent', header: 'Share', width: 70, align: 'right', value: (r) => (r.sharePercent === null ? '' : `${r.sharePercent.toFixed(1)}%`) },
    ],
    [],
  );
  return (
    <Card className={className} title="Top customers" padding="none">
      <DataTable<DashboardTopCustomer>
        aria-label="Top customers by sales"
        columns={columns}
        rows={s.topCustomers}
        getRowKey={(r) => String(r.ledgerId)}
        density="compact"
        onRowActivate={drill.can('reports.ledger') ? (r) => drill.open(DRILL.ledger(r.ledgerId, s.ranges.period)) : undefined}
        empty={<EmptyState size="sm" title="No credit sales in this period" body="Cash sales are not listed by customer. Change the period with Alt+F2." />}
      />
    </Card>
  );
}

export function TopItemsCard({ s, className }: { s: DashboardSummary; className?: string }) {
  const drill = useDrill();
  const columns = useMemo<Column<DashboardTopItem>[]>(
    () => [
      { key: 'name', header: 'Item', minWidth: 140 },
      { key: 'qty', header: 'Quantity', width: 110, align: 'right', value: (r) => formatQty(r.qty, Number.isInteger(r.qty) ? 0 : 2, r.unit || undefined) },
      { key: 'amount', header: 'Sales', kind: 'amount', width: 130 },
    ],
    [],
  );
  if (!s.features.inventory) return null;
  return (
    <Card className={className} title="Top items" padding="none">
      <DataTable<DashboardTopItem>
        aria-label="Top items by sales"
        columns={columns}
        rows={s.topItems}
        getRowKey={(r) => String(r.itemId)}
        density="compact"
        onRowActivate={drill.can('stock.item') ? (r) => drill.open(DRILL.stockItem(r.itemId)) : undefined}
        empty={<EmptyState size="sm" title="No items sold in this period" body="Item invoices (F8) show their items here." />}
      />
    </Card>
  );
}

export function LowStockCard({ s, className }: { s: DashboardSummary; className?: string }) {
  const drill = useDrill();
  const columns = useMemo<Column<DashboardLowStockItem>[]>(
    () => [
      { key: 'name', header: 'Item', minWidth: 140 },
      { key: 'onHand', header: 'In stock', width: 100, align: 'right', value: (r) => formatQty(r.onHand, Number.isInteger(r.onHand) ? 0 : 2, r.unit || undefined) },
      { key: 'reorderLevel', header: 'Reorder at', width: 100, align: 'right', value: (r) => formatQty(r.reorderLevel, Number.isInteger(r.reorderLevel) ? 0 : 2) },
      { key: 'shortfall', header: 'Short by', width: 90, align: 'right', value: (r) => formatQty(r.shortfall, Number.isInteger(r.shortfall) ? 0 : 2) },
    ],
    [],
  );
  if (!s.features.inventory) return null;
  const more = s.lowStock.count - s.lowStock.items.length;
  return (
    <Card className={className} title="Low stock" padding="none">
      <DataTable<DashboardLowStockItem>
        aria-label="Items below reorder level"
        columns={columns}
        rows={s.lowStock.items}
        getRowKey={(r) => String(r.itemId)}
        density="compact"
        onRowActivate={drill.can('stock.item') ? (r) => drill.open(DRILL.stockItem(r.itemId)) : undefined}
        empty={<EmptyState size="sm" title="Stock levels are fine" body="Set a reorder level on an item to be warned here." />}
      />
      {more > 0 ? <p className="bx-db__note">{plural(more, 'more item')} — open Reorder status to see all.</p> : null}
    </Card>
  );
}

/** Cancelled / Optional / Post-dated as words after the party. */
function flags(r: Pick<DashboardVoucherRow, 'isCancelled' | 'isOptional' | 'isPostDated'>): ReactNode {
  if (!r.isCancelled && !r.isOptional && !r.isPostDated) return null;
  return (
    <>
      {' '}
      {r.isCancelled ? <Badge tone="danger" size="sm">Cancelled</Badge> : null}
      {r.isOptional ? <Badge tone="neutral" size="sm">Optional</Badge> : null}
      {r.isPostDated ? <Badge tone="info" size="sm">Post-dated</Badge> : null}
    </>
  );
}

export function RecentVouchersCard({ s, className }: { s: DashboardSummary; className?: string }) {
  const drill = useDrill();
  const columns = useMemo<Column<DashboardVoucherRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 104 },
      { key: 'typeName', header: 'Voucher', width: 150, value: (r) => `${r.typeName}${r.number ? ` ${r.number}` : ''}` },
      {
        key: 'partyName',
        header: 'Party',
        minWidth: 120,
        render: (r) => (
          <span>
            {r.partyName ?? '—'}
            {flags(r)}
          </span>
        ),
      },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 120, blankZero: true },
    ],
    [],
  );
  return (
    <Card className={className} title="Recent vouchers" padding="none">
      <DataTable<DashboardVoucherRow>
        aria-label="Recently entered vouchers"
        columns={columns}
        rows={s.recentVouchers}
        getRowKey={(r) => String(r.id)}
        density="compact"
        onRowActivate={drill.can('vouchers.view') ? (r) => drill.open(DRILL.voucher(r.id)) : undefined}
        empty={<EmptyState size="sm" title="No vouchers yet" body="Vouchers you enter appear here." />}
      />
    </Card>
  );
}

export function PostDatedCard({ s, className }: { s: DashboardSummary; className?: string }) {
  const drill = useDrill();
  const columns = useMemo<Column<DashboardPdcRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 104 },
      { key: 'partyName', header: 'Party', minWidth: 120, value: (r) => r.partyName ?? r.typeName },
      { key: 'direction', header: 'In / out', width: 90, value: (r) => (r.direction === 'in' ? 'Receive' : 'Pay') },
      { key: 'instrumentNo', header: 'Cheque', width: 90, value: (r) => r.instrumentNo ?? '' },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 120 },
    ],
    [],
  );
  const p = s.postDated;
  return (
    <Card className={className} title="Post-dated cheques" subtitle={`To receive ${compact(p.inflow)} · to pay ${compact(p.outflow)}`} padding="none">
      <DataTable<DashboardPdcRow>
        aria-label="Upcoming post-dated cheques"
        columns={columns}
        rows={p.rows}
        getRowKey={(r) => String(r.id)}
        density="compact"
        onRowActivate={drill.can('vouchers.view') ? (r) => drill.open(DRILL.voucher(r.id)) : undefined}
        empty={<EmptyState size="sm" title="No post-dated cheques" body="Receipts and payments marked post-dated appear here until their date." />}
      />
      {p.count > p.rows.length ? <p className="bx-db__note">{plural(p.count - p.rows.length, 'more cheque')} — see All cheques.</p> : null}
    </Card>
  );
}


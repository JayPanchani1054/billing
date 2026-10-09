/**
 * Dashboard cards. Every card drills down: KPI tiles and alert rows are buttons, lists are DataTables
 * (Enter / double-click opens the row), chart months activate with Enter. Text wears text tokens; the
 * only colours are the chart / tone tokens of the UI kit.
 */
import { useEffect, useMemo, useState } from 'react';
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
import { useCan, useCompany, useFeatures, useNav, useShell } from '../../app/index.ts';
import { Badge, BarChart, Button, Card, Checkbox, DataTable, EmptyState, Icon, KeyValueList, KpiCard, ProgressBar, Skeleton } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import {
  ageingBars,
  balanceRange,
  buildAlerts,
  cashBankCaption,
  changeText,
  compact,
  compactSigned,
  DRILL,
  exact,
  flowKpi,
  gstDueLine,
  gstItems,
  parseStartPrefs,
  plural,
  salesSpark,
  signedKpi,
  startCardMode,
  startPrefsKey,
  startProgress,
  startSteps,
  toggleTicked,
  trendChart,
} from './lib/model.ts';
import type { DashboardAlert, DrillTarget, StartPrefs, StartStep } from './lib/model.ts';

export type DashboardLayout = 'full' | 'compact';

/**
 * Drill-downs that respect the viewer's permissions (nav.canOpen: screen access and feature). A
 * target the viewer may not open is not offered — tiles and rows are not clickable, "→" buttons are
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

// ───────────────────────────── KPI row ─────────────────────────────

export function KpiRow({ s, loading, layout, workingDate }: { s: DashboardSummary | undefined; loading: boolean; layout: DashboardLayout; workingDate?: string }) {
  const drill = useDrill();
  const sales = s ? flowKpi(s.sales, s.asOf, workingDate) : null;
  const purchases = s ? flowKpi(s.purchases, s.asOf, workingDate) : null;
  const period = s?.ranges.period;
  const purchaseChange = s ? changeText(purchases?.delta ?? null) : null;
  // A negative figure is relabelled, never shown with a bare minus.
  const salesK = signedKpi('Sales', sales?.value ?? 0, 'Sales returns (net)');
  const purchasesK = signedKpi('Purchases', purchases?.value ?? 0, 'Purchase returns (net)');
  const receivablesK = signedKpi('Receivables', s?.receivables.total ?? 0, 'Advances from customers');
  const payablesK = signedKpi('Payables', s?.payables.total ?? 0, 'Advances to suppliers');
  const cashBankK = signedKpi('Cash & bank', s ? s.cashBank.cashTotal + s.cashBank.bankTotal : 0, 'Cash & bank (overdrawn)');
  return (
    <div className="bx-db__kpis" role="group" aria-label="Key figures">
      <KpiCard
        label={salesK.label}
        icon="rupee"
        value={salesK.value}
        amount
        loading={loading}
        delta={sales && sales.delta !== null ? { value: sales.delta, label: 'vs last year', goodWhen: 'up' } : undefined}
        caption={sales ? (sales.delta === null ? sales.comparison : sales.caption) : undefined}
        sparkline={s ? salesSpark(s.trend) : undefined}
        onClick={period ? drill.to(DRILL.salesRegister(period)) : undefined}
      />
      {layout === 'full' ? (
        <KpiCard
          label={purchasesK.label}
          icon="cart"
          value={purchasesK.value}
          amount
          loading={loading}
          caption={purchases ? `${purchases.comparison}${purchaseChange && purchaseChange !== 'no change' ? ` (${purchaseChange})` : ''}` : undefined}
          onClick={period ? drill.to(DRILL.purchaseRegister(period)) : undefined}
        />
      ) : null}
      {s?.grossProfit ? (
        <KpiCard
          label={s.grossProfit.amount < 0 ? 'Gross loss' : 'Gross profit'}
          icon="chart"
          value={Math.abs(s.grossProfit.amount)}
          amount
          loading={loading}
          caption={
            s.grossProfit.marginPercent === null
              ? 'No sales in this period'
              : `Margin ${s.grossProfit.marginPercent.toFixed(1)}%${s.grossProfit.method === 'purchases' ? ' · sales − purchases' : ''}`
          }
          onClick={period ? drill.to(DRILL.profitLoss(period)) : undefined}
        />
      ) : null}
      <KpiCard
        label={receivablesK.label}
        icon="users"
        value={receivablesK.value}
        amount
        loading={loading}
        caption={s ? (s.receivables.overdue > 0 ? `${compact(s.receivables.overdue)} overdue` : 'Nothing overdue') : undefined}
        onClick={drill.to(DRILL.receivables())}
      />
      <KpiCard
        label={payablesK.label}
        icon="truck"
        value={payablesK.value}
        amount
        loading={loading}
        caption={s ? (s.payables.dueSoon.count > 0 ? `${compact(s.payables.dueSoon.amount)} due in ${s.payables.dueSoon.days} days` : `Nothing due in ${s.payables.dueSoon.days} days`) : undefined}
        onClick={drill.to(DRILL.payables())}
      />
      <KpiCard
        label={cashBankK.label}
        icon="wallet"
        value={cashBankK.value}
        amount
        loading={loading}
        caption={s ? cashBankCaption(s.cashBank) : undefined}
        onClick={s ? drill.to(DRILL.cashBank(balanceRange(s))) : undefined}
      />
    </div>
  );
}

// ───────────────────────────── Alerts ─────────────────────────────

export function AlertsCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
  const drill = useDrill();
  const alerts = useMemo(() => (s ? buildAlerts(s, { canOpen: drill.can }) : []), [s, drill.can]);
  return (
    <Card
      className={className}
      title="Needs your attention"
      padding="sm"
      actions={alerts.length > 0 ? <Badge tone={alerts.some((a) => a.tone === 'danger') ? 'danger' : 'warning'} size="sm">{alerts.length}</Badge> : undefined}
    >
      {loading && !s ? (
        <Skeleton lines={3} />
      ) : alerts.length === 0 ? (
        <p className="bx-db-allclear">
          <Icon name="check-circle" size="sm" className="bx-db-allclear__icon" />
          All clear — nothing overdue, low or pending.
        </p>
      ) : (
        <ul className="bx-db-alerts" aria-label="Alerts">
          {alerts.map((a) => (
            <li key={a.id}>
              {a.target ? (
                <button type="button" className="bx-db-alert" onClick={drill.to(a.target)}>
                  <AlertContent a={a} />
                  <Icon name="chevron-right" size="sm" className="bx-db-alert__chevron" />
                </button>
              ) : (
                <div className="bx-db-alert is-static">
                  <AlertContent a={a} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AlertContent({ a }: { a: DashboardAlert }) {
  return (
    <>
      <span className={`bx-db-alert__icon bx-db-alert__icon--${a.tone}`}>
        <Icon name={a.icon} size="sm" label={a.tone === 'danger' ? 'Urgent' : a.tone === 'warning' ? 'Warning' : 'Note'} />
      </span>
      <span>
        <span className="bx-db-alert__title">{a.title}</span>
        <span className="bx-db-alert__body">{a.body}</span>
      </span>
    </>
  );
}

// ───────────────────────────── Trend ─────────────────────────────

export function TrendCard({ s, loading, layout, className }: { s: DashboardSummary | undefined; loading: boolean; layout: DashboardLayout; className?: string }) {
  const drill = useDrill();
  const chart = useMemo(() => (s ? trendChart(s.trend) : null), [s]);
  const title = 'Sales and purchases — last 12 months';
  return (
    <Card
      className={className}
      title={title}
      subtitle="Net of returns, before GST"
      padding="sm"
      actions={
        s && drill.can('reports.register') ? (
          <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={drill.to(DRILL.salesRegister(s.ranges.period))}>
            Sales register
          </Button>
        ) : undefined
      }
    >
      {loading && !s ? (
        <Skeleton variant="rect" height={layout === 'full' ? 260 : 190} />
      ) : chart && s ? (
        <BarChart
          title={title}
          description={chart.description}
          categories={chart.categories}
          series={chart.series}
          valueFormat="inr"
          height={layout === 'full' ? 260 : 190}
          onCategoryActivate={
            drill.can('reports.register')
              ? (i) => {
                  const m = s.trend[i];
                  if (m) drill.open(DRILL.salesRegister({ from: m.from, to: m.to }));
                }
              : undefined
          }
          empty={chart.empty ? <EmptyState size="sm" icon="chart" title="No sales or purchases yet" body="Press F8 for a sales invoice or F9 for a purchase." /> : undefined}
        />
      ) : null}
    </Card>
  );
}

// ───────────────────────────── Receivables ageing ─────────────────────────────

export function AgeingCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
  const drill = useDrill();
  const r = s?.receivables;
  const bars = useMemo(() => (r ? ageingBars(r.ageing) : []), [r]);
  return (
    <Card
      className={className}
      title="Receivables ageing"
      subtitle="By due date"
      padding="sm"
      actions={
        drill.can('outstanding.receivables') ? (
          <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={drill.to(DRILL.receivablesAgeing())}>
            Ageing
          </Button>
        ) : undefined
      }
    >
      {loading && !r ? (
        <Skeleton lines={6} />
      ) : r ? (
        <>
          <p className="bx-db__figures">
            <span>
              {r.total < 0 ? 'Net advance' : 'Total'} <strong>{compact(Math.abs(r.total))}</strong>
            </span>
            <span>
              Overdue <strong>{compact(r.overdue)}</strong>
            </span>
            <span>{plural(r.partyCount, 'customer')}</span>
          </p>
          {r.total === 0 && bars.every((b) => b.amount === 0) ? (
            <EmptyState size="sm" icon="check-circle" title="Nothing to collect" body="No customer owes you money on this date." />
          ) : (
            <ul className="bx-db-age" aria-label="Receivables by age">
              {bars.map((b) => (
                <li key={b.index}>
                  <button
                    type="button"
                    className="bx-db-age__row"
                    aria-label={`${b.label}: ${exact(b.amount)}${b.overdue ? ' overdue' : ''}`}
                    disabled={!drill.can('outstanding.receivables')}
                    onClick={drill.to(b.overdue ? DRILL.receivablesAgeing() : DRILL.receivables())}
                  >
                    <span className="bx-db-age__label">{b.label}</span>
                    <span className="bx-db-age__track" aria-hidden="true">
                      <span className={`bx-db-age__fill${b.overdue ? ' is-overdue' : ''}`} style={{ display: 'block', width: `${b.percent}%` }} />
                    </span>
                    <span className="bx-db-age__amount" title={exact(b.amount)}>
                      {b.amount === 0 ? '–' : compactSigned(b.amount, 'credit')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {r.advance !== 0 || r.onAccount !== 0 ? (
            <p className="bx-db__note">
              Also: advances {compact(Math.abs(r.advance))} · on account {compactSigned(r.onAccount, 'credit')} (not aged).
            </p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

// ───────────────────────────── Cash & bank ─────────────────────────────

interface CashBankRow extends DashboardBalanceRow {
  kind: 'cash' | 'bank';
}

export function CashBankCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
  const drill = useDrill();
  const rows = useMemo<CashBankRow[]>(
    () => (s ? [...s.cashBank.cash.map((r) => ({ ...r, kind: 'cash' as const })), ...s.cashBank.banks.map((r) => ({ ...r, kind: 'bank' as const }))] : []),
    [s],
  );
  const columns = useMemo<Column<CashBankRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Account',
        minWidth: 140,
        render: (r) => (
          <span>
            {r.name}
            {r.accountTail ? <span className="bx-muted"> ··{r.accountTail}</span> : null}
            {r.isOverdraft ? <span className="bx-muted"> (OD)</span> : null}
          </span>
        ),
      },
      { key: 'balance', header: 'Balance', kind: 'drcr', width: 150 },
    ],
    [],
  );
  return (
    <Card
      className={className}
      title="Cash & bank"
      subtitle={s ? `As on ${formatDate(s.asOf)}` : undefined}
      padding="sm"
      actions={
        s && drill.can('reports.cashBank') ? (
          <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={drill.to(DRILL.cashBank(balanceRange(s)))}>
            Cash/Bank books
          </Button>
        ) : undefined
      }
    >
      <DataTable<CashBankRow>
        aria-label="Cash and bank balances"
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.ledgerId)}
        loading={loading && !s}
        skeletonRows={3}
        density="compact"
        onRowActivate={drill.can('reports.ledger') ? (r) => drill.open(DRILL.ledger(r.ledgerId, s ? balanceRange(s) : undefined)) : undefined}
        footerRows={s && rows.length > 1 ? [{ key: 'total', cells: { name: 'Total', balance: formatDrCr(s.cashBank.cashTotal + s.cashBank.bankTotal) } }] : undefined}
        empty={<EmptyState size="sm" icon="bank" title="No cash or bank accounts" body="Create a ledger under Bank Accounts to see its balance here." />}
      />
    </Card>
  );
}

// ───────────────────────────── GST ─────────────────────────────

export function GstCard({ s, className }: { s: DashboardSummary | undefined; className?: string }) {
  const drill = useDrill();
  const g = s?.gst;
  const due = s?.gstDue ?? null;
  if (!s || (!g && !due)) return null;
  const main = due ?? g;
  return (
    <Card
      className={className}
      title="GST"
      subtitle="Estimate from your books"
      padding="sm"
      actions={
        main && drill.can('gst.gstr3b') ? (
          <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={drill.to(DRILL.gstr3b(main.period))}>
            GSTR-3B
          </Button>
        ) : undefined
      }
    >
      {due ? (
        <section className="bx-db-gst" aria-label={`GST return for ${due.label}`}>
          <p className="bx-db-gst__head">
            <strong>{due.label} return</strong> · {gstDueLine(due, s.asOf)}
          </p>
          <KeyValueList layout="inline" alignValues="right" items={gstItems(due)} />
        </section>
      ) : null}
      {g ? (
        <section className="bx-db-gst" aria-label={`GST for ${g.label} so far`}>
          <p className="bx-db-gst__head">
            <strong>{g.label} so far</strong> · {g.dueForm} due by {formatDate(g.dueDate)}
          </p>
          <KeyValueList layout="inline" alignValues="right" items={gstItems(g)} />
          <p className="bx-db__note">{plural(g.documentCount, 'GST document')} this month so far. Interest and late fee are not included.</p>
        </section>
      ) : null}
    </Card>
  );
}

// ───────────────────────────── Top lists ─────────────────────────────

export function TopCustomersCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
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
    <Card className={className} title="Top customers" subtitle="By sales in the period" padding="sm">
      <DataTable<DashboardTopCustomer>
        aria-label="Top customers by sales"
        columns={columns}
        rows={s?.topCustomers ?? []}
        getRowKey={(r) => String(r.ledgerId)}
        loading={loading && !s}
        skeletonRows={5}
        density="compact"
        onRowActivate={drill.can('reports.ledger') ? (r) => drill.open(DRILL.ledger(r.ledgerId, s?.ranges.period)) : undefined}
        empty={<EmptyState size="sm" icon="users" title="No credit sales in this period" body="Cash sales are not listed by customer. Change the period with Alt+F2." />}
      />
    </Card>
  );
}

export function TopItemsCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
  const drill = useDrill();
  const columns = useMemo<Column<DashboardTopItem>[]>(
    () => [
      { key: 'name', header: 'Item', minWidth: 140 },
      { key: 'qty', header: 'Quantity', width: 110, align: 'right', value: (r) => formatQty(r.qty, Number.isInteger(r.qty) ? 0 : 2, r.unit || undefined) },
      { key: 'amount', header: 'Sales', kind: 'amount', width: 130 },
    ],
    [],
  );
  if (s && !s.features.inventory) return null;
  return (
    <Card className={className} title="Top items" subtitle="By sales value in the period" padding="sm">
      <DataTable<DashboardTopItem>
        aria-label="Top items by sales"
        columns={columns}
        rows={s?.topItems ?? []}
        getRowKey={(r) => String(r.itemId)}
        loading={loading && !s}
        skeletonRows={5}
        density="compact"
        onRowActivate={drill.can('stock.item') ? (r) => drill.open(DRILL.stockItem(r.itemId)) : undefined}
        empty={<EmptyState size="sm" icon="box" title="No items sold in this period" body="Item invoices (F8) show their items here." />}
      />
    </Card>
  );
}

export function LowStockCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
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
  if (s && !s.features.inventory) return null;
  const more = s ? s.lowStock.count - s.lowStock.items.length : 0;
  return (
    <Card
      className={className}
      title="Low stock"
      subtitle="Below the reorder level"
      padding="sm"
      actions={
        drill.can('stock.reorder') ? (
          <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={drill.to(DRILL.reorder())}>
            Reorder status
          </Button>
        ) : undefined
      }
    >
      <DataTable<DashboardLowStockItem>
        aria-label="Items below reorder level"
        columns={columns}
        rows={s?.lowStock.items ?? []}
        getRowKey={(r) => String(r.itemId)}
        loading={loading && !s}
        skeletonRows={3}
        density="compact"
        onRowActivate={drill.can('stock.item') ? (r) => drill.open(DRILL.stockItem(r.itemId)) : undefined}
        empty={<EmptyState size="sm" icon="check-circle" title="Stock levels are fine" body="Set a reorder level on an item to be warned here." />}
      />
      {more > 0 ? <p className="bx-db__note">{plural(more, 'more item')} — open Reorder status to see all.</p> : null}
    </Card>
  );
}

// ───────────────────────────── Vouchers ─────────────────────────────

function VoucherFlags({ r }: { r: Pick<DashboardVoucherRow, 'isCancelled' | 'isOptional' | 'isPostDated'> }) {
  if (!r.isCancelled && !r.isOptional && !r.isPostDated) return null;
  return (
    <span className="bx-db-flags">
      {r.isCancelled ? <Badge tone="danger" size="sm">Cancelled</Badge> : null}
      {r.isOptional ? <Badge tone="neutral" size="sm">Optional</Badge> : null}
      {r.isPostDated ? <Badge tone="info" size="sm">Post-dated</Badge> : null}
    </span>
  );
}

export function RecentVouchersCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
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
            {r.partyName ?? <span className="bx-muted">—</span>} <VoucherFlags r={r} />
          </span>
        ),
      },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 120, blankZero: true },
    ],
    [],
  );
  return (
    <Card
      className={className}
      title="Recent vouchers"
      subtitle="Last entered"
      padding="sm"
      actions={
        s && drill.can('vouchers.daybook') ? (
          <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={drill.to(DRILL.dayBook(s.ranges.today))}>
            Day Book
          </Button>
        ) : undefined
      }
    >
      <DataTable<DashboardVoucherRow>
        aria-label="Recently entered vouchers"
        columns={columns}
        rows={s?.recentVouchers ?? []}
        getRowKey={(r) => String(r.id)}
        loading={loading && !s}
        skeletonRows={5}
        density="compact"
        onRowActivate={drill.can('vouchers.view') ? (r) => drill.open(DRILL.voucher(r.id)) : undefined}
        empty={<EmptyState size="sm" icon="journal" title="No vouchers yet" body="Vouchers you enter appear here." />}
      />
    </Card>
  );
}

export function PostDatedCard({ s, loading, className }: { s: DashboardSummary | undefined; loading: boolean; className?: string }) {
  const drill = useDrill();
  const columns = useMemo<Column<DashboardPdcRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 104 },
      { key: 'partyName', header: 'Party', minWidth: 120, value: (r) => r.partyName ?? r.typeName },
      {
        key: 'direction',
        header: 'In / out',
        width: 90,
        value: (r) => (r.direction === 'in' ? 'Receive' : 'Pay'),
        render: (r) => (
          <span className="bx-db-dir">
            <Icon name={r.direction === 'in' ? 'arrow-down' : 'arrow-up'} size="xs" />
            {r.direction === 'in' ? 'Receive' : 'Pay'}
          </span>
        ),
      },
      { key: 'instrumentNo', header: 'Cheque', width: 90, value: (r) => r.instrumentNo ?? '' },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 120 },
    ],
    [],
  );
  const p = s?.postDated;
  return (
    <Card
      className={className}
      title="Post-dated cheques"
      subtitle={p ? `To receive ${compact(p.inflow)} · to pay ${compact(p.outflow)}` : undefined}
      padding="sm"
      actions={
        drill.can('banking.pdc') ? (
          <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={drill.to(DRILL.pdc())}>
            All cheques
          </Button>
        ) : undefined
      }
    >
      <DataTable<DashboardPdcRow>
        aria-label="Upcoming post-dated cheques"
        columns={columns}
        rows={p?.rows ?? []}
        getRowKey={(r) => String(r.id)}
        loading={loading && !s}
        skeletonRows={3}
        density="compact"
        onRowActivate={drill.can('vouchers.view') ? (r) => drill.open(DRILL.voucher(r.id)) : undefined}
        empty={<EmptyState size="sm" icon="calendar" title="No post-dated cheques" body="Receipts and payments marked post-dated appear here until their date." />}
      />
      {p && p.count > p.rows.length ? <p className="bx-db__note">{plural(p.count - p.rows.length, 'more cheque')} — see All cheques.</p> : null}
    </Card>
  );
}

// ───────────────────────────── Getting started ─────────────────────────────

function loadStartPrefs(companyId: string): StartPrefs {
  try {
    return parseStartPrefs(window.localStorage.getItem(startPrefsKey(companyId)));
  } catch {
    return parseStartPrefs(null);
  }
}

function saveStartPrefs(companyId: string, prefs: StartPrefs): void {
  try {
    window.localStorage.setItem(startPrefsKey(companyId), JSON.stringify(prefs));
  } catch {
    // not remembered (storage blocked)
  }
}

/**
 * The company's getting-started steps (lib/model.ts startSteps — the app's one onboarding list) and
 * whether the card shows (startCardMode). Hide and "Mark as done" are remembered per company.
 */
export function useStartSteps(s: DashboardSummary | undefined): {
  steps: StartStep[];
  mode: 'steps' | 'empty' | null;
  hide: () => void;
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
  useEffect(() => setPrefs(loadStartPrefs(companyId)), [companyId]);
  const update = (next: (p: StartPrefs) => StartPrefs) =>
    setPrefs((p) => {
      const v = next(p);
      saveStartPrefs(companyId, v);
      return v;
    });
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
    tick: (id, on) => update((p) => toggleTicked(p, id, on)),
  };
}

export function GettingStarted({ s, className }: { s: DashboardSummary | undefined; className?: string }) {
  const shell = useShell();
  const drill = useDrill();
  const { steps, mode, hide, tick } = useStartSteps(s);
  if (mode === null) return null;
  if (mode === 'empty') {
    return (
      <Card className={className} padding="md" title="Get started">
        <EmptyState size="sm" icon="chart" title="Nothing recorded yet" body="Figures appear here once vouchers are entered. Ask the company owner if you need to enter them yourself." />
      </Card>
    );
  }
  const progress = startProgress(steps);
  return (
    <Card
      className={className}
      padding="md"
      title="Get started"
      subtitle={progress.total > 0 ? `${progress.done} of ${progress.total} done · steps tick themselves off as you complete them` : 'Your dashboard fills up as you record sales, purchases and receipts.'}
      actions={
        <Button size="sm" variant="ghost" onClick={hide}>
          Hide
        </Button>
      }
    >
      {progress.total > 0 ? <ProgressBar value={progress.done} max={progress.total} aria-label="Getting started progress" /> : null}
      <ol className="bx-db-start" aria-label="First steps">
        {steps.map((st, i) => (
          <li key={st.id} className={st.done ? 'bx-db-start__step is-done' : 'bx-db-start__step'}>
            <span className="bx-db-start__num" aria-hidden="true">
              {st.done ? <Icon name="check" size="sm" /> : i + 1}
            </span>
            <span className="bx-db-start__text">
              <span className="bx-db-start__title">
                {st.title}
                {st.optional ? <span className="bx-muted"> (optional)</span> : null}
              </span>
              <span className="bx-db-start__body">{st.body}</span>
              {st.optional ? null : (
                <Checkbox
                  className="bx-db-start__tick"
                  label={st.doneFromBooks ? 'Done' : 'Mark as done'}
                  checked={st.done}
                  disabled={st.doneFromBooks}
                  onChange={(on) => tick(st.id, on)}
                  aria-label={st.doneFromBooks ? `“${st.title}” is done` : `Mark “${st.title}” as done`}
                />
              )}
            </span>
            <Button
              size="sm"
              variant={st.done ? 'ghost' : st.target === 'sales-voucher' ? 'primary' : 'secondary'}
              shortcut={st.shortcut}
              onClick={() => {
                const t = st.target;
                if (t === 'sales-voucher') shell.openVoucher('sales');
                else drill.open(t);
              }}
            >
              {st.action}
            </Button>
          </li>
        ))}
      </ol>
    </Card>
  );
}

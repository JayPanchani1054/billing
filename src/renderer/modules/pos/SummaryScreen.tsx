/**
 * 'pos.summary' — day-end POS summary: net sales, cash for the drawer (with an opening float and a
 * counted-cash check), credit, GST, then by tender (Ctrl+1), cashier (Ctrl+2), counter (Ctrl+3) and
 * the bills and returns themselves (Ctrl+4; Enter opens the voucher). Ctrl+5 the working date /
 * Ctrl+6 the report period (Alt+F2). Export (Alt+E) and Print (Alt+P) through the shared export path.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { PosRegisterRow, PosSummaryCounterRow, PosSummaryTenderRow, PosSummaryUserRow } from '../../../shared/types/pos.ts';
import { POS_TENDER_KIND_LABELS } from '../../../shared/types/pos.ts';
import { ReportScreen, useApiQuery, useFeatures, useNav, usePeriod, useWorkingDate } from '../../app/index.ts';
import { AmountInput, Badge, DataTable, EmptyState, Field, Grid, Inline, KpiCard, SegmentedControl, Stack } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { PosOff } from './components.tsx';
import { drawerDifference, drillCounter, drillTender, drillUser, expectedDrawer, signed, summaryExport, summaryTiles, SUMMARY_VIEWS, type SummaryDrill, type SummaryView } from './lib/summary.ts';

const rupees = (p: Paise): string => `₹ ${formatMoney(p)}`;

export function SummaryScreen() {
  const features = useFeatures();
  if (!features.pos) return <PosOff title="POS Day-end Summary" />;
  return <Summary />;
}

function Summary() {
  const nav = useNav();
  const { date } = useWorkingDate();
  const period = usePeriod();
  const [span, setSpan] = useState<'day' | 'period'>('day');
  const [view, setViewRaw] = useState<SummaryView>('tender');
  // Enter on a tender / cashier / counter row: the bills behind it (cleared by choosing a view).
  const [drill, setDrill] = useState<SummaryDrill | null>(null);
  const setView = (v: SummaryView): void => {
    setDrill(null);
    setViewRaw(v);
  };
  const openDrill = (d: SummaryDrill): void => {
    setDrill(d);
    setViewRaw('bills');
  };
  const [float, setFloat] = useState<Paise | null>(null);
  const [counted, setCounted] = useState<Paise | null>(null);
  const range = span === 'day' ? { from: date, to: date } : { from: period.from, to: period.to };
  const q = useApiQuery('pos.summary', range, { keepPrevious: true });
  const regQ = useApiQuery('pos.register', { ...range, ...(drill?.filter ?? {}), limit: 1000 }, { enabled: view === 'bills', keepPrevious: true });
  const s = q.data;
  const reg = regQ.data;

  const tenderCols = useMemo<Column<PosSummaryTenderRow>[]>(
    () => [
      { key: 'name', header: 'Tender' },
      { key: 'kind', header: 'Kind', width: 120, value: (r) => POS_TENDER_KIND_LABELS[r.kind] },
      { key: 'ledgerName', header: 'Ledger', width: 220 },
      { key: 'received', header: 'Received', kind: 'amount', width: 130, total: true },
      { key: 'refunded', header: 'Refunded', kind: 'amount', width: 130, total: true, blankZero: true },
      { key: 'net', header: 'Net', kind: 'amount', width: 130, total: true },
      { key: 'count', header: 'Bills', kind: 'number', width: 70 },
    ],
    [],
  );
  const userCols = useMemo<Column<PosSummaryUserRow>[]>(
    () => [
      { key: 'userName', header: 'Cashier' },
      { key: 'bills', header: 'Bills', kind: 'number', width: 80, total: true },
      { key: 'sales', header: 'Sales', kind: 'amount', width: 140, total: true },
      { key: 'returns', header: 'Returns', kind: 'number', width: 80, total: true },
      { key: 'returnValue', header: 'Return value', kind: 'amount', width: 140, total: true, blankZero: true },
      { key: 'net', header: 'Net', kind: 'amount', width: 140, total: true },
    ],
    [],
  );
  const counterCols = useMemo<Column<PosSummaryCounterRow>[]>(
    () => [
      { key: 'counter', header: 'Counter', value: (r) => r.counter || '(not named)' },
      { key: 'bills', header: 'Bills', kind: 'number', width: 80, total: true },
      { key: 'sales', header: 'Sales', kind: 'amount', width: 140, total: true },
      { key: 'returnValue', header: 'Return value', kind: 'amount', width: 140, total: true, blankZero: true },
      { key: 'net', header: 'Net', kind: 'amount', width: 140, total: true },
    ],
    [],
  );
  const billCols = useMemo<Column<PosRegisterRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 100 },
      {
        key: 'number',
        header: 'No.',
        width: 150,
        render: (r) => (
          <Inline gap={1}>
            <span>{r.number ?? ''}</span>
            {r.kind === 'return' ? <Badge size="sm" tone="warning">Return{r.returnOf?.number ? ` of ${r.returnOf.number}` : ''}</Badge> : null}
          </Inline>
        ),
      },
      { key: 'partyName', header: 'Customer', minWidth: 160, value: (r) => r.partyName ?? '' },
      { key: 'billValue', header: 'Value', kind: 'amount', width: 120, value: (r) => signed(r) },
      { key: 'credit', header: 'On account', kind: 'amount', width: 120, value: (r) => signed(r, 'credit'), blankZero: true },
      { key: 'tenders', header: 'Paid by', minWidth: 200 },
      { key: 'counter', header: 'Counter', width: 100, value: (r) => r.counter ?? '' },
      { key: 'userName', header: 'Cashier', width: 120, value: (r) => r.userName ?? '' },
    ],
    [],
  );

  const expected = s ? expectedDrawer(s, float ?? 0) : 0;
  const diff = drawerDifference(counted, expected);
  const viewActions = SUMMARY_VIEWS.map((v, i) => ({ key: `Ctrl+${i + 1}`, label: v.label, onClick: () => setView(v.view), group: 'view' }));

  return (
    <ReportScreen
      title="POS Day-end Summary"
      subtitle={[span === 'day' ? `For ${formatDate(date)} (working date, F2)` : null, drill && view === 'bills' ? drill.label : null].filter(Boolean).join(' · ') || undefined}
      periodMode={span === 'day' ? 'none' : 'range'}
      loading={q.loading && !s}
      refreshing={q.refreshing || regQ.refreshing}
      error={q.error ?? regQ.error}
      onRetry={() => void (q.refetch(), regQ.refetch())}
      filters={
        <Inline gap={2}>
          <SegmentedControl<'day' | 'period'>
            aria-label="Span"
            size="sm"
            value={span}
            onChange={setSpan}
            options={[
              { value: 'day', label: 'Working date' },
              { value: 'period', label: 'Period' },
            ]}
          />
          <SegmentedControl<SummaryView> aria-label="View" size="sm" value={view} onChange={setView} options={SUMMARY_VIEWS.map((v) => ({ value: v.view, label: v.label }))} />
        </Inline>
      }
      exportDef={() => {
        if (!s) return { columns: [], rows: [] };
        const def = summaryExport(s, view, reg);
        return drill && view === 'bills' ? { ...def, title: `${def.title} — ${drill.label}` } : def;
      }}
      actions={[
        ...viewActions,
        { key: 'Ctrl+5', label: 'Working date', onClick: () => setSpan('day'), group: 'span' },
        { key: 'Ctrl+6', label: 'Report period', onClick: () => setSpan('period'), group: 'span' },
        { key: 'Alt+B', label: 'POS counter', icon: 'cart', onClick: () => nav.push('pos.counter'), group: 'go' },
      ]}
      hint="Ctrl+1 By tender · Ctrl+2 By cashier · Ctrl+3 By counter · Ctrl+4 Bills · Enter Open voucher · Alt+E Export · Alt+P Print · Esc Back"
    >
      {s ? (
        <Stack gap={3}>
          <Grid columns={4} gap={3}>
            {summaryTiles(s).map((t) => (
              <KpiCard key={t.label} label={t.label} value={rupees(t.value)} caption={t.caption} />
            ))}
          </Grid>
          <Inline gap={3} align="end" className="pos-drawer">
            <Field label="Opening float" htmlFor="pos-float" hint="Cash kept in the drawer at the start of the day.">
              <AmountInput id="pos-float" value={float} onChange={setFloat} symbol />
            </Field>
            <Field label="Cash counted" htmlFor="pos-counted" hint={`Expected ${rupees(expected)} (float + cash received − refunded).`}>
              <AmountInput id="pos-counted" value={counted} onChange={setCounted} symbol />
            </Field>
            {diff !== null ? (
              <Badge tone={diff === 0 ? 'success' : 'warning'}>{diff === 0 ? 'Cash tallies' : diff > 0 ? `Excess ${rupees(diff)}` : `Short ${rupees(-diff)}`}</Badge>
            ) : null}
            <span className="bx-muted">
              {s.bills} bills · {s.returns} returns · change given {rupees(s.changeGiven)}
              {s.exchangeIssued || s.exchangeUsed ? ` · exchange credit issued ${rupees(s.exchangeIssued)}, used ${rupees(s.exchangeUsed)}` : ''}
              {s.mrpSavings ? ` · customers saved ${rupees(s.mrpSavings)} on MRP` : ''}
            </span>
          </Inline>
          {view === 'tender' ? (
            <DataTable<PosSummaryTenderRow>
              aria-label="By tender"
              autoFocus
              columns={tenderCols}
              rows={s.byTender}
              getRowKey={(r) => String(r.modeId)}
              onRowActivate={(r) => openDrill(drillTender(r))}
              empty={<EmptyState title="No POS bills" body="Bills saved on the POS counter (Alt+B) appear here." />}
            />
          ) : view === 'user' ? (
            <DataTable<PosSummaryUserRow> aria-label="By cashier" autoFocus columns={userCols} rows={s.byUser} getRowKey={(r) => String(r.userId ?? 0)} onRowActivate={(r) => openDrill(drillUser(r))} />
          ) : view === 'counter' ? (
            <DataTable<PosSummaryCounterRow> aria-label="By counter" autoFocus columns={counterCols} rows={s.byCounter} getRowKey={(r) => r.counter || '-'} onRowActivate={(r) => openDrill(drillCounter(r))} />
          ) : (
            <DataTable<PosRegisterRow>
              aria-label="Bills and returns"
              autoFocus
              columns={billCols}
              rows={reg?.rows ?? []}
              loading={regQ.loading}
              getRowKey={(r) => String(r.voucherId)}
              onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
              footerRows={
                reg
                  ? [{ key: 'sum', cells: { partyName: reg.total > reg.rows.length ? `Total (${reg.total}; first ${reg.rows.length} listed — narrow the period)` : `Total (${reg.total})`, billValue: reg.sums.billValue, credit: reg.sums.credit } }]
                  : undefined
              }
              empty={<EmptyState title="No POS bills or returns" body="Change the date (F2) or the period." />}
            />
          )}
        </Stack>
      ) : null}
    </ReportScreen>
  );
}

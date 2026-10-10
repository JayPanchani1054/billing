/**
 * mfg reports.
 *
 *   'mfg.production'       Production Register for the period (Alt+F2): Manufacturing Journals and finished
 *                          goods received from job workers with the stock engine's own values (components
 *                          consumed, additional cost, by-products, cost of production, rate) and the BOM
 *                          estimate at today's cost. Enter view · Alt+A alter · Ctrl+1/2/3 kind · Alt+E export.
 *   'mfg.jobWork.pending'  {direction?} goods with job workers (or principals' goods with us) as on the
 *                          period's end, challan by challan (FIFO), with the CGST s.143 return dates.
 *                          Enter view the challan · Alt+I Material In for the party · Ctrl+1/2 out / in ·
 *                          Ctrl+3 only overdue / due soon · Alt+E export.
 *   'mfg.itc04'            ITC-04 for a period (half-yearly above ₹5 crore AATO, else annual): table 4 and
 *                          tables 5A / 5B / 5C as clean CSV / Excel layouts. Ctrl+1 table 4 · Ctrl+2 tables 5 ·
 *                          Ctrl+3 AATO above ₹5 crore · Alt+E export (CSV).
 */
import { useEffect, useMemo, useState } from 'react';
import { addMonths, formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Itc04ReturnRow, Itc04SentRow, PendingJobWorkRow, ProductionRegisterRow, StockJournalClass } from '../../../shared/types/mfg.ts';
import { ReportScreen, Screen, useApiQuery, useCan, useCompany, useFeatures, useNav, usePeriod, useWorkingDate } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, DataTable, EmptyState, Field, SegmentedControl, Select, Stack, Switch } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { CLASS_LABEL, goodsTypeLabel, itc04ReturnedExport, itc04SentExport, itc04Title, pendingJobWorkExport, productionExport, returnStatusText, STATUS_TONE } from './lib/model.ts';

// ───────────────────────────── Production Register ─────────────────────────────

type KindFilter = 'all' | 'manufacturing' | 'material_in';

export function ProductionRegisterScreen({ params }: ScreenProps<{ itemId?: number; bomId?: number }>) {
  const { from, to } = usePeriod();
  const nav = useNav();
  const features = useFeatures();
  const canAlter = useCan('vouchers.alter');
  const [kind, setKind] = useState<KindFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const on = features.manufacturing || features.jobWork;
  const q = useApiQuery(
    'mfg.production.register',
    { from, to, ...(params.itemId !== undefined ? { itemId: params.itemId } : {}), ...(params.bomId !== undefined ? { bomId: params.bomId } : {}), ...(kind === 'all' ? {} : { class: kind as StockJournalClass }) },
    { keepPrevious: true, enabled: on },
  );
  const data = q.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const current = rows.find((r) => String(r.voucherId) === selected) ?? rows[0] ?? null;
  const columns = useMemo<Column<ProductionRegisterRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 105, sortable: true },
      { key: 'number', header: 'Voucher', width: 150, value: (r) => `${r.typeName} ${r.number ?? ''}`.trim() },
      { key: 'itemName', header: 'Finished item', minWidth: 170, value: (r) => r.itemName ?? '', sortable: true },
      { key: 'qty', header: 'Quantity', kind: 'qty', width: 120, render: (r) => `${r.qty} ${r.unit ?? ''}` },
      { key: 'bomName', header: 'BOM / job worker', minWidth: 140, value: (r) => r.partyName ?? r.bomName ?? '' },
      { key: 'consumed', header: 'Components', kind: 'amount', width: 130, total: true },
      { key: 'additional', header: 'Additional', kind: 'amount', width: 120, total: true, blankZero: true },
      { key: 'byProducts', header: 'By-products', kind: 'amount', width: 120, total: true, blankZero: true },
      { key: 'productValue', header: 'Cost of production', kind: 'amount', width: 150, total: true },
      { key: 'productRate', header: 'Rate', kind: 'number', decimals: 2, width: 100 },
      { key: 'bomEstimate', header: 'BOM estimate today', kind: 'amount', width: 150, value: (r) => r.bomEstimate ?? 0, blankZero: true },
    ],
    [],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'All production', icon: 'filter', onClick: () => setKind('all'), disabled: kind === 'all', group: 'view' },
    { key: 'Ctrl+2', label: 'Manufacturing Journals', icon: 'filter', onClick: () => setKind('manufacturing'), disabled: kind === 'manufacturing', group: 'view' },
    { key: 'Ctrl+3', label: 'Received from job workers', icon: 'filter', onClick: () => setKind('material_in'), disabled: kind === 'material_in', group: 'view' },
    { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => current && nav.push('mfg.journal.entry', { id: current.voucherId }), disabled: !current, hidden: !canAlter },
    { key: 'Alt+C', label: 'Create Manufacturing Journal', icon: 'plus', onClick: () => nav.push('mfg.journal.entry', { cls: 'manufacturing' }), hidden: !features.manufacturing },
  ];
  if (!on) {
    return (
      <Screen title="Production Register" icon="layers">
        <EmptyState icon="layers" title="Manufacturing is turned off" body="Turn on Bill of materials and manufacturing, or Job work, in Features (F11)." />
      </Screen>
    );
  }
  return (
    <ReportScreen
      title="Production Register"
      subtitle={data && rows.length > 0 ? `${rows.length} voucher${rows.length === 1 ? '' : 's'} · cost of production ₹ ${formatMoney(data.totals.productValue)}` : undefined}
      actions={actions}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter View · Alt+A Alter · Ctrl+1/2/3 Kind · Alt+F2 Period · Alt+E Export"
      filters={
        <SegmentedControl<KindFilter>
          aria-label="Kind"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'manufacturing', label: CLASS_LABEL.manufacturing },
            { value: 'material_in', label: CLASS_LABEL.material_in },
          ]}
        />
      }
      exportDef={() => (data ? productionExport(data) : { columns: [], rows: [] })}
    >
      <DataTable<ProductionRegisterRow>
        aria-label="Production Register"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.voucherId)}
        selectedKey={current ? String(current.voucherId) : null}
        onSelect={(k) => setSelected(k)}
        onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
        loading={q.loading}
        empty={<EmptyState icon="layers" title="No production in this period" body="Manufacturing Journals and finished goods received from job workers appear here. Change the period with Alt+F2." />}
      />
      <p className="bx-mfg-note">
        Values are the stock valuation engine's — the same as the Stock Summary and the Balance Sheet. A back-dated purchase re-values the components and the finished goods everywhere.
      </p>
    </ReportScreen>
  );
}

// ───────────────────────────── Pending job work ─────────────────────────────

export function PendingJobWorkScreen({ params }: ScreenProps<{ direction?: 'out' | 'in'; partyLedgerId?: number }>) {
  const { to } = usePeriod();
  const nav = useNav();
  const features = useFeatures();
  const canCreate = useCan('vouchers.create');
  const [direction, setDirection] = useState<'out' | 'in'>(params.direction ?? 'out');
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useApiQuery(
    'mfg.jobWork.pending',
    { asOf: to, direction, onlyAlerts, ...(params.partyLedgerId !== undefined ? { partyLedgerId: params.partyLedgerId } : {}) },
    { keepPrevious: true, enabled: features.jobWork },
  );
  const data = q.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const current = rows.find((r) => r.key === selected) ?? rows[0] ?? null;
  const columns = useMemo<Column<PendingJobWorkRow>[]>(
    () => [
      { key: 'sentOn', header: direction === 'out' ? 'Sent on' : 'Received on', kind: 'date', width: 105, sortable: true },
      { key: 'challanNo', header: 'Challan', width: 110, value: (r) => r.challanNo ?? '' },
      { key: 'partyName', header: direction === 'out' ? 'Job worker' : 'Principal', minWidth: 160, value: (r) => r.partyName ?? r.godownName, sortable: true },
      { key: 'itemName', header: 'Item', minWidth: 160, sortable: true },
      { key: 'goodsType', header: 'Goods', width: 120, value: (r) => goodsTypeLabel(r.goodsType) },
      { key: 'sentQty', header: 'Sent', kind: 'qty', width: 100 },
      { key: 'returnedQty', header: 'Back', kind: 'qty', width: 90, blankZero: true },
      { key: 'pendingQty', header: 'Pending', kind: 'qty', width: 110, render: (r) => `${r.pendingQty} ${r.unit}` },
      { key: 'pendingValue', header: 'Value', kind: 'amount', width: 130, total: true },
      { key: 'dueDate', header: 'Return by', kind: 'date', width: 110 },
      {
        key: 'status',
        header: 'Status',
        width: 170,
        value: (r) => returnStatusText(r.status, r.daysLeft),
        render: (r) => <Badge size="sm" tone={STATUS_TONE[r.status]}>{returnStatusText(r.status, r.daysLeft)}</Badge>,
      },
    ],
    [direction],
  );
  const footer = useMemo<FooterRow[]>(
    () => (data && rows.length > 0 ? [{ key: 'counts', tone: 'subtle', cells: { itemName: `${data.counts.overdue} overdue · ${data.counts.dueSoon} due within 30 days`, pendingValue: data.overdueValue } }] : []),
    [data, rows.length],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Goods with job workers', icon: 'truck', onClick: () => setDirection('out'), disabled: direction === 'out', group: 'view' },
    { key: 'Ctrl+2', label: "Principals' goods with us", icon: 'truck', onClick: () => setDirection('in'), disabled: direction === 'in', group: 'view' },
    { key: 'Ctrl+3', label: onlyAlerts ? 'Show all' : 'Only overdue / due soon', icon: 'filter', onClick: () => setOnlyAlerts((v) => !v), group: 'view' },
    {
      key: 'Alt+I',
      label: direction === 'out' ? 'Receive back (Material In)' : 'Send back (Material Out)',
      icon: 'download',
      onClick: () => current && nav.push('mfg.journal.entry', { cls: direction === 'out' ? 'material_in' : 'material_out', ...(current.partyLedgerId !== null ? { partyId: current.partyLedgerId } : {}) }),
      disabled: !current,
      hidden: !canCreate,
      group: 'go',
    },
  ];
  if (!features.jobWork) {
    return (
      <Screen title="Pending Job Work" icon="truck">
        <EmptyState icon="truck" title="Job work is turned off" body="Turn on Job work in Features (F11 › Inventory; it needs Multiple godowns)." />
      </Screen>
    );
  }
  return (
    <ReportScreen
      title="Pending Job Work"
      subtitle={direction === 'out' ? 'Our goods with job workers' : "Principals' goods with us"}
      periodMode="asOn"
      actions={actions}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter View challan · Alt+I Receive or send back · Ctrl+1/2 Out or in · Ctrl+3 Alerts only · Alt+F2 Date · Alt+E Export"
      filters={
        <Stack gap={2}>
          <SegmentedControl<'out' | 'in'> aria-label="Direction" size="sm" value={direction} onChange={setDirection} options={[{ value: 'out', label: 'With job workers' }, { value: 'in', label: 'Principals’ goods with us' }]} />
          <Field label="Only overdue / due soon" layout="inline">
            <Switch checked={onlyAlerts} onChange={setOnlyAlerts} />
          </Field>
        </Stack>
      }
      exportDef={() => (data ? { ...pendingJobWorkExport(data, direction), period: `As on ${formatDate(to)}` } : { columns: [], rows: [] })}
    >
      {data && data.counts.overdue > 0 && direction === 'out' ? (
        <Banner tone="danger" title={`${data.counts.overdue} challan line${data.counts.overdue === 1 ? '' : 's'} past the return date`}>
          Under CGST s.143 inputs not received back within one year (capital goods: three years) are deemed supplied by you on the day they were sent out — pay GST with interest on them, or
          record the Commissioner's extension on the challan line. Value pending: ₹ {formatMoney(data.overdueValue)}.
        </Banner>
      ) : null}
      {data && data.unexplained.length > 0 ? (
        <Banner tone="info" title="Stock at job workers without a challan">
          {data.unexplained.map((u) => `${u.itemName} ${u.qty} ${u.unit} at ${u.godownName}`).join('; ')} — usually opening stock; it has no s.143 date.
        </Banner>
      ) : null}
      <DataTable<PendingJobWorkRow>
        aria-label="Pending job work"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.key}
        selectedKey={current ? current.key : null}
        onSelect={(k) => setSelected(k)}
        onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
        footerRows={footer.length > 0 ? footer : undefined}
        loading={q.loading}
        empty={<EmptyState icon="truck" title="Nothing pending" body={direction === 'out' ? 'No goods are with job workers on this date.' : 'No principal’s goods are with you on this date.'} />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── ITC-04 ─────────────────────────────

const AATO_KEY = 'pevqori.mfg.itc04.aato';

function readAato(companyId: string | number): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(`${AATO_KEY}.${companyId}`) === '1';
  } catch {
    return false;
  }
}

function writeAato(companyId: string | number, on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`${AATO_KEY}.${companyId}`, on ? '1' : '0');
  } catch {
    // Storage unavailable: the switch resets next time.
  }
}

export function Itc04Screen() {
  const nav = useNav();
  const features = useFeatures();
  const company = useCompany();
  const { date } = useWorkingDate();
  const [aato, setAatoRaw] = useState(() => readAato(company.id));
  const setAato = (v: boolean) => {
    setAatoRaw(v);
    writeAato(company.id, v);
  };
  const [refDate, setRefDate] = useState(date);
  const periodsQ = useApiQuery('mfg.itc04.periods', { date: refDate, aatoAbove5Cr: aato }, { enabled: features.jobWork });
  const prevFyQ = useApiQuery('mfg.itc04.periods', { date: addMonths(refDate, -12), aatoAbove5Cr: aato }, { enabled: features.jobWork });
  const periods = useMemo(() => [...(prevFyQ.data ?? []), ...(periodsQ.data ?? [])], [prevFyQ.data, periodsQ.data]);
  const [key, setKey] = useState<string | null>(null);
  // Default: the latest period that has ended (the one to file), else the current one.
  useEffect(() => {
    if (periods.length === 0 || (key && periods.some((p) => p.key === key))) return;
    const ended = periods.filter((p) => p.to < date);
    setKey((ended[ended.length - 1] ?? periods[periods.length - 1]).key);
  }, [periods, key, date]);
  const period = periods.find((p) => p.key === key) ?? null;
  const [table, setTable] = useState<'4' | '5'>('4');
  const q = useApiQuery('mfg.itc04.report', { from: period?.from ?? date, to: period?.to ?? date, aatoAbove5Cr: aato }, { enabled: period !== null, keepPrevious: true });
  const data = q.data;
  const sentCols = useMemo<Column<Itc04SentRow>[]>(
    () => [
      { key: 'jobWorkerName', header: 'Job worker', minWidth: 160, value: (r) => r.jobWorkerName ?? '' },
      { key: 'jobWorkerGstin', header: 'GSTIN / state', width: 160, value: (r) => r.jobWorkerGstin ?? `State ${r.jobWorkerState ?? '—'}` },
      { key: 'challanNo', header: 'Challan', width: 110, value: (r) => r.challanNo ?? '' },
      { key: 'challanDate', header: 'Date', kind: 'date', width: 105 },
      { key: 'goodsType', header: 'Goods', width: 110, value: (r) => (r.goodsType === 'capital_goods' ? 'Capital goods' : 'Inputs') },
      { key: 'description', header: 'Description', minWidth: 150 },
      { key: 'hsn', header: 'HSN', width: 90, value: (r) => r.hsn ?? '' },
      { key: 'qty', header: 'Quantity', kind: 'qty', width: 120, render: (r) => `${r.qty} ${r.uqc}` },
      { key: 'taxableValue', header: 'Taxable value', kind: 'amount', width: 140, total: true },
      { key: 'rate', header: 'Tax rate', width: 110, value: (r) => (r.igstRate > 0 ? `IGST ${r.igstRate}%` : r.cgstRate > 0 ? `CGST+SGST ${r.cgstRate * 2}%` : 'Nil') },
    ],
    [],
  );
  const retCols = useMemo<Column<Itc04ReturnRow>[]>(
    () => [
      { key: 'table', header: 'Table', width: 70 },
      { key: 'jobWorkerName', header: 'Job worker', minWidth: 150, value: (r) => r.jobWorkerName ?? '' },
      { key: 'docNo', header: 'Challan / invoice', width: 130, value: (r) => r.docNo ?? '' },
      { key: 'docDate', header: 'Date', kind: 'date', width: 105 },
      { key: 'originalChallanNo', header: 'Original challan', width: 160, value: (r) => (r.originalChallanNo ? `${r.originalChallanNo} · ${formatDate(r.originalChallanDate)}` : '—') },
      { key: 'description', header: 'Goods sent', minWidth: 140 },
      { key: 'qty', header: 'Quantity', kind: 'qty', width: 110, render: (r) => `${r.qty} ${r.uqc}` },
      { key: 'receivedDescription', header: 'Received after processing', minWidth: 160, value: (r) => (r.receivedDescription ? `${r.receivedDescription} ${r.receivedQty ?? ''} ${r.receivedUqc ?? ''}` : '') },
      { key: 'natureOfJobWork', header: 'Nature of job work', width: 150, value: (r) => r.natureOfJobWork ?? '' },
    ],
    [],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Table 4 (sent)', icon: 'upload', onClick: () => setTable('4'), disabled: table === '4', group: 'view' },
    { key: 'Ctrl+2', label: 'Tables 5A–5C (received / sent on / sold)', icon: 'download', onClick: () => setTable('5'), disabled: table === '5', group: 'view' },
    { key: 'Ctrl+3', label: aato ? 'AATO up to ₹5 crore (annual)' : 'AATO above ₹5 crore (half-yearly)', icon: 'settings', onClick: () => setAato(!aato), group: 'view' },
    // A toggle: back a year, and back again to the working date's year (the list shows two years).
    { key: 'Ctrl+4', label: refDate === date ? 'Previous financial year' : 'Current financial year', icon: 'calendar', onClick: () => setRefDate(refDate === date ? addMonths(date, -12) : date), group: 'view' },
  ];
  if (!features.jobWork) {
    return (
      <Screen title="ITC-04" icon="gst">
        <EmptyState icon="truck" title="Job work is turned off" body="Turn on Job work in Features (F11 › Inventory; it needs Multiple godowns)." />
      </Screen>
    );
  }
  const title = period ? itc04Title(period.from, period.to) : 'ITC-04';
  return (
    <ReportScreen
      title="ITC-04"
      subtitle={period ? `${period.label} · due ${formatDate(period.dueDate)} (check the portal for extensions)` : undefined}
      periodMode="none"
      actions={actions}
      loading={q.loading || periodsQ.loading}
      refreshing={q.refreshing}
      error={q.error ?? periodsQ.error}
      onRetry={() => void (q.refetch(), periodsQ.refetch())}
      hint="Ctrl+1 Table 4 · Ctrl+2 Tables 5 · Ctrl+3 Turnover band · Ctrl+4 Previous / current year · Enter View · Alt+E Export"
      filters={
        <Stack gap={2}>
          <Field label="Period" layout="inline">
            <Select value={key ?? ''} onChange={(v) => setKey(v)} options={periods.map((p) => ({ value: p.key, label: p.label }))} />
          </Field>
          <Field label="AATO above ₹5 crore" layout="inline" hint="Previous year's aggregate turnover: half-yearly ITC-04 above ₹5 crore, annual otherwise (rule 45(3)).">
            <Switch checked={aato} onChange={setAato} />
          </Field>
          <SegmentedControl<'4' | '5'> aria-label="Table" size="sm" value={table} onChange={setTable} options={[{ value: '4', label: `Table 4 (${data?.sent.length ?? 0})` }, { value: '5', label: `Tables 5A–5C (${data?.returned.length ?? 0})` }]} />
        </Stack>
      }
      exportDef={() => {
        if (!data || !period) return { columns: [], rows: [] };
        const t = table === '4' ? itc04SentExport(data) : itc04ReturnedExport(data);
        return { ...t, title: `${title} — ${table === '4' ? 'Table 4' : 'Tables 5A-5C'}`, period: { from: period.from, to: period.to } };
      }}
    >
      {data && data.warnings.length > 0 ? (
        <Banner tone="warning" title="Check before filing">
          {data.warnings.slice(0, 5).join(' ')}
          {data.warnings.length > 5 ? ` (+${data.warnings.length - 5} more)` : ''}
        </Banner>
      ) : null}
      {table === '4' ? (
        <DataTable<Itc04SentRow>
          aria-label="ITC-04 table 4"
          autoFocus
          columns={sentCols}
          rows={data?.sent ?? []}
          getRowKey={(r) => r.key}
          onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
          loading={q.loading}
          empty={<EmptyState icon="truck" title="Nothing sent to job workers in this period" body="Material Out vouchers to a job worker's godown appear here." />}
        />
      ) : (
        <DataTable<Itc04ReturnRow>
          aria-label="ITC-04 tables 5A to 5C"
          autoFocus
          columns={retCols}
          rows={data?.returned ?? []}
          getRowKey={(r) => `${r.table}:${r.key}`}
          onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
          loading={q.loading}
          empty={<EmptyState icon="truck" title="Nothing received back in this period" body="Material In vouchers and sales from a job worker's godown appear here." />}
        />
      )}
      <p className="bx-mfg-note">
        Export gives a clean CSV / Excel of the form's columns to key into the GST portal's ITC-04 offline tool. It is not the portal's JSON upload format, which Pevqori does not generate. Table 5A pairs
        each receipt with its original challan first-in-first-out; enter losses and wastes yourself where they apply.
      </p>
    </ReportScreen>
  );
}
